/**
 * Recovery — restores worker state when tick process restarts.
 *
 * Scans state.json for active workers, checks PID liveness,
 * and either re-attaches monitoring or triggers completion flows.
 *
 * Called once at tick startup before the main loop begins.
 */
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { RuntimeStore } from '../core/runtimeStore.js';
import { resolveGitlabProjectId } from '../core/config.js';
import { ProjectContext } from '../core/context.js';
import {
  buildResumePrompt,
  LEGACY_TASK_PROMPT_FILE,
  promptFileForPhase,
  selectWorkerPhase,
} from '../core/taskPrompts.js';
import { isProcessAlive } from '../providers/outputParser.js';
import { CompletionJudge, type JudgeInput } from './completion-judge.js';
import { PostActions, type PostActionContext } from './post-actions.js';
import { ProcessSupervisor } from './supervisor.js';
import { ResourceLimiter } from './resource-limiter.js';
import type { ProjectConfig } from '../core/config.js';
import { createAgentRuntime } from '../providers/registry.js';
import type { ACPSessionRecord, ACPRunStatus } from '../models/acp.js';
import type { RuntimeState, TaskLease, WorkerSlotState, WorktreeEvidence } from '../core/state.js';

// ─── Types ──────────────────────────────────────────────────────

export interface RecoveryResult {
  /** Total active workers found in state files */
  found: number;
  /** Workers still alive (re-attached to PID monitoring) */
  alive: number;
  /** Dead workers completed via PostActions */
  completed: number;
  /** Dead workers that failed */
  failed: number;
}

interface ProjectInfo {
  name: string;
  config: ProjectConfig;
  stateFile: string;
  logsDir: string;
}

// ─── Recovery ───────────────────────────────────────────────────

export class Recovery {
  constructor(
    private readonly supervisor: ProcessSupervisor,
    private readonly judge: CompletionJudge,
    private readonly postActionsFactory: (projectConfig: ProjectConfig) => PostActions,
    private readonly resourceLimiter: ResourceLimiter,
  ) {}

  private stateStore(project: ProjectInfo): RuntimeStore {
    return new RuntimeStore({
      paths: { stateFile: project.stateFile },
      maxWorkers: project.config.MAX_CONCURRENT_WORKERS,
    });
  }

