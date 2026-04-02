/**
 * WorkerManagerImpl — concrete implementation of the WorkerManager interface.
 *
 * Wraps ProcessSupervisor, CompletionJudge, ResourceLimiter into the
 * unified ACP interface. PM operations are delegated to SPSEventHandler
 * via the event system (Phase 3 refactor).
 *
 * Phase 4: recover() fully implemented with decision matrix from doc-09 §11.3.
 */
import { execFileSync } from 'node:child_process';
import { readState, writeState, createIdleWorkerSlot } from '../core/state.js';
import type { RuntimeState, TaskLease, WorktreeEvidence } from '../core/state.js';
import type { ProcessSupervisor } from './supervisor.js';
import type { CompletionJudge, CompletionResult } from './completion-judge.js';
import type { ResourceLimiter } from './resource-limiter.js';
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';
import { IntegrationQueue } from './integration-queue.js';
import type { QueueEntry } from './integration-queue.js';
import type {
  WorkerManager, TaskRunRequest, TaskResumeRequest, TaskCancelRequest,
  TaskInputRequest, TaskConfirmRequest, InspectQuery, TaskRunResponse,
  WorkerSnapshot, WorkerEvent, WorkerEventHandler, WorkerPhase,
  RecoveryContext, RecoveryResult,
} from './worker-manager.js';

// ─── Dependencies ──────────────────────────────────────────────

export interface WorkerManagerDeps {
  supervisor: ProcessSupervisor;
  completionJudge: CompletionJudge;
  resourceLimiter: ResourceLimiter;
  agentRuntime: AgentRuntime | null;
  integrationQueue?: IntegrationQueue;
  stateFile: string;
  maxWorkers: number;
}

// ─── Shared context for run/resume spawn logic ─────────────────

interface SpawnContext {
  taskId: string; cardId: string; project: string; phase: WorkerPhase;
  prompt: string; cwd: string; branch: string; targetBranch: string;
  tool: 'claude' | 'codex'; transport: 'proc' | 'acp-sdk';
  outputFile: string; maxRetries: number; resumeSessionId?: string;
  customTimeoutSec?: number;
  completionStrategy?: string;
}

// ─── Timeout Defaults ──────────────────────────────────────────

const DEFAULT_TIMEOUTS = {
  startupSec: 60,           // 60s for worker to start
  developmentSec: 4 * 3600, // 4h for development
  integrationSec: 3600,     // 1h for integration
  inputWaitSec: 1800,       // 30min waiting for input
  forceMultiplier: 1.5,     // Hard kill at 1.5x timeout
};

// ─── Implementation ────────────────────────────────────────────

export class WorkerManagerImpl implements WorkerManager {
  private readonly supervisor: ProcessSupervisor;
  private readonly completionJudge: CompletionJudge;
  private readonly resourceLimiter: ResourceLimiter;
  private readonly agentRuntime: AgentRuntime | null;
  private readonly stateFile: string;
  private readonly maxWorkers: number;
  private readonly integrationQueue: IntegrationQueue;
  private readonly eventHandlers: WorkerEventHandler[] = [];
  private readonly taskSlotMap = new Map<string, string>();
  private readonly timeouts = new Map<string, NodeJS.Timeout>();
  /** Abort controllers for ACP completion monitors keyed by slot name. */
  private readonly acpMonitorAborts = new Map<string, AbortController>();

  constructor(deps: WorkerManagerDeps) {
    this.supervisor = deps.supervisor;
    this.completionJudge = deps.completionJudge;
    this.resourceLimiter = deps.resourceLimiter;
    this.agentRuntime = deps.agentRuntime;
    this.stateFile = deps.stateFile;
    this.maxWorkers = deps.maxWorkers;
    this.integrationQueue = deps.integrationQueue ?? new IntegrationQueue(deps.stateFile, deps.maxWorkers);
  }

  // ─── run / resume ────────────────────────────────────────────

  async run(request: TaskRunRequest): Promise<TaskRunResponse> {
    return this.acquireAndSpawn({
      taskId: request.taskId, cardId: request.cardId, project: request.project,
      phase: request.phase, prompt: request.prompt, cwd: request.cwd,
      branch: request.branch, targetBranch: request.targetBranch,
      tool: request.tool, transport: request.transport,
      outputFile: request.outputFile, maxRetries: request.maxRetries ?? 0,
      customTimeoutSec: request.timeoutSec,
      completionStrategy: request.completionStrategy,
    }, 'wm-run');
  }

  async resume(request: TaskResumeRequest): Promise<TaskRunResponse> {
    return this.acquireAndSpawn({
      taskId: request.taskId, cardId: request.cardId, project: request.project,
      phase: request.phase, prompt: request.prompt, cwd: request.cwd,
      branch: request.branch, targetBranch: request.targetBranch,
      tool: request.tool, transport: request.transport,
      outputFile: request.outputFile, maxRetries: 0,
      resumeSessionId: request.sessionId,
    }, 'wm-resume');
  }

  // ─── cancel ──────────────────────────────────────────────────