  /**
   * Scan all projects for active workers and recover them.
   *
   * @param projects - List of project info (from tick runners)
   */
  async recover(projects: ProjectInfo[]): Promise<RecoveryResult> {
    const result: RecoveryResult = { found: 0, alive: 0, completed: 0, failed: 0 };

    for (const project of projects) {
      const state = this.stateStore(project).readState();
      const reservedSlots = new Set<string>();
      // Create per-project PostActions (C3 fix: use correct PM config per project)
      const postActions = this.postActionsFactory(project.config);
      for (const [seq, lease] of this.listRecoverableLeases(state)) {
        const slotName = this.resolveRecoverySlotName(state, seq, lease, reservedSlots);
        const slot = slotName ? state.workers[slotName] || null : null;
        const workerRef = {
          branch: lease.branch || slot?.branch || null,
          worktree: lease.worktree || slot?.worktree || null,
          outputFile: slot?.outputFile || null,
          sessionId: lease.sessionId || slot?.sessionId || null,
          mode: slot?.mode || (project.config.WORKER_TRANSPORT === 'pty' ? 'pty' : project.config.WORKER_TRANSPORT === 'acp' ? 'acp' : project.config.WORKER_MODE) || null,
          transport: slot?.transport || project.config.WORKER_TRANSPORT || null,
          agent: slot?.agent || (project.config.ACP_AGENT || project.config.WORKER_TOOL) as 'claude' | 'codex',
          pid: slot?.pid ?? null,
          exitCode: slot?.exitCode ?? null,
          sessionState: slot?.sessionState ?? null,
          remoteStatus: slot?.remoteStatus ?? null,
          lastEventAt: slot?.lastEventAt ?? null,
          claimedAt: lease.claimedAt || slot?.claimedAt || null,
          seq: lease.seq,
          pmStateObserved: lease.pmStateObserved,
        };

        result.found++;

        const isAcpTransport = workerRef.transport === 'acp' || workerRef.transport === 'pty' || workerRef.mode === 'acp' || workerRef.mode === 'pty';
        if (isAcpTransport && slotName) {
          const recovered = await this.recoverAcpSlot(project, slotName, seq, workerRef, postActions, lease);
          if (recovered === 'alive') result.alive++;
          if (recovered === 'completed') result.completed++;
          if (recovered === 'failed') result.failed++;
          continue;
        }

        if (workerRef.pid && isProcessAlive(workerRef.pid)) {
          result.alive++;
          this.resourceLimiter.tryAcquire();

          const buildOnExit = this.buildOnExitCallback(project, slotName || 'worker-1', workerRef, seq, postActions);
          const workerId = `${project.name}:${slotName || 'worker-1'}:${seq}`;
          this.supervisor.monitorOrphanPid(
            workerId,
            workerRef.pid,
            {
              id: workerId,
              transport: 'proc',
              pid: workerRef.pid,
              outputFile: workerRef.outputFile || '',
              project: project.name,
              seq,
              slot: slotName || 'worker-1',
              branch: workerRef.branch || '',
              worktree: workerRef.worktree || '',
              tool: workerRef.agent || (project.config.WORKER_TOOL || 'claude') as 'claude' | 'codex',
              exitCode: null,
              sessionId: workerRef.sessionId,
              runId: null,
              sessionState: workerRef.sessionState,
              remoteStatus: workerRef.remoteStatus,
              lastEventAt: workerRef.lastEventAt,
              startedAt: workerRef.claimedAt || new Date().toISOString(),
              exitedAt: null,
            },
            buildOnExit,
          );

          this.log(`Recovered active worker ${workerId} (pid ${workerRef.pid})`);
          continue;
        }

        const exitCode = workerRef.exitCode ?? 1;
        const completion = this.judge.judge({
          worktree: workerRef.worktree || '',
          branch: workerRef.branch || '',
          baseBranch: project.config.GITLAB_MERGE_BRANCH,
          outputFile: workerRef.outputFile,
          exitCode,
          logsDir: project.logsDir,
        });

        const ctx = this.buildPostActionContext(project, slotName || 'worker-1', seq, workerRef);

        if (completion.status === 'completed') {
          if (lease.pmStateObserved === 'QA' && completion.reason !== 'already_merged') {
            result.completed++;
          } else {
            await postActions.executeCompletion(ctx, completion, workerRef.sessionId);
            result.completed++;
          }
        } else {
          await postActions.executeFailure(
            ctx,
            completion,
            exitCode,
            workerRef.sessionId,
            lease.retryCount,
            { onExit: this.buildOnExitCallback(project, slotName || 'worker-1', workerRef, seq, postActions) },
          );
          result.failed++;
        }
      }
    }

    if (result.found > 0) {
      this.log(
        `Recovery complete: ${result.found} workers found, ` +
        `${result.alive} alive, ${result.completed} completed, ${result.failed} failed`,
      );
    }

    return result;
  }

  // ─── Helpers ────────────────────────────────────────────────

  private buildPostActionContext(
    project: ProjectInfo,
    slotName: string,
    seq: string,
    slot: {
      branch?: string | null;
      worktree?: string | null;
      transport?: 'proc' | 'acp' | 'pty' | null;
      mode?: string | null;
      agent?: 'claude' | 'codex' | null;
      pmStateObserved?: 'Planning' | 'Backlog' | 'Todo' | 'Inprogress' | 'QA' | 'Done' | null;
    },
  ): PostActionContext {
    const raw = project.config.raw;
    return {
      project: project.name,
      seq,
      slot: slotName,
      transport: slot.transport === 'pty' || slot.mode === 'pty'
        ? 'pty'
        : (slot.transport === 'acp' || slot.mode === 'acp' ? 'acp' : 'proc'),
      branch: slot.branch || '',
      worktree: slot.worktree || '',
      baseBranch: project.config.GITLAB_MERGE_BRANCH,
      stateFile: project.stateFile,
      maxWorkers: project.config.MAX_CONCURRENT_WORKERS,
      mrMode: project.config.MR_MODE,
      gitlabProjectId: resolveGitlabProjectId(project.config),
      gitlabUrl: raw.GITLAB_URL || process.env.GITLAB_URL || '',
      gitlabToken: raw.GITLAB_TOKEN || process.env.GITLAB_TOKEN || '',
      qaStateId: raw.PLANE_STATE_QA || raw.TRELLO_QA_LIST_ID || 'QA',
      doneStateId: raw.PLANE_STATE_DONE || raw.TRELLO_DONE_LIST_ID || '',
      maxRetries: project.config.WORKER_RESTART_LIMIT,
      logsDir: project.logsDir,
      tool: slot.agent || (project.config.ACP_AGENT || project.config.WORKER_TOOL) as 'claude' | 'codex',
      pmStateObserved: slot.pmStateObserved ?? null,
    };
  }

  private buildOnExitCallback(
    project: ProjectInfo,
    slotName: string,
    slot: {
      branch?: string | null;
      worktree?: string | null;
      outputFile?: string | null;
      sessionId?: string | null;
      seq?: number | null;
      pmStateObserved?: 'Planning' | 'Backlog' | 'Todo' | 'Inprogress' | 'QA' | 'Done' | null;
    },
    seq: string,
    postActions: PostActions,
  ): (exitCode: number) => Promise<void> {
    return async (exitCode: number) => {
      const judgeInput: JudgeInput = {
        worktree: slot.worktree || '',
        branch: slot.branch || '',
        baseBranch: project.config.GITLAB_MERGE_BRANCH,
        outputFile: slot.outputFile || null,
        exitCode,
        logsDir: project.logsDir,
      };
      const completion = this.judge.judge(judgeInput);
      const ctx = this.buildPostActionContext(project, slotName, seq, slot);

      const state = this.stateStore(project).readState();
      const retryCount = this.getRetryCount(state, seq);

      if (completion.status === 'completed') {
        if (slot.pmStateObserved === 'QA' && completion.reason !== 'already_merged') {
          return;
        }
        await postActions.executeCompletion(ctx, completion, slot.sessionId || null);
      } else {
        await postActions.executeFailure(
          ctx, completion, exitCode, slot.sessionId || null, retryCount,
          { onExit: this.buildOnExitCallback(project, slotName, slot, seq, postActions) },
        );
      }
    };
  }

  private log(msg: string): void {
    process.stderr.write(`[recovery] ${msg}\n`);
  }

  private async recoverAcpSlot(
    project: ProjectInfo,
    slotName: string,
    seq: string,
    slot: {
      branch?: string | null;
      worktree?: string | null;
      outputFile?: string | null;
      sessionId?: string | null;
      mode?: string | null;
      transport?: 'proc' | 'acp' | 'pty' | null;
      agent?: 'claude' | 'codex' | null;
      claimedAt?: string | null;
      seq?: number | null;
    },
    postActions: PostActions,
    lease: TaskLease,
  ): Promise<'alive' | 'completed' | 'failed'> {
    if (this.isPtyTask(project, slot)) {
      return this.recoverPtyTask(project, slotName, seq, slot, postActions, lease);
    }

    const ctx = ProjectContext.load(project.name);
    const runtime = createAgentRuntime(ctx);
    const inspected = await runtime.inspect(slotName);
    const session = inspected.sessions[slotName];
    const workerId = `${project.name}:${slotName}:${seq}`;

    if (session && session.currentRun && this.isActiveRun(session.currentRun.status)) {
      this.resourceLimiter.tryAcquire();
      this.supervisor.registerAcpHandle({
        id: workerId,
        pid: null,
        outputFile: null,
        project: project.name,
        seq,
        slot: slotName,
        branch: slot.branch || '',
        worktree: slot.worktree || '',
        tool: session.tool,
        exitCode: null,
        sessionId: session.sessionId,
        runId: session.currentRun.runId,
        sessionState: session.sessionState,
        remoteStatus: session.currentRun.status,
        lastEventAt: session.lastSeenAt,
        startedAt: (slot as { claimedAt?: string | null }).claimedAt || new Date().toISOString(),
        exitedAt: null,
      });
      this.syncAcpSlot(project, slotName, session);
      this.log(`Recovered active ACP worker ${workerId} (session ${session.sessionId}, run ${session.currentRun.runId})`);
      return 'alive';
    }

    const exitCode = this.acpExitCode(session?.currentRun?.status);
    const judgeInput: JudgeInput = {
      worktree: slot.worktree || '',
      branch: slot.branch || '',
      baseBranch: project.config.GITLAB_MERGE_BRANCH,
      outputFile: null,
      exitCode,
      logsDir: project.logsDir,
    };

    if (session) {
      this.syncAcpSlot(project, slotName, session);
      this.supervisor.registerAcpHandle({
        id: workerId,
        pid: null,
        outputFile: null,
        project: project.name,
        seq,
        slot: slotName,
        branch: slot.branch || '',
        worktree: slot.worktree || '',
        tool: session.tool,
        exitCode,
        sessionId: session.sessionId,
        runId: session.currentRun?.runId || null,
        sessionState: session.sessionState,
        remoteStatus: session.currentRun?.status || 'lost',
        lastEventAt: session.lastSeenAt,
        startedAt: (slot as { claimedAt?: string | null }).claimedAt || new Date().toISOString(),
        exitedAt: new Date().toISOString(),
      });
    }

    const completion = this.judge.judge(judgeInput);
    const postActionCtx = this.buildPostActionContext(project, slotName, seq, slot);
    if (completion.status === 'completed') {
      if (lease.pmStateObserved === 'QA' && completion.reason !== 'already_merged') {
        return 'completed';
      }
      await postActions.executeCompletion(postActionCtx, completion, session?.sessionId || null);
      return 'completed';
    }

    await postActions.executeFailure(
      postActionCtx,
      completion,
      exitCode,
      null,
      lease.retryCount,
      { onExit: this.buildOnExitCallback(project, slotName, slot, seq, postActions) },
    );
    return 'failed';
  }