  async cancel(request: TaskCancelRequest): Promise<void> {
    const { taskId, project, reason } = request;

    // ── Check if the task is queued (not yet spawned) ───────────
    const queuePos = this.integrationQueue.getPosition(taskId);
    if (queuePos > 0) {
      // Task is in waiting list — remove without killing any worker
      this.integrationQueue.remove(taskId);
      this.emitEvent({
        type: 'run.failed', taskId, cardId: taskId, project,
        phase: 'integration', slot: '', workerId: '',
        timestamp: new Date().toISOString(), state: 'failed',
        error: `Cancelled from queue (position=${queuePos}): ${reason}`,
      });
      this.log(`Removed queued task ${taskId} from integration queue (reason=${reason})`);
      return;
    }

    const slot = this.taskSlotMap.get(taskId);
    if (!slot) { this.log(`Cancel: task ${taskId} not found`); return; }

    // Determine phase from lease to know if we need to advance queue
    const lease = this.rd().leases[taskId];
    const isIntegration = lease
      ? (lease.pmStateObserved === 'QA' || lease.phase === 'merging' || lease.phase === 'resolving_conflict')
      : queuePos === 0;

    this.clearTimeoutForTask(taskId);
    const workerId = `${project}:${slot}:${taskId}`;
    await this.supervisor.kill(workerId);
    this.releaseSlotInState(slot, taskId);
    this.resourceLimiter.release();
    this.taskSlotMap.delete(taskId);

    this.emitEvent({
      type: 'run.failed', taskId, cardId: taskId, project,
      phase: isIntegration ? 'integration' : 'development', slot, workerId,
      timestamp: new Date().toISOString(), state: 'failed',
      error: `Cancelled: ${reason}`,
    });
    this.log(`Cancelled worker ${workerId} (reason=${reason})`);

    // ── If active integration worker was cancelled, advance queue ─
    if (isIntegration) {
      const targetBranch = lease?.branch ?? 'main';
      // Find the actual targetBranch from the queue active entry
      const state = this.rd();
      let actualTarget = targetBranch;
      for (const [key, q] of Object.entries(state.integrationQueues)) {
        if (q.active?.taskId === taskId) {
          actualTarget = key.split(':').slice(1).join(':');
          break;
        }
      }
      await this.advanceIntegrationQueue(project, actualTarget);
    }
  }

  // ─── inspect ─────────────────────────────────────────────────

  inspect(query: InspectQuery): WorkerSnapshot[] {
    const state = this.rd();
    const snapshots: WorkerSnapshot[] = [];
    for (const [slotName, worker] of Object.entries(state.workers)) {
      if (query.slot && query.slot !== slotName) continue;
      if (query.taskId && worker.seq !== null && String(worker.seq) !== query.taskId) continue;

      const seq = worker.seq !== null ? String(worker.seq) : null;
      const activeCard = seq ? state.activeCards[seq] ?? null : null;
      const lease = seq ? state.leases[seq] ?? null : null;

      snapshots.push({
        slot: slotName, taskId: seq,
        cardId: activeCard ? String(activeCard.seq) : seq,
        project: query.project ?? '',
        state: this.mapWorkerState(worker),
        phase: lease ? (lease.phase === 'merging' || lease.phase === 'resolving_conflict' ? 'integration' : 'development') : null,
        pid: worker.pid ?? null, sessionId: worker.sessionId ?? null,
        cwd: worker.worktree, branch: worker.branch,
        startedAt: worker.claimedAt,
        updatedAt: worker.lastHeartbeat ?? worker.claimedAt ?? new Date().toISOString(),
        outputTail: null, pendingInput: null,
      });
    }
    return snapshots;
  }

  onEvent(handler: WorkerEventHandler): void { this.eventHandlers.push(handler); }

  // ─── sendInput / confirm ─────────────────────────────────────

  async sendInput(request: TaskInputRequest): Promise<void> {
    const slot = this.requireAgentSlot(request.taskId, 'sendInput');
    await this.agentRuntime!.resumeRun(slot, request.input);
    this.log(`Sent input to task ${request.taskId} in ${slot}`);
  }

  async confirm(request: TaskConfirmRequest): Promise<void> {
    const slot = this.requireAgentSlot(request.taskId, 'confirm');
    const input = request.action === 'confirm' ? (request.message ?? 'yes') : (request.message ?? 'no');
    await this.agentRuntime!.resumeRun(slot, input);
    this.log(`Confirmed (${request.action}) task ${request.taskId} in ${slot}`);
  }

  // ─── recover (Phase 4 — full decision matrix from doc-09 §11.3) ──

  async recover(contexts: RecoveryContext[]): Promise<RecoveryResult> {
    const result: RecoveryResult = {
      scanned: 0, alive: 0, completed: 0, failed: 0,
      released: 0, rebuilt: 0, queueRebuilt: 0, events: [],
    };

    // Phase 1+2: Scan leases and apply per-task decision matrix
    for (const ctx of contexts) {
      const state = readState(ctx.stateFile, this.maxWorkers);
      const processedSeqs = new Set<string>();

      for (const [seq, lease] of Object.entries(state.leases)) {
        if (lease.phase === 'released' || lease.phase === 'suspended') continue;
        result.scanned++;
        processedSeqs.add(seq);

        const slot = lease.slot;
        const worker = slot ? state.workers[slot] ?? null : null;
        const pid = worker?.pid ?? null;
        const isAlive = pid ? this.isPidAlive(pid) : false;
        const evidence: WorktreeEvidence | null = state.worktreeEvidence[seq] ?? null;
        const pmState = lease.pmStateObserved;

        // R8/R9: PM manually completed or reverted — release immediately
        if (pmState === 'Done' || pmState === 'Backlog' || pmState === 'Todo') {
          if (slot) this.releaseSlotInState(slot, seq);
          result.released++;
          this.log(`Recovery R8/R9: task ${seq} PM state=${pmState}, released`);
          continue;
        }

        // R1: Worker still running — re-attach orphan PID monitoring
        if (isAlive && pid && slot) {
          this.recoverAliveWorker(ctx, seq, lease, slot, pid);
          result.alive++;
          continue;
        }

        // Dead worker — check git evidence for decision
        const event = this.judgeDeadWorker(ctx, seq, lease, slot, evidence);
        if (event) {
          result.events.push(event);
          if (event.type === 'run.completed') result.completed++;
          else result.failed++;
        } else {
          // Released (R7: worktree missing or fallback)
          result.released++;
        }
      }

      // Phase 3: Rebuild integration queues — skip tasks already handled above
      this.rebuildIntegrationQueue(ctx, state, result, processedSeqs);
    }

    // Phase 4: Emit collected events so SPSEventHandler processes them
    for (const event of result.events) {
      this.emitEvent(event);
    }

    if (result.scanned > 0) {
      this.log(
        `Recovery complete: scanned=${result.scanned} alive=${result.alive} ` +
        `completed=${result.completed} failed=${result.failed} ` +
        `released=${result.released} rebuilt=${result.rebuilt} queueRebuilt=${result.queueRebuilt}`,
      );
    }

    return result;
  }

  // ─── Private: Unified acquire + spawn flow ───────────────────