  private async recoverPtyTask(
    project: ProjectInfo,
    slotName: string,
    seq: string,
    slot: {
      branch?: string | null;
      worktree?: string | null;
      outputFile?: string | null;
      sessionId?: string | null;
      mode?: string | null;
      transport?: 'proc' | 'acp' | 'pty' | null;
      agent?: 'claude' | 'codex' | null;
      claimedAt?: string | null;
      seq?: number | null;
    },
    postActions: PostActions,
    lease: TaskLease,
  ): Promise<'alive' | 'completed' | 'failed'> {
    const state = this.stateStore(project).readState();
    const evidence = state.worktreeEvidence[seq] || null;
    const judgeInput: JudgeInput = {
      worktree: slot.worktree || '',
      branch: slot.branch || '',
      baseBranch: project.config.GITLAB_MERGE_BRANCH,
      outputFile: null,
      exitCode: 1,
      logsDir: project.logsDir,
    };
    const completion = this.judge.judge(judgeInput);
    const postActionCtx = this.buildPostActionContext(project, slotName, seq, slot);

    if (completion.status === 'completed') {
      if (lease.pmStateObserved === 'QA' && completion.reason !== 'already_merged') {
        return 'completed';
      }
      await postActions.executeCompletion(postActionCtx, completion, null);
      return 'completed';
    }

    if (!this.shouldRestartPtyTask(lease, evidence, slot)) {
      await postActions.executeFailure(
        postActionCtx,
        completion,
        1,
        null,
        lease.retryCount,
        { onExit: this.buildOnExitCallback(project, slotName, slot, seq, postActions) },
      );
      return 'failed';
    }

    const ctx = ProjectContext.load(project.name);
    const runtime = createAgentRuntime(ctx);
    const tool = slot.agent || (project.config.ACP_AGENT || project.config.WORKER_TOOL) as 'claude' | 'codex';
    const prompt = this.buildPtyRecoveryPrompt(project, lease, slot, evidence);
    const session = await runtime.startRun(slotName, prompt, tool, slot.worktree || undefined);

    this.resourceLimiter.tryAcquire();
    this.syncRecoveredTask(project, slotName, seq, lease, slot, session);

    const workerId = `${project.name}:${slotName}:${seq}`;
    this.supervisor.registerAcpHandle({
      id: workerId,
      pid: null,
      outputFile: null,
      project: project.name,
      seq,
      slot: slotName,
      branch: slot.branch || '',
      worktree: slot.worktree || '',
      tool: session.tool,
      exitCode: null,
      sessionId: session.sessionId,
      runId: session.currentRun?.runId || null,
      sessionState: session.sessionState,
      remoteStatus: session.currentRun?.status || null,
      lastEventAt: session.lastSeenAt,
      startedAt: slot.claimedAt || lease.claimedAt || new Date().toISOString(),
      exitedAt: null,
    });

    this.log(
      `Recovered PTY task ${workerId} by starting a fresh task-level session ` +
      `(session ${session.sessionId}, run ${session.currentRun?.runId || 'unknown'})`,
    );
    return 'alive';
  }

  private listRecoverableLeases(state: RuntimeState): Array<[string, TaskLease]> {
    return Object.entries(state.leases)
      .filter(([, lease]) => !['suspended', 'released'].includes(lease.phase))
      .sort(([, a], [, b]) => {
        const aTime = Date.parse(a.lastTransitionAt || a.claimedAt || '') || 0;
        const bTime = Date.parse(b.lastTransitionAt || b.claimedAt || '') || 0;
        return aTime - bTime;
      });
  }

  private resolveRecoverySlotName(
    state: RuntimeState,
    seq: string,
    lease: TaskLease,
    reservedSlots: Set<string>,
  ): string | null {
    if (lease.slot && state.workers[lease.slot]) {
      reservedSlots.add(lease.slot);
      return lease.slot;
    }

    const existing = Object.entries(state.workers).find(
      ([name, worker]) => worker.seq === parseInt(seq, 10) && !reservedSlots.has(name),
    )?.[0];
    if (existing) {
      reservedSlots.add(existing);
      return existing;
    }

    const idle = Object.entries(state.workers).find(
      ([name, worker]) => worker.status === 'idle' && !reservedSlots.has(name),
    )?.[0];
    if (idle) {
      reservedSlots.add(idle);
      return idle;
    }

    return null;
  }

  private getRetryCount(state: RuntimeState, seq: string): number {
    return state.leases[seq]?.retryCount ?? state.activeCards[seq]?.retryCount ?? 0;
  }

  private syncAcpSlot(project: ProjectInfo, slotName: string, session: ACPSessionRecord): void {
    this.stateStore(project).updateState('recovery-acp-sync', (state) => {
      const slot = state.workers[slotName];
      if (!slot) return;
      const transport = project.config.WORKER_TRANSPORT === 'pty' ? 'pty' : 'acp';
      slot.mode = transport;
      slot.transport = transport;
      slot.agent = session.tool;
      slot.tmuxSession = session.sessionName;
      slot.sessionId = session.sessionId;
      slot.runId = session.currentRun?.runId || null;
      slot.sessionState = session.sessionState;
      slot.remoteStatus = session.currentRun?.status || null;
      slot.lastEventAt = session.lastSeenAt;
      slot.pid = session.pid ?? null;
      slot.outputFile = null;
      slot.exitCode = null;
      slot.lastHeartbeat = new Date().toISOString();
    });
  }

  private syncRecoveredTask(
    project: ProjectInfo,
    slotName: string,
    seq: string,
    lease: TaskLease,
    slot: {
      branch?: string | null;
      worktree?: string | null;
      transport?: 'proc' | 'acp' | 'pty' | null;
      mode?: string | null;
      agent?: 'claude' | 'codex' | null;
      claimedAt?: string | null;
    },
    session: ACPSessionRecord,
  ): void {
    this.stateStore(project).updateState('recovery-pty-restart', (state) => {
      const worker = state.workers[slotName];
      if (worker) {
        worker.status = this.slotStatusForLease(lease.phase);
        worker.seq = parseInt(seq, 10);
        worker.branch = slot.branch || lease.branch;
        worker.worktree = slot.worktree || lease.worktree;
        worker.claimedAt = slot.claimedAt || lease.claimedAt || new Date().toISOString();
        worker.mode = 'pty';
        worker.transport = 'pty';
        worker.agent = session.tool;
        worker.tmuxSession = session.sessionName;
        worker.sessionId = session.sessionId;
        worker.runId = session.currentRun?.runId || null;
        worker.sessionState = session.sessionState;
        worker.remoteStatus = session.currentRun?.status || null;
        worker.lastEventAt = session.lastSeenAt;
        worker.pid = session.pid ?? null;
        worker.outputFile = null;
        worker.exitCode = null;
        worker.lastHeartbeat = new Date().toISOString();
      }

      state.activeCards[seq] = {
        seq: parseInt(seq, 10),
        state: this.projectedCardStateForLease(lease),
        worker: slotName,
        mrUrl: state.activeCards[seq]?.mrUrl || null,
        conflictDomains: state.activeCards[seq]?.conflictDomains || [],
        startedAt: state.activeCards[seq]?.startedAt || lease.claimedAt || new Date().toISOString(),
        retryCount: lease.retryCount,
      };

      if (state.leases[seq]) {
        state.leases[seq].slot = slotName;
        state.leases[seq].branch = slot.branch || lease.branch;
        state.leases[seq].worktree = slot.worktree || lease.worktree;
        state.leases[seq].sessionId = session.sessionId;
        state.leases[seq].runId = session.currentRun?.runId || null;
        state.leases[seq].phase = this.recoveredPhaseForLease(lease, !!session.pendingInput);
        state.leases[seq].lastTransitionAt = new Date().toISOString();
      }
    });
  }