  private async acquireAndSpawn(ctx: SpawnContext, label: string): Promise<TaskRunResponse> {
    const { taskId, cardId, project, phase, prompt, cwd, branch, targetBranch,
            tool, transport, outputFile, maxRetries, resumeSessionId } = ctx;

    if (this.taskSlotMap.has(taskId)) {
      this.log(`Duplicate task ${taskId}, already in slot ${this.taskSlotMap.get(taskId)}`);
      return this.reject('duplicate_task');
    }

    // ── Integration queue gate ──────────────────────────────────
    if (phase === 'integration') {
      const entry: QueueEntry = {
        taskId, cardId, project, prompt, cwd, branch, targetBranch,
        tool, transport, outputFile, enqueuedAt: new Date().toISOString(),
      };
      const active = this.integrationQueue.getActive(project, targetBranch);
      if (active) {
        const { position } = this.integrationQueue.enqueue(entry);
        this.log(`Integration task ${taskId} queued at position ${position} (active=${active.taskId})`);
        return { accepted: true, queued: true, queuePosition: position, slot: null, workerId: null };
      }
      // No active — register as active before spawning
      this.integrationQueue.enqueue(entry);
    }

    const acquireResult = this.resourceLimiter.tryAcquireDetailed();
    if (!acquireResult.acquired) {
      const reason = this.resourceLimiter.formatBlockReason(acquireResult.stats);
      this.log(`Resource exhausted for task ${taskId}: ${reason}`);
      // If we just registered as active in the queue, roll back
      if (phase === 'integration') {
        this.integrationQueue.dequeueNext(project, targetBranch);
      }
      return this.reject('resource_exhausted');
    }

    const state = this.rd();
    const slot = this.findIdleSlot(state);
    if (!slot) {
      this.resourceLimiter.release();
      if (phase === 'integration') {
        this.integrationQueue.dequeueNext(project, targetBranch);
      }
      this.log(`No idle slot for task ${taskId}`);
      return this.reject('resource_exhausted');
    }

    await this.resourceLimiter.enforceStagger();

    const nowIso = new Date().toISOString();
    this.claimSlot(state, slot, { seq: taskId, cardId, project, phase, branch, cwd, tool, transport, outputFile, nowIso, targetBranch });
    this.wr(state, label);
    this.taskSlotMap.set(taskId, slot);

    const workerId = `${project}:${slot}:${taskId}`;
    let pid: number | null = null;
    let sessionId: string | undefined;
    let resourceAcquired = true; // track whether resource was released by spawn-fail path

    try {
      if (transport === 'proc') {
        const handle = this.supervisor.spawn({
          id: workerId, project, seq: taskId, slot, worktree: cwd, branch,
          prompt, outputFile, tool, resumeSessionId,
          onExit: (exitCode) => this.handleExit({
            workerId, taskId, cardId, project, phase, slot, branch, cwd,
            targetBranch, outputFile, tool, transport, exitCode, maxRetries,
            completionStrategy: ctx.completionStrategy,
          }),
        });
        pid = handle.pid;
        sessionId = handle.sessionId ?? undefined;
      } else if (transport === 'acp-sdk') {
        if (!this.agentRuntime) {
          throw new Error(`${transport} transport requires agentRuntime`);
        }
        const session = resumeSessionId
          ? await this.agentRuntime.resumeRun(slot, prompt)
          : await this.agentRuntime.startRun(slot, prompt, tool, cwd);
        sessionId = session.sessionId;
        pid = session.pid ?? null;

        // ACP completion monitor — polls inspectRun until terminal state
        this.monitorAcpCompletion({
          workerId, taskId, cardId, project, phase, slot, branch, cwd,
          targetBranch, outputFile, tool, transport, maxRetries,
          sessionName: session.sessionName,
          completionStrategy: ctx.completionStrategy,
        });
      }
    } catch (err) {
      this.log(`Spawn failed for ${taskId}: ${err instanceof Error ? err.message : String(err)}`);
      if (resourceAcquired) {
        this.resourceLimiter.release();
        resourceAcquired = false;
      }
      this.releaseSlotInState(slot, taskId);
      this.taskSlotMap.delete(taskId);
      if (phase === 'integration') {
        this.integrationQueue.remove(taskId);
        await this.advanceIntegrationQueue(project, targetBranch);
      }
      this.emitEvent({
        type: 'run.failed', taskId, cardId, project, phase, slot, workerId,
        timestamp: new Date().toISOString(), state: 'failed',
        error: `Spawn failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      return this.reject('spawn_failed');
    }

    // Update state with pid/sessionId obtained after spawn
    const postState = this.rd();
    if (postState.workers[slot]) {
      postState.workers[slot].pid = pid;
      postState.workers[slot].sessionId = sessionId ?? null;
      this.wr(postState, `${label}-pid`);
    }

    this.log(`Launched ${transport}/${tool} worker ${workerId} in ${slot} (pid=${pid})`);
    this.startTimeout(taskId, phase, project, slot, ctx.customTimeoutSec);
    return { accepted: true, slot, workerId, pid: pid ?? undefined, sessionId };
  }

  // ─── Private: Exit Handler ───────────────────────────────────

  private async handleExit(ctx: {
    workerId: string; taskId: string; cardId: string; project: string;
    phase: WorkerPhase; slot: string; branch: string; cwd: string;
    targetBranch: string; outputFile: string; tool: 'claude' | 'codex';
    transport: 'proc' | 'acp-sdk'; exitCode: number; maxRetries: number;
    completionStrategy?: string;
  }): Promise<void> {
    const { workerId, taskId, cardId, project, phase, slot, branch, cwd,
            targetBranch, outputFile, tool, transport, exitCode, maxRetries } = ctx;
    this.clearTimeoutForTask(taskId);
    this.log(`Worker ${workerId} exited with code ${exitCode}`);

    const completion = this.completionJudge.judge({
      worktree: cwd, branch, baseBranch: targetBranch, outputFile, exitCode, phase,
      completionStrategy: ctx.completionStrategy,
    });
    this.log(`CompletionJudge for ${workerId}: ${completion.status} (${completion.reason})`);

    const isComplete = completion.status === 'completed';

    // Emit event — SPSEventHandler handles PM operations, slot release, notifications
    this.emitEvent({
      type: isComplete ? 'run.completed' : 'run.failed',
      taskId, cardId, project, phase, slot, workerId,
      timestamp: new Date().toISOString(),
      state: isComplete ? 'completed' : 'failed',
      exitCode, completionResult: completion,
    });

    // Release supervisor handle and resource limiter slot
    this.supervisor.remove(workerId);
    this.resourceLimiter.release();
    this.taskSlotMap.delete(taskId);

    // Safety net: if no event handlers are registered, release the slot
    // in state.json directly. Normally SPSEventHandler does this via the
    // event system, but if it's missing the slot would leak forever.
    if (this.eventHandlers.length === 0) {
      this.releaseSlotInState(slot, taskId);
      this.log(`Safety net: released slot ${slot} for task ${taskId} (no event handlers)`);
    }

    // ── Auto-dequeue next integration task ──────────────────────
    if (phase === 'integration') {
      await this.advanceIntegrationQueue(project, targetBranch);
    }
  }

  // ─── Private: ACP Completion Monitor ───────────────────────────
  /**
   * Poll ACP session until run reaches terminal state, then emit event.
   *
   * ACP protocol provides authoritative completion status:
   *   - completed → trust directly, emit run.completed (skip CompletionJudge)
   *   - failed/cancelled → trust directly, emit run.failed
   *   - lost (process died) → fall back to CompletionJudge (check git evidence)
   *   - timeout → fall back to CompletionJudge
   *
   * This avoids the old pattern of converting everything to exitCode and
   * letting CompletionJudge guess from git artifacts.
   */
  private monitorAcpCompletion(ctx: {
    workerId: string; taskId: string; cardId: string; project: string;
    phase: WorkerPhase; slot: string; branch: string; cwd: string;
    targetBranch: string; outputFile: string; tool: 'claude' | 'codex';
    transport: 'proc' | 'acp-sdk'; maxRetries: number;
    sessionName: string; completionStrategy?: string;
  }): void {
    if (!this.agentRuntime) return;
    const runtime = this.agentRuntime;
    const pollIntervalMs = 10_000; // 10s

    // Abort any previous monitor for this slot (prevents ghost polls
    // from a prior phase, e.g. development monitor still running when
    // integration starts on the same slot).
    this.acpMonitorAborts.get(ctx.slot)?.abort();
    const abortController = new AbortController();
    this.acpMonitorAborts.set(ctx.slot, abortController);

    const maxPollMs = 30 * 60 * 1000; // 30 minutes max poll duration
    const startedAt = Date.now();
    let pendingTimeout: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      if (abortController.signal.aborted) {
        this.log(`ACP monitor: ${ctx.taskId} aborted (slot ${ctx.slot} reused)`);
        return;
      }

      // Max poll duration guard — process may be hung, fall back to git evidence
      if (Date.now() - startedAt > maxPollMs) {
        this.log(`ACP monitor: ${ctx.taskId} exceeded max poll duration (${maxPollMs / 60000}min) — falling back to CompletionJudge`);
        this.acpMonitorAborts.delete(ctx.slot);
        await this.handleExit({ ...ctx, exitCode: 1 });
        return;
      }

      try {
        const state = await runtime.inspect(ctx.slot.replace(/^worker-/, ''));
        if (abortController.signal.aborted) return;

        const session = Object.values(state.sessions).find(s => s.sessionName === ctx.sessionName);
        if (!session) {
          // Process died — session gone. Fall back to CompletionJudge
          // which checks git evidence (worker may have pushed before dying).
          this.log(`ACP monitor: ${ctx.taskId} session lost — falling back to CompletionJudge`);
          this.acpMonitorAborts.delete(ctx.slot);
          await this.handleExit({ ...ctx, exitCode: 1 });
          return;
        }

        const runStatus = session.currentRun?.status;

        if (runStatus === 'completed') {
          // ── ACP says completed — trust it directly ──
          this.log(`ACP monitor: ${ctx.taskId} completed (authoritative)`);
          this.clearAcpSessionRun(ctx.sessionName);
          this.acpMonitorAborts.delete(ctx.slot);
          this.finalizeAcpWorker(ctx, 'run.completed', 0, { status: 'completed', reason: 'acp_completed' });
          return;
        }

        if (runStatus === 'failed' || runStatus === 'cancelled') {
          // ── ACP says explicitly failed/cancelled — trust it directly ──
          this.log(`ACP monitor: ${ctx.taskId} ${runStatus} (authoritative)`);
          this.clearAcpSessionRun(ctx.sessionName);
          this.acpMonitorAborts.delete(ctx.slot);
          this.finalizeAcpWorker(ctx, 'run.failed', 1, { status: 'failed', reason: `acp_${runStatus}` });
          return;
        }

        if (runStatus === 'lost') {
          // ── Process died mid-run — fall back to CompletionJudge ──
          this.log(`ACP monitor: ${ctx.taskId} lost — falling back to CompletionJudge`);
          this.clearAcpSessionRun(ctx.sessionName);
          this.acpMonitorAborts.delete(ctx.slot);
          await this.handleExit({ ...ctx, exitCode: 1 });
          return;
        }

        // Still running — poll again (store timeout ID for cleanup)
        pendingTimeout = setTimeout(poll, pollIntervalMs);
      } catch (err) {
        if (abortController.signal.aborted) return;
        this.log(`ACP monitor error for ${ctx.taskId}: ${err instanceof Error ? err.message : String(err)}`);
        pendingTimeout = setTimeout(poll, pollIntervalMs);
      }
    };

    // Clean up pending setTimeout when abort fires
    abortController.signal.addEventListener('abort', () => {
      if (pendingTimeout) clearTimeout(pendingTimeout);
    }, { once: true });

    // Start first poll after a short delay (let the run initialize)
    pendingTimeout = setTimeout(poll, pollIntervalMs);
  }

  /**
   * Finalize an ACP worker with a known status — emit event and release resources.
   * Bypasses CompletionJudge since ACP protocol provides authoritative status.
   */
  private finalizeAcpWorker(
    ctx: {
      workerId: string; taskId: string; cardId: string; project: string;
      phase: WorkerPhase; slot: string; targetBranch: string;
    },
    eventType: 'run.completed' | 'run.failed',
    exitCode: number,
    completionResult: CompletionResult,
  ): void {
    this.clearTimeoutForTask(ctx.taskId);
    this.log(`ACP finalize ${ctx.workerId}: ${completionResult.status} (${completionResult.reason})`);

    this.emitEvent({
      type: eventType,
      taskId: ctx.taskId, cardId: ctx.cardId, project: ctx.project,
      phase: ctx.phase, slot: ctx.slot, workerId: ctx.workerId,
      timestamp: new Date().toISOString(),
      state: eventType === 'run.completed' ? 'completed' : 'failed',
      exitCode, completionResult,
    });

    // Release resources (same as handleExit tail)
    this.supervisor.remove(ctx.workerId);
    this.resourceLimiter.release();
    this.taskSlotMap.delete(ctx.taskId);

    if (this.eventHandlers.length === 0) {
      this.releaseSlotInState(ctx.slot, ctx.taskId);
      this.log(`Safety net: released slot ${ctx.slot} for task ${ctx.taskId} (no event handlers)`);
    }

    if (ctx.phase === 'integration') {
      this.advanceIntegrationQueue(ctx.project, ctx.targetBranch).catch(err => {
        this.log(`Failed to advance integration queue: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
  }

  /** Clear currentRun in session state so the slot can be reused for next task. */
  private clearAcpSessionRun(sessionName: string): void {
    try {
      const state = readState(this.stateFile, this.maxWorkers);
      for (const session of Object.values(state.sessions ?? {})) {
        if (session.sessionName === sessionName && session.currentRun) {
          session.currentRun = null;
          session.status = 'idle';
        }
      }
      this.wr(state, 'acp-clear-run');
    } catch (err) {
      this.log(`Failed to clear ACP session run: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Try to spawn the next queued integration task.
   * On spawn failure, skip and try the next entry — never deadlock.
   */
  private async advanceIntegrationQueue(project: string, targetBranch: string): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const next = this.integrationQueue.dequeueNext(project, targetBranch);
      if (!next) {
        this.log(`Integration queue empty for ${project}:${targetBranch}`);
        return;
      }
      this.log(`Auto-dequeuing integration task ${next.taskId} for ${project}:${targetBranch}`);
      // Skip entries with empty prompt (recovery stubs — SPS must re-prepare)
      if (!next.prompt) {
        this.log(`Skipping ${next.taskId}: empty prompt (needs SPS re-preparation)`);
        this.emitEvent({
          type: 'run.failed', taskId: next.taskId, cardId: next.cardId, project,
          phase: 'integration', slot: '', workerId: '',
          timestamp: new Date().toISOString(), state: 'failed',
          error: 'Empty prompt — needs SPS re-preparation after recovery',
        });
        continue;
      }
      try {
        const resp = await this.acquireAndSpawn({
          taskId: next.taskId, cardId: next.cardId, project,
          phase: 'integration', prompt: next.prompt, cwd: next.cwd,
          branch: next.branch, targetBranch: next.targetBranch,
          tool: next.tool, transport: next.transport,
          outputFile: next.outputFile, maxRetries: 0,
        }, 'wm-iq-dequeue');
        if (resp.accepted && !resp.queued) {
          this.log(`Integration task ${next.taskId} spawned after dequeue`);
          return;
        }
        // If accepted but re-queued, something odd — keep going
        this.log(`Integration task ${next.taskId} could not spawn (accepted=${resp.accepted}), trying next`);
      } catch (err) {
        this.log(`Failed to spawn dequeued task ${next.taskId}: ${err instanceof Error ? err.message : String(err)}`);
        // Emit failure event so SPS knows this task was dropped
        this.emitEvent({
          type: 'run.failed', taskId: next.taskId, cardId: next.cardId, project,
          phase: 'integration', slot: '', workerId: '',
          timestamp: new Date().toISOString(), state: 'failed',
          error: `Dequeue spawn failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        // Continue to next entry — never deadlock
      }
    }
  }

  // ─── Private: Recovery Helpers ────────────────────────────────

  /**
   * R1: Worker PID is still alive — re-attach orphan monitoring.
   */
  private recoverAliveWorker(
    ctx: RecoveryContext, seq: string, lease: TaskLease, slot: string, pid: number,
  ): void {
    const workerId = `${ctx.project}:${slot}:${seq}`;
    const phase: WorkerPhase = (lease.phase === 'merging' || lease.phase === 'resolving_conflict')
      ? 'integration' : 'development';

    this.resourceLimiter.tryAcquire();
    this.supervisor.monitorOrphanPid(
      workerId, pid,
      {
        id: workerId, transport: 'proc', pid,
        outputFile: null, project: ctx.project, seq, slot,
        branch: lease.branch ?? '', worktree: lease.worktree ?? '',
        tool: 'claude', exitCode: null, sessionId: lease.sessionId ?? null,
        runId: lease.runId ?? null, sessionState: null, remoteStatus: null,
        lastEventAt: null,
        startedAt: lease.claimedAt ?? new Date().toISOString(),
        exitedAt: null,
      },
      (exitCode) => this.handleExit({
        workerId, taskId: seq, cardId: seq, project: ctx.project,
        phase, slot, branch: lease.branch ?? '',
        cwd: lease.worktree ?? '', targetBranch: ctx.baseBranch,
        outputFile: '', tool: 'claude', transport: 'proc',
        exitCode, maxRetries: 0,
      }),
    );
    this.taskSlotMap.set(seq, slot);
    this.log(`Recovery R1: task ${seq} alive (pid=${pid}), re-attached monitor`);
  }

  /**
   * Decision matrix for dead workers (R2-R7).
   * Returns a WorkerEvent for completed/failed, or null if slot was released.
   */
  private judgeDeadWorker(
    ctx: RecoveryContext, seq: string, lease: TaskLease,
    slot: string | null, evidence: WorktreeEvidence | null,
  ): WorkerEvent | null {
    const phase: WorkerPhase = (lease.phase === 'merging' || lease.phase === 'resolving_conflict')
      ? 'integration' : 'development';
    const workerId = `${ctx.project}:${slot ?? 'unknown'}:${seq}`;

    // R2: Branch merged into base — task complete
    if (evidence?.mergedToBase) {
      this.log(`Recovery R2: task ${seq} branch merged to base`);
      return this.makeRecoveryEvent('run.completed', seq, ctx, slot ?? '', phase, workerId, 'already_merged');
    }

    // R3: Pushed with commits ahead — development complete
    if (evidence?.pushed && evidence.aheadOfBase > 0) {
      this.log(`Recovery R3: task ${seq} pushed with ${evidence.aheadOfBase} commits ahead`);
      return this.makeRecoveryEvent('run.completed', seq, ctx, slot ?? '', phase, workerId, 'branch_pushed');
    }

    // R4: Local commits unpushed — rescue push, then fail for restart
    if (!evidence?.pushed && evidence && evidence.aheadOfBase > 0) {
      if (lease.worktree && lease.branch) {
        const rescued = this.rescuePush(lease.worktree, lease.branch);
        if (rescued) this.log(`Recovery R4: rescued push for task ${seq}`);
      }
      return this.makeRecoveryEvent('run.failed', seq, ctx, slot ?? '', phase, workerId, 'needs_restart');
    }

    // R5: Dirty state (rebase/merge/conflict) — rescue push, then fail
    if (evidence && ['rebase', 'merge', 'conflict'].includes(evidence.gitStatus)) {
      if (lease.worktree && lease.branch) {
        const rescued = this.rescuePush(lease.worktree, lease.branch);
        if (rescued) this.log(`Recovery R5: rescued push for task ${seq} (dirty=${evidence.gitStatus})`);
      }
      return this.makeRecoveryEvent('run.failed', seq, ctx, slot ?? '', phase, workerId, 'needs_restart');
    }

    // R7: Worktree missing — release slot, SPS re-prepares
    if (evidence && !evidence.worktreeExists) {
      if (slot) this.releaseSlotInState(slot, seq);
      this.log(`Recovery R7: task ${seq} worktree missing, released`);
      return null;
    }

    // R6: No changes (fallback) — failed with no artifacts
    this.log(`Recovery R6: task ${seq} no artifacts found`);
    return this.makeRecoveryEvent('run.failed', seq, ctx, slot ?? '', phase, workerId, 'no_artifacts');
  }

  /**
   * Rebuild integration queue from leases in merging/resolving_conflict phase.
   */
  private rebuildIntegrationQueue(
    ctx: RecoveryContext, state: RuntimeState, result: RecoveryResult,
    processedSeqs: Set<string>,
  ): void {
    const qaLeases = Object.entries(state.leases)
      .filter(([seq, l]) =>
        (l.phase === 'merging' || l.phase === 'resolving_conflict') &&
        !processedSeqs.has(seq),
      )
      .sort(([, a], [, b]) => (a.lastTransitionAt ?? '').localeCompare(b.lastTransitionAt ?? ''));

    for (const [seq, lease] of qaLeases) {
      this.integrationQueue.enqueue({
        taskId: seq, cardId: seq, project: ctx.project,
        prompt: '', // Prompt will be regenerated by SPS
        cwd: lease.worktree ?? '', branch: lease.branch ?? '',
        targetBranch: ctx.baseBranch, tool: 'claude', transport: 'proc',
        outputFile: '', enqueuedAt: lease.lastTransitionAt,
      });
      result.queueRebuilt++;
    }
    if (qaLeases.length > 0) {
      this.log(`Recovery: rebuilt ${qaLeases.length} integration queue entries for ${ctx.project}`);
    }
  }

  /**
   * Create a WorkerEvent for recovery results.
   */
  private makeRecoveryEvent(
    type: 'run.completed' | 'run.failed', seq: string, ctx: RecoveryContext,
    slot: string, phase: WorkerPhase, workerId: string, reason: string,
  ): WorkerEvent {
    return {
      type, taskId: seq, cardId: seq, project: ctx.project,
      phase, slot, workerId,
      timestamp: new Date().toISOString(),
      state: type === 'run.completed' ? 'completed' : 'failed',
      completionResult: {
        status: type === 'run.completed' ? 'completed' : 'failed',
        reason,
      },
    };
  }

  /**
   * Try to push unpushed commits from a worktree as a rescue operation.
   */
  private rescuePush(worktree: string, branch: string): boolean {
    try {
      execFileSync('git', ['-C', worktree, 'push', 'origin', branch], {
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return true;
    } catch {
      this.log(`Rescue push failed for ${branch} in ${worktree}`);
      return false;
    }
  }

  /**
   * Check if a process is still alive by sending signal 0.
   */
  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  // ─── Private: State Helpers ──────────────────────────────────

  private rd(): RuntimeState { return readState(this.stateFile, this.maxWorkers); }
  private wr(state: RuntimeState, by: string): void { writeState(this.stateFile, state, by); }

  private findIdleSlot(state: RuntimeState): string | null {
    return Object.entries(state.workers).find(([, w]) => w.status === 'idle')?.[0] ?? null;
  }

  private claimSlot(state: RuntimeState, slot: string, ctx: {
    seq: string; cardId: string; project: string; phase: WorkerPhase;
    branch: string; cwd: string; tool: 'claude' | 'codex'; transport: 'proc' | 'acp-sdk';
    outputFile: string; nowIso: string; targetBranch: string;
  }): void {
    const seqNum = parseInt(ctx.seq, 10) || 0;
    state.workers[slot] = {
      ...createIdleWorkerSlot(), status: 'active', seq: seqNum,
      branch: ctx.branch, worktree: ctx.cwd, claimedAt: ctx.nowIso, lastHeartbeat: ctx.nowIso,
      mode: ctx.transport === 'acp-sdk' ? 'acp-sdk' : 'print', transport: ctx.transport, agent: ctx.tool,
      outputFile: ctx.transport === 'proc' ? ctx.outputFile : null,
    };
    state.activeCards[ctx.seq] = {
      seq: seqNum, state: 'Inprogress', worker: slot, mrUrl: null,
      conflictDomains: [], startedAt: ctx.nowIso, retryCount: 0,
    };
    state.leases[ctx.seq] = {
      seq: seqNum, pmStateObserved: ctx.phase === 'integration' ? 'QA' : 'Inprogress',
      phase: 'coding', slot, branch: ctx.branch, worktree: ctx.cwd,
      sessionId: null, runId: null, claimedAt: ctx.nowIso, retryCount: 0,
      lastTransitionAt: ctx.nowIso,
    };
  }

  private releaseSlotInState(slot: string, taskId: string): void {
    const state = this.rd();
    state.workers[slot] = createIdleWorkerSlot();
    delete state.activeCards[taskId];
    delete state.leases[taskId];
    this.wr(state, 'wm-release');
  }

  private mapWorkerState(w: RuntimeState['workers'][string]): WorkerSnapshot['state'] {
    if (w.status === 'idle') return 'idle';
    if (w.status === 'active') {
      if (w.remoteStatus === 'waiting_input') return 'waiting_input';
      if (w.remoteStatus === 'needs_confirmation' || w.sessionState === 'needs_confirmation') return 'needs_confirmation';
      if (w.remoteStatus === 'completed') return 'completed';
      if (w.remoteStatus === 'failed') return 'failed';
      return 'running';
    }
    if (w.status === 'releasing') return 'completed';
    return 'running';
  }

  private requireAgentSlot(taskId: string, op: string): string {
    const slot = this.taskSlotMap.get(taskId);
    if (!slot) throw new Error(`Task ${taskId} not found`);
    if (!this.agentRuntime) throw new Error(`${op} requires agentRuntime (not available)`);
    const state = this.rd();
    const w = state.workers[slot];
    if (!w || (w.transport !== 'acp-sdk' && w.mode !== 'acp-sdk' && w.mode !== 'acp')) {
      throw new Error(`${op} unsupported for transport=${w?.transport ?? 'unknown'}`);
    }
    return slot;
  }

  // ─── Private: Timeout Management ─────────────────────────────

  private startTimeout(taskId: string, phase: WorkerPhase, project: string, slot: string, customTimeoutSec?: number): void {
    const baseSec = customTimeoutSec ?? (phase === 'integration' ? DEFAULT_TIMEOUTS.integrationSec : DEFAULT_TIMEOUTS.developmentSec);
    const hardSec = Math.ceil(baseSec * DEFAULT_TIMEOUTS.forceMultiplier);
    const workerId = `${project}:${slot}:${taskId}`;

    const softTimer = setTimeout(() => {
      this.emitEvent({
        type: 'status.update', taskId, cardId: taskId, project, phase, slot,
        workerId, timestamp: new Date().toISOString(), state: 'running',
        error: `Timeout: exceeded ${baseSec}s`,
      });
      this.log(`Soft timeout for ${taskId} after ${baseSec}s`);

      // Hard timeout — force kill (wrapped in try-catch to prevent unhandled rejection)
      const hardTimer = setTimeout(async () => {
        try {
          this.log(`Hard timeout for ${taskId} after ${hardSec}s — force killing`);
          await this.cancel({ taskId, project, reason: 'timeout' });
        } catch (err) {
          this.log(`Hard timeout cancel failed for ${taskId}: ${err instanceof Error ? err.message : err}`);
        }
      }, (hardSec - baseSec) * 1000);
      hardTimer.unref();
      this.timeouts.set(`${taskId}:hard`, hardTimer);
    }, baseSec * 1000);
    softTimer.unref();

    this.timeouts.set(taskId, softTimer);
  }

  private clearTimeoutForTask(taskId: string): void {
    const soft = this.timeouts.get(taskId);
    const hard = this.timeouts.get(`${taskId}:hard`);
    if (soft) { clearTimeout(soft); this.timeouts.delete(taskId); }
    if (hard) { clearTimeout(hard); this.timeouts.delete(`${taskId}:hard`); }
  }

  // ─── Private: Event + Response Helpers ───────────────────────

  private emitEvent(event: WorkerEvent): void {
    for (const handler of this.eventHandlers) {
      try { handler(event); } catch (err) {
        this.log(`Event handler error: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  cleanup(): void {
    // Clear all pending timeouts (soft + hard)
    for (const [key, timer] of this.timeouts) {
      clearTimeout(timer);
    }
    this.timeouts.clear();

    // Abort all ACP monitors
    for (const [slot, controller] of this.acpMonitorAborts) {
      controller.abort();
    }
    this.acpMonitorAborts.clear();

    this.log('Cleanup: cleared all timeouts and ACP monitors');
  }

  private reject(reason: TaskRunResponse['rejectReason']): TaskRunResponse {
    return { accepted: false, slot: null, workerId: null, rejectReason: reason };
  }

  private log(msg: string): void { process.stderr.write(`[worker-manager] ${msg}\n`); }
}