  private shouldRestartPtyTask(
    lease: TaskLease,
    evidence: WorktreeEvidence | null,
    slot: { worktree?: string | null; branch?: string | null },
  ): boolean {
    const hasWorktree = !!(slot.worktree || lease.worktree);
    const hasBranch = !!(slot.branch || lease.branch);
    if (!hasWorktree || !hasBranch) return false;

    if (lease.pmStateObserved === 'QA') {
      return !evidence?.mergedToBase;
    }

    if (lease.phase === 'resolving_conflict') return true;
    if (lease.phase === 'waiting_confirmation') return true;
    if (lease.phase === 'coding') return true;

    if (lease.phase === 'merging' && evidence && ['rebase', 'merge', 'conflict'].includes(evidence.gitStatus)) {
      return true;
    }

    return false;
  }

  private buildPtyRecoveryPrompt(
    project: ProjectInfo,
    lease: TaskLease,
    slot: { branch?: string | null; worktree?: string | null },
    evidence: WorktreeEvidence | null,
  ): string {
    const worktree = slot.worktree || lease.worktree || '';
    const branch = slot.branch || lease.branch || '';
    const phase = selectWorkerPhase(lease.pmStateObserved, lease.phase);
    const originalPrompt = this.readTaskPrompt(worktree, phase);
    return buildResumePrompt(phase, worktree, branch, originalPrompt);
  }

  private readTaskPrompt(worktree: string, phase: 'development' | 'integration'): string | null {
    if (!worktree) return null;
    const candidateFiles = [
      resolve(worktree, '.sps', promptFileForPhase(phase)),
      resolve(worktree, '.sps', LEGACY_TASK_PROMPT_FILE),
    ];
    for (const promptFile of candidateFiles) {
      if (!existsSync(promptFile)) continue;
      try {
        const content = readFileSync(promptFile, 'utf-8').trim();
        if (content) return content;
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  private slotStatusForLease(phase: TaskLease['phase']): WorkerSlotState['status'] {
    if (phase === 'merging') return 'merging';
    if (phase === 'resolving_conflict' || phase === 'waiting_confirmation') return 'resolving';
    if (phase === 'closing') return 'releasing';
    return 'active';
  }

  private projectedCardStateForLease(
    lease: TaskLease,
  ): 'Inprogress' | 'QA' {
    const isQaPhase =
      lease.pmStateObserved === 'QA' ||
      lease.phase === 'merging' ||
      lease.phase === 'resolving_conflict' ||
      lease.phase === 'closing';
    if (isQaPhase) {
      return 'QA';
    }
    return 'Inprogress';
  }

  private recoveredPhaseForLease(
    lease: TaskLease,
    pendingInput: boolean,
  ): TaskLease['phase'] {
    if (pendingInput) return 'waiting_confirmation';
    if (lease.pmStateObserved === 'QA') {
      return lease.phase === 'resolving_conflict' ? 'resolving_conflict' : 'merging';
    }
    return lease.phase === 'resolving_conflict' ? 'resolving_conflict' : 'coding';
  }

  private isPtyTask(
    project: ProjectInfo,
    slot: { transport?: 'proc' | 'acp' | 'pty' | null; mode?: string | null },
  ): boolean {
    return slot.transport === 'pty' || slot.mode === 'pty' || project.config.WORKER_TRANSPORT === 'pty';
  }

  private isActiveRun(status: ACPRunStatus): boolean {
    return ['submitted', 'running', 'waiting_input'].includes(status);
  }

  private acpExitCode(status: ACPRunStatus | undefined): number {
    return status === 'completed' ? 0 : 1;
  }
}

function seqString(seq: number | null | undefined): string {
  return seq == null ? '' : String(seq);
}
