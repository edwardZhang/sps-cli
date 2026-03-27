import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectContext } from '../core/context.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';
import type { CommandResult, ActionRecord, Card, CardState, AuxiliaryState } from '../models/types.js';
import type { ACPSessionRecord, ACPRunStatus } from '../models/acp.js';
import type { RuntimeState, TaskLease, WorkerSlotState } from '../core/state.js';
import { RuntimeStore } from '../core/runtimeStore.js';
import { resolveGitlabProjectId, resolveWorkflowTransport } from '../core/config.js';
import { resolveWorktreePath } from '../core/paths.js';
import { readQueue } from '../core/queue.js';
import {
  buildPhasePrompt,
  DEVELOPMENT_PROMPT_FILE,
  INTEGRATION_PROMPT_FILE,
  LEGACY_TASK_PROMPT_FILE,
  selectWorkerPhase,
} from '../core/taskPrompts.js';
import { Logger } from '../core/logger.js';
import { ProcessSupervisor, type WorkerHandle } from '../manager/supervisor.js';
import { CompletionJudge } from '../manager/completion-judge.js';
import { PostActions, type PostActionContext } from '../manager/post-actions.js';
import { ResourceLimiter } from '../manager/resource-limiter.js';

const SKIP_LABELS: AuxiliaryState[] = ['BLOCKED', 'NEEDS-FIX', 'CONFLICT', 'WAITING-CONFIRMATION', 'STALE-RUNTIME'];

export class ExecutionEngine {
  private log: Logger;
  private runtimeStore: RuntimeStore;

  constructor(
    private ctx: ProjectContext,
    private taskBackend: TaskBackend,
    private repoBackend: RepoBackend,
    private supervisor: ProcessSupervisor,
    private completionJudge: CompletionJudge,
    private postActions: PostActions,
    private resourceLimiter: ResourceLimiter,
    private notifier?: Notifier,
    private agentRuntime?: AgentRuntime | null,
  ) {
    this.log = new Logger('pipeline', ctx.projectName, ctx.paths.logsDir);
    this.runtimeStore = new RuntimeStore(ctx);
  }

  async tick(opts: { dryRun?: boolean } = {}): Promise<CommandResult> {
    const actions: ActionRecord[] = [];
    const result: CommandResult = {
      project: this.ctx.projectName,
      component: 'pipeline',
      status: 'ok',
      exitCode: 0,
      actions,
      recommendedActions: [],
      details: {},
    };

    let actionsThisTick = 0;
    const maxActions = this.ctx.config.MAX_ACTIONS_PER_TICK;

    try {
      actions.push(...await this.reconcilePmStatesWithRuntime());

      // 1. Process Inprogress cards (detect completion → move to QA)
      //    This runs first to free slots before launching new workers.
      //    Completion detection does NOT consume action quota — it's a
      //    prerequisite for freeing slots, not a new forward action.
      const inprogressCards = await this.listRuntimeAwareInprogressCards();
      for (const card of inprogressCards) {
        if (this.shouldSkip(card)) continue;
        const checkResult = await this.checkInprogressCard(card, opts);
        if (checkResult) {
          actions.push(checkResult);
          // NOTE: intentionally not incrementing actionsThisTick here.
          // Completion detection frees slots for new launches and should
          // never block subsequent prepare/launch steps in the same tick.
        }
      }

      // 2. Process Backlog cards (prepare: branch + worktree + move to Todo)
      //    Prepare does NOT consume launch quota — it only sets up the
      //    environment. This allows prepare + launch to happen in a single tick.
      const backlogCards = await this.taskBackend.listByState('Backlog');
      for (const card of backlogCards) {
        // Auto-clean auxiliary labels on Backlog cards — if a card was manually
        // moved back to Planning/Backlog, stale labels should not block it.
        await this.cleanAuxiliaryLabels(card);
        if (this.shouldSkip(card)) {
          actions.push({ action: 'skip', entity: `seq:${card.seq}`, result: 'skip', message: 'Has auxiliary state label' });
          continue;
        }
        const prepareResult = await this.prepareCard(card, opts);
        actions.push(prepareResult);
        // NOTE: prepare does not count toward actionsThisTick.
        // It only creates branch + worktree + moves to Todo.
        // The real throttle point is worker launch (step 3).
      }

      // 3. Process Todo cards (launch: claim + context + worker + move to Inprogress)
      //    This is the only step that consumes action quota — it starts
      //    resource-intensive AI workers that need system capacity.
      //    Sort by pipeline_order to respect card priority (#5 skip bug fix).
      let todoCards = await this.taskBackend.listByState('Todo');
      const pipelineOrder = readQueue(this.ctx.paths.pipelineOrderFile);
      if (pipelineOrder.length > 0) {
        todoCards = todoCards.sort((a, b) => {
          const aIdx = pipelineOrder.indexOf(parseInt(a.seq, 10));
          const bIdx = pipelineOrder.indexOf(parseInt(b.seq, 10));
          // Cards in pipeline_order come first, in order; others after
          if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
          if (aIdx >= 0) return -1;
          if (bIdx >= 0) return 1;
          return parseInt(a.seq, 10) - parseInt(b.seq, 10);
        });
      }
      let launchedThisTick = 0;
      const failedSlots = new Set<string>(); // track slots that failed launch this tick
      for (const card of todoCards) {
        if (actionsThisTick >= maxActions) break;
        if (this.shouldSkip(card)) {
          actions.push({ action: 'skip', entity: `seq:${card.seq}`, result: 'skip', message: 'Has auxiliary state label' });
          continue;
        }
        // Stagger is handled by ResourceLimiter.enforceStagger() inside launchCard
        const launchResult = await this.launchCard(card, opts, failedSlots);
        actions.push(launchResult);
        if (launchResult.result === 'ok') {
          actionsThisTick++;
          launchedThisTick++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Pipeline tick failed: ${msg}`);
      result.status = 'fail';
      result.exitCode = 1;
      result.details = { error: msg };
    }

    // Check for any failures
    if (actions.some((a) => a.result === 'fail') && result.status === 'ok') {
      result.status = 'fail';
      result.exitCode = 1;
    }

    return result;
  }

  /**
   * Launch a single card (for `sps worker launch <project> <seq>`).
   * Assumes card is in Todo state with branch/worktree already prepared.
   */
  async launchSingle(seq: string, opts: { dryRun?: boolean } = {}): Promise<CommandResult> {
    const result: CommandResult = {
      project: this.ctx.projectName,
      component: 'worker-launch',
      status: 'ok',
      exitCode: 0,
      actions: [],
      recommendedActions: [],
      details: {},
    };

    const card = await this.taskBackend.getBySeq(seq);
    if (!card) {
      result.status = 'fail';
      result.exitCode = 1;
      result.details = { error: `Card seq:${seq} not found` };
      return result;
    }

    // If card is in Backlog, do prepare first
    if (card.state === 'Backlog') {
      const prepareAction = await this.prepareCard(card, opts);
      result.actions.push(prepareAction);
      if (prepareAction.result === 'fail') {
        result.status = 'fail';
        result.exitCode = 1;
        return result;
      }
      // Reload card after prepare
      const updated = await this.taskBackend.getBySeq(seq);
      if (!updated || updated.state !== 'Todo') {
        result.status = 'fail';
        result.exitCode = 1;
        result.details = { error: 'Card not in Todo after prepare' };
        return result;
      }
    }

    if (card.state !== 'Todo' && card.state !== 'Backlog') {
      result.status = 'fail';
      result.exitCode = 2;
      result.details = { error: `Card seq:${seq} is in ${card.state}, expected Backlog or Todo` };
      return result;
    }

    const launchAction = await this.launchCard(card, opts);
    result.actions.push(launchAction);
    if (launchAction.result === 'fail') {
      result.status = 'fail';
      result.exitCode = 1;
    }

    return result;
  }

  private shouldSkip(card: Card): boolean {
    return SKIP_LABELS.some((label) => card.labels.includes(label));
  }

  private async listRuntimeAwareInprogressCards(): Promise<Card[]> {
    const cards = await this.taskBackend.listByState('Inprogress');
    const bySeq = new Map(cards.map(card => [card.seq, card]));
    const state = this.runtimeStore.readState();

    for (const [seq, lease] of Object.entries(state.leases)) {
      const slot = lease.slot ? state.workers[lease.slot] || null : null;
      if (this.derivePmStateFromLease(lease, slot) !== 'Inprogress' || bySeq.has(seq)) continue;
      const card = await this.taskBackend.getBySeq(seq);
      if (card) bySeq.set(seq, card);
    }

    return Array.from(bySeq.values()).sort((a, b) => parseInt(a.seq, 10) - parseInt(b.seq, 10));
  }

  private async reconcilePmStatesWithRuntime(): Promise<ActionRecord[]> {
    const state = this.runtimeStore.readState();
    const actions: ActionRecord[] = [];

    for (const [seq, lease] of Object.entries(state.leases)) {
      const slot = lease.slot ? state.workers[lease.slot] || null : null;
      const targetState = this.derivePmStateFromLease(lease, slot);
      if (!targetState) continue;

      const card = await this.taskBackend.getBySeq(seq);
      if (!card || card.state === targetState) continue;

      try {
        await this.taskBackend.move(seq, targetState);
        this.log.info(`Reconciled seq ${seq} ${card.state} → ${targetState} to match runtime state`);
        actions.push({
          action: 'pm-reconcile',
          entity: `seq:${seq}`,
          result: 'ok',
          message: `${card.state} → ${targetState}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`Failed to reconcile PM state for seq ${seq}: ${msg}`);
        actions.push({
          action: 'pm-reconcile',
          entity: `seq:${seq}`,
          result: 'skip',
          message: msg,
        });
      }
    }

    return actions;
  }

  private derivePmStateFromLease(
    lease: TaskLease,
    slot: WorkerSlotState | null,
  ): CardState | null {
    if (lease.phase === 'queued' || lease.phase === 'preparing') {
      return 'Todo';
    }
    if (lease.phase === 'coding') {
      return 'Inprogress';
    }
    if (
      lease.phase === 'waiting_confirmation'
      && lease.pmStateObserved !== 'QA'
      && slot?.status !== 'merging'
      && slot?.status !== 'resolving'
    ) {
      return 'Inprogress';
    }
    if (['merging', 'resolving_conflict', 'closing'].includes(lease.phase)) {
      return 'QA';
    }
    if (lease.phase === 'waiting_confirmation' && lease.pmStateObserved === 'QA') {
      return 'QA';
    }
    return null;
  }

  private isRuntimeOwnedSlot(
    slot: WorkerSlotState | null | undefined,
  ): boolean {
    return !!slot && slot.status !== 'idle';
  }

  /**
   * Remove auxiliary state labels (STALE-RUNTIME, NEEDS-FIX, etc.) from a card.
   * Called when a card re-enters Backlog — indicates human intent to retry,
   * so stale labels from previous runs should not block it.
   */
  private async cleanAuxiliaryLabels(card: Card): Promise<void> {
    for (const label of SKIP_LABELS) {
      if (card.labels.includes(label)) {
        try {
          await this.taskBackend.removeLabel(card.seq, label);
          card.labels = card.labels.filter(l => l !== label);
          this.log.ok(`Removed stale label "${label}" from seq ${card.seq}`);
        } catch {
          this.log.warn(`Failed to remove label "${label}" from seq ${card.seq}`);
        }
      }
    }
  }

  // ─── Inprogress Phase (detect completion → Done) ────────────────

  /**
   * Check an Inprogress card: verify worker is still running or handled by exit callback.
   *
   * The Supervisor exit callback triggers CompletionJudge → PostActions automatically,
   * so this method only needs to:
   * - Update heartbeat if worker is still running
   * - Confirm completion if PostActions already processed it
   */
  private async checkInprogressCard(
    card: Card,
    opts: { dryRun?: boolean },
  ): Promise<ActionRecord | null> {
    const seq = card.seq;
    const state = this.runtimeStore.readState();
    const lease = state.leases[seq] || null;
    const slotName = this.findRuntimeSlotName(state, seq, lease);

    if (!slotName) {
      // Slot already released (PostActions handled it via exit callback)
      return null;
    }

    if (
      state.workers[slotName]?.transport === 'acp' ||
      state.workers[slotName]?.transport === 'pty' ||
      state.workers[slotName]?.mode === 'acp' ||
      state.workers[slotName]?.mode === 'pty'
    ) {
      return this.checkAcpInprogressCard(card, slotName);
    }

    const workerId = `${this.ctx.projectName}:${slotName}:${seq}`;
    const handle = this.supervisor.get(workerId);

    if (handle && handle.exitCode === null) {
      // Worker still running — update heartbeat
      try {
        this.runtimeStore.updateState('pipeline-heartbeat', (freshState) => {
          if (freshState.workers[slotName]) {
            freshState.workers[slotName].lastHeartbeat = new Date().toISOString();
          }
        });
      } catch { /* non-fatal */ }
      return null;
    }

    if (handle && handle.exitCode !== null) {
      // Worker exited but PostActions hasn't finished yet (or just finished)
      // Check if slot is now idle
      const freshState = this.runtimeStore.readState();
      if (!freshState.workers[slotName] || freshState.workers[slotName].status === 'idle') {
        this.log.ok(`seq ${seq}: Completed (handled by exit callback)`);
        return { action: 'complete', entity: `seq:${seq}`, result: 'ok', message: 'Completed via exit callback' };
      }
      // PostActions still processing, wait for next tick
      return null;
    }

    // Handle not found in Supervisor — PostActions already removed it, or after tick restart
    // Re-read state to check if PostActions already completed
    const freshState = this.runtimeStore.readState();
    if (!freshState.workers[slotName] || freshState.workers[slotName].status === 'idle') {
      this.log.ok(`seq ${seq}: Completed (PostActions already processed)`);
      return { action: 'complete', entity: `seq:${seq}`, result: 'ok', message: 'Completed (PostActions processed)' };
    }
    // Still active in state but not in Supervisor — MonitorEngine/Recovery handles
    return null;
  }

  // ─── Prepare Phase (Backlog → Todo) ─────────────────────────────

  /**
   * Prepare a Backlog card: create branch, create worktree, move to Todo.
   * Steps 1-3 per 01 §4.3.
   */
  private async prepareCard(card: Card, opts: { dryRun?: boolean }): Promise<ActionRecord> {
    const seq = card.seq;
    const branchName = this.buildBranchName(card);
    const worktreePath = resolveWorktreePath(this.ctx.projectName, seq, this.ctx.config.WORKTREE_DIR);

    if (opts.dryRun) {
      this.log.info(`[dry-run] Would prepare seq ${seq}: branch=${branchName} worktree=${worktreePath}`);
      return { action: 'prepare', entity: `seq:${seq}`, result: 'ok', message: 'dry-run' };
    }

    // Step 1: Create branch
    try {
      await this.repoBackend.ensureBranch(
        this.ctx.paths.repoDir,
        branchName,
        this.ctx.mergeBranch,
      );
      this.log.ok(`Step 1: Branch ${branchName} created for seq ${seq}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Step 1 failed (branch) for seq ${seq}: ${msg}`);
      this.logEvent('prepare-branch', seq, 'fail', { error: msg });
      return { action: 'prepare', entity: `seq:${seq}`, result: 'fail', message: `Branch creation failed: ${msg}` };
    }

    // Step 2: Create worktree
    try {
      await this.repoBackend.ensureWorktree(
        this.ctx.paths.repoDir,
        branchName,
        worktreePath,
      );
      this.log.ok(`Step 2: Worktree created for seq ${seq} at ${worktreePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Step 2 failed (worktree) for seq ${seq}: ${msg}`);
      this.logEvent('prepare-worktree', seq, 'fail', { error: msg });
      // Rollback: cleanup branch (best effort, branch may have existed before)
      return { action: 'prepare', entity: `seq:${seq}`, result: 'fail', message: `Worktree creation failed: ${msg}` };
    }

    // Step 3: Move card to Todo
    try {
      await this.taskBackend.move(seq, 'Todo');
      this.log.ok(`Step 3: Moved seq ${seq} Backlog → Todo`);
      this.logEvent('prepare', seq, 'ok');
      if (this.notifier) {
        await this.notifier.send(`[${this.ctx.projectName}] seq:${seq} environment ready (Backlog → Todo)`, 'info').catch(() => {});
      }
      return { action: 'prepare', entity: `seq:${seq}`, result: 'ok', message: 'Backlog → Todo' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Step 3 failed (move) for seq ${seq}: ${msg}`);
      this.logEvent('prepare-move', seq, 'fail', { error: msg });
      // Rollback: cleanup branch + worktree would be ideal but risky; log for manual cleanup
      return { action: 'prepare', entity: `seq:${seq}`, result: 'fail', message: `Move to Todo failed: ${msg}` };
    }
  }

  // ─── Launch Phase (Todo → Inprogress) ────────────────────────────

  /**
   * Launch a Todo card: claim slot, build context, start worker, move to Inprogress.
   * Steps 4-7 per 01 §4.3.
   */
  private async launchCard(
    card: Card,
    opts: { dryRun?: boolean },
    failedSlots: Set<string> = new Set(),
  ): Promise<ActionRecord> {
    const seq = card.seq;
    const branchName = this.buildBranchName(card);
    const worktreePath = resolveWorktreePath(this.ctx.projectName, seq, this.ctx.config.WORKTREE_DIR);
    const workflowTransport = resolveWorkflowTransport(this.ctx.config);

    if (opts.dryRun) {
      this.log.info(`[dry-run] Would launch seq ${seq}`);
      return { action: 'launch', entity: `seq:${seq}`, result: 'ok', message: 'dry-run' };
    }

    // Step 4: Claim worker slot
    // Exclude slots that failed launch this tick to prevent repeated failures
    const state = this.runtimeStore.readState();
    const idleSlots = Object.entries(state.workers)
      .filter(([name, w]) => w.status === 'idle' && !failedSlots.has(name));
    if (idleSlots.length === 0) {
      this.log.warn(`No idle worker slot available for seq ${seq}`);
      return { action: 'launch', entity: `seq:${seq}`, result: 'skip', message: 'No idle worker slot' };
    }

    const [slotName] = idleSlots[0];
    const sessionName = `${this.ctx.projectName}-${slotName}`;

    // Claim slot in state.json
    state.workers[slotName] = {
      status: 'active',
      seq: parseInt(seq, 10),
      branch: branchName,
      worktree: worktreePath,
      tmuxSession: sessionName,
      claimedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      mode: workflowTransport === 'proc'
        ? this.ctx.config.WORKER_MODE
        : workflowTransport,
      transport: workflowTransport,
      agent: (this.ctx.config.ACP_AGENT || this.ctx.config.WORKER_TOOL) as 'claude' | 'codex',
      sessionId: null,
      runId: null,
      sessionState: null,
      remoteStatus: null,
      lastEventAt: null,
      pid: null,
      outputFile: null,
      exitCode: null,
      mergeRetries: 0,
      completedAt: null,
    };

    // Add to active cards
    const conflictDomains = card.labels
      .filter((l) => l.startsWith('conflict:'))
      .map((l) => l.slice('conflict:'.length));

    state.activeCards[seq] = {
      seq: parseInt(seq, 10),
      state: 'Todo',
      worker: slotName,
      mrUrl: null,
      conflictDomains,
      startedAt: new Date().toISOString(),
    };

    state.leases[seq] = {
      seq: parseInt(seq, 10),
      pmStateObserved: card.state,
      phase: 'preparing',
      slot: slotName,
      branch: branchName,
      worktree: worktreePath,
      sessionId: null,
      runId: null,
      claimedAt: state.workers[slotName].claimedAt,
      retryCount: 0,
      lastTransitionAt: new Date().toISOString(),
    };

    try {
      this.runtimeStore.updateState('pipeline-launch', (draft) => {
        draft.workers[slotName] = state.workers[slotName];
        draft.activeCards[seq] = state.activeCards[seq];
        draft.leases[seq] = state.leases[seq];
      });
      this.log.ok(`Step 4: Claimed slot ${slotName} for seq ${seq}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Step 4 failed (claim) for seq ${seq}: ${msg}`);
      return { action: 'launch', entity: `seq:${seq}`, result: 'fail', message: `Claim slot failed: ${msg}` };
    }

    // Also claim in PM backend
    try {
      await this.taskBackend.claim(seq, slotName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`PM claim for seq ${seq} failed (non-fatal): ${msg}`);
    }

    // Step 5: Build task context (.sps/development_prompt.txt + .sps/integration_prompt.txt)
    try {
      this.buildTaskContext(card, worktreePath);
      this.log.ok(`Step 5: Task context built for seq ${seq}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Step 5 failed (context) for seq ${seq}: ${msg}`);
      this.releaseSlot(slotName, seq);
      this.logEvent('launch-context', seq, 'fail', { error: msg });
      return { action: 'launch', entity: `seq:${seq}`, result: 'fail', message: `Context build failed: ${msg}` };
    }

    // Step 6: Launch worker via Supervisor
    try {
      const promptFile = resolve(worktreePath, '.sps', LEGACY_TASK_PROMPT_FILE);

      // Check global resource limit
      const acquire = this.resourceLimiter.tryAcquireDetailed();
      if (!acquire.acquired) {
        const reason = this.resourceLimiter.formatBlockReason(acquire.stats);
        this.log.warn(`Global resource limit reached, skipping seq ${seq}: ${reason}`);
        // Rollback: release slot
        this.releaseSlot(slotName, seq);
        return {
          action: 'launch',
          entity: `seq:${seq}`,
          result: 'skip',
          message: `Global resource limit reached: ${reason}`,
        };
      }

      await this.resourceLimiter.enforceStagger();

      const prompt = readFileSync(promptFile, 'utf-8').trim();
      const workerId = `${this.ctx.projectName}:${slotName}:${card.seq}`;

      if (workflowTransport !== 'proc') {
        const runtime = this.requireAgentRuntime();
        const session = await runtime.startRun(
          slotName,
          prompt,
          (this.ctx.config.ACP_AGENT || this.ctx.config.WORKER_TOOL) as 'claude' | 'codex',
          worktreePath,
        );

        this.runtimeStore.updateState('pipeline-launch-acp', (freshState) => {
          if (freshState.workers[slotName]) {
            this.applyAcpSessionToSlot(freshState.workers[slotName], session);
            if (freshState.leases[seq]) {
              freshState.leases[seq].sessionId = session.sessionId;
              freshState.leases[seq].runId = session.currentRun?.runId || null;
              freshState.leases[seq].phase = session.pendingInput ? 'waiting_confirmation' : 'coding';
              freshState.leases[seq].lastTransitionAt = new Date().toISOString();
            }
          }
        });

        this.supervisor.registerAcpHandle({
          id: workerId,
          pid: null,
          outputFile: null,
          project: this.ctx.projectName,
          seq: card.seq,
          slot: slotName,
          branch: branchName,
          worktree: worktreePath,
          tool: session.tool,
          exitCode: null,
          sessionId: session.sessionId,
          runId: session.currentRun?.runId || null,
          sessionState: session.sessionState,
          remoteStatus: session.currentRun?.status || null,
          lastEventAt: session.lastSeenAt,
          startedAt: new Date().toISOString(),
          exitedAt: null,
        });

        this.log.ok(
          `Step 6: ${workflowTransport.toUpperCase()} worker launched for seq ${seq} ` +
          `(session=${session.sessionId}, run=${session.currentRun?.runId || 'none'})`,
        );
      } else {
        const outputFile = resolve(
          this.ctx.config.raw.LOGS_DIR || `/tmp/sps-${this.ctx.projectName}`,
          `${sessionName}-${Date.now()}.jsonl`,
        );
        const workerHandle = this.supervisor.spawn({
          id: workerId,
          project: this.ctx.projectName,
          seq: card.seq,
          slot: slotName,
          worktree: worktreePath,
          branch: branchName,
          prompt,
          outputFile,
          tool: this.ctx.config.WORKER_TOOL,
          onExit: (exitCode: number) => {
            this.onWorkerExit(workerId, card, slotName, worktreePath, branchName, exitCode);
          },
        });

        // Store process info in state
        this.runtimeStore.updateState('pipeline-launch-print', (freshState) => {
          if (freshState.workers[slotName]) {
            freshState.workers[slotName].mode = 'print';
            freshState.workers[slotName].transport = 'proc';
            freshState.workers[slotName].agent = this.ctx.config.WORKER_TOOL;
            freshState.workers[slotName].pid = workerHandle.pid;
            freshState.workers[slotName].outputFile = workerHandle.outputFile;
            freshState.workers[slotName].sessionId = workerHandle.sessionId || null;
            freshState.workers[slotName].runId = null;
            freshState.workers[slotName].sessionState = null;
            freshState.workers[slotName].remoteStatus = null;
            freshState.workers[slotName].lastEventAt = null;
            freshState.workers[slotName].exitCode = null;
            if (freshState.leases[seq]) {
              freshState.leases[seq].phase = 'coding';
              freshState.leases[seq].lastTransitionAt = new Date().toISOString();
            }
          }
        });

        this.log.ok(`Step 6: Worker launched for seq ${seq} (pid=${workerHandle.pid})`);
      }

      if (this.notifier) {
        await this.notifier.sendSuccess(`[${this.ctx.projectName}] seq:${seq} worker started (${slotName})`).catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Step 6 failed (worker launch) for seq ${seq}: ${msg}`);
      failedSlots.add(slotName);
      this.resourceLimiter.release();
      this.releaseSlot(slotName, seq);
      this.logEvent('launch-worker', seq, 'fail', { error: msg });
      return { action: 'launch', entity: `seq:${seq}`, result: 'fail', message: `Worker launch failed: ${msg}` };
    }

    // Step 7: Move card to Inprogress
    try {
      await this.taskBackend.move(seq, 'Inprogress');
      // Update active card state
      this.runtimeStore.updateState('pipeline-launch', (freshState) => {
        if (freshState.activeCards[seq]) {
          freshState.activeCards[seq].state = 'Inprogress';
          if (freshState.leases[seq]) {
            freshState.leases[seq].pmStateObserved = 'Inprogress';
            if (freshState.leases[seq].phase === 'preparing' || freshState.leases[seq].phase === 'queued') {
              freshState.leases[seq].phase = 'coding';
            }
            freshState.leases[seq].lastTransitionAt = new Date().toISOString();
          }
        }
      });
      this.log.ok(`Step 7: Moved seq ${seq} Todo → Inprogress`);
      this.logEvent('launch', seq, 'ok', { worker: slotName, session: sessionName });
      return { action: 'launch', entity: `seq:${seq}`, result: 'ok', message: `Todo → Inprogress (${slotName})` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Step 7 failed (move) for seq ${seq}: ${msg}`);
      // Rollback: kill worker, release slot
      const workerId = `${this.ctx.projectName}:${slotName}:${card.seq}`;
      try {
        if (workflowTransport !== 'proc' && this.agentRuntime) {
          await this.agentRuntime.stopSession(slotName);
        } else {
          await this.supervisor.kill(workerId);
        }
      } catch { /* best effort */ }
      this.supervisor.remove(workerId);
      this.resourceLimiter.release();
      this.releaseSlot(slotName, seq);
      this.logEvent('launch-move', seq, 'fail', { error: msg });
      return { action: 'launch', entity: `seq:${seq}`, result: 'fail', message: `Move to Inprogress failed: ${msg}` };
    }
  }

  // ─── Worker Exit Callback ───────────────────────────────────────

  /**
   * Called by Supervisor when a worker process exits.
   * Wires CompletionJudge → PostActions to handle completion or failure.
   */
  private async onWorkerExit(
    workerId: string,
    card: Card,
    slotName: string,
    worktree: string,
    branch: string,
    exitCode: number,
  ): Promise<void> {
    const handle = this.supervisor.get(workerId);
    await this.handleWorkerFinalization(card, slotName, worktree, branch, exitCode, handle || null, 'proc');
  }

  private async checkAcpInprogressCard(
    card: Card,
    slotName: string,
  ): Promise<ActionRecord | null> {
    const runtime = this.requireAgentRuntime();
    const seq = card.seq;
    const inspected = await runtime.inspect(slotName);
    const session = inspected.sessions[slotName];
    const workerId = `${this.ctx.projectName}:${slotName}:${seq}`;
    const state = this.runtimeStore.readState();
    const slot = state.workers[slotName];
    if (!slot) return null;

    if (session) {
      this.runtimeStore.updateState('pipeline-acp-heartbeat', (freshState) => {
        const freshSlot = freshState.workers[slotName];
        if (freshSlot) {
          this.applyAcpSessionToSlot(freshSlot, session);
          freshSlot.lastHeartbeat = new Date().toISOString();
        }
      });
      this.supervisor.registerAcpHandle({
        id: workerId,
        pid: null,
        outputFile: null,
        project: this.ctx.projectName,
        seq,
        slot: slotName,
        branch: slot.branch || this.buildBranchName(card),
        worktree: slot.worktree || resolveWorktreePath(this.ctx.projectName, seq, this.ctx.config.WORKTREE_DIR),
        tool: session.tool,
        exitCode: null,
        sessionId: session.sessionId,
        runId: session.currentRun?.runId || null,
        sessionState: session.sessionState,
        remoteStatus: session.currentRun?.status || null,
        lastEventAt: session.lastSeenAt,
        startedAt: slot.claimedAt || new Date().toISOString(),
        exitedAt: null,
      });

      if (session.currentRun?.status && session.currentRun.status !== slot.remoteStatus) {
        if (session.currentRun.status === 'waiting_input') {
          this.log.info(`seq ${seq}: worker waiting for input — ${session.pendingInput?.prompt || 'input required'}`);
        } else if (session.currentRun.status === 'needs_confirmation') {
          this.log.warn(`seq ${seq}: worker needs confirmation — ${session.pendingInput?.prompt || 'confirmation required'}`);
        } else if (session.currentRun.status === 'stalled_submit') {
          this.log.warn(`seq ${seq}: worker prompt submission stalled — ${session.stalledReason || 'auto-repair pending'}`);
        }
      }

      if (!session.currentRun || this.isAcpRunActive(session.currentRun.status)) {
        return null;
      }

      const handle = this.supervisor.updateAcpHandle(workerId, {
        exitCode: this.acpRunExitCode(session.currentRun.status),
        exitedAt: new Date().toISOString(),
        sessionId: session.sessionId,
        runId: session.currentRun.runId,
        sessionState: session.sessionState,
        remoteStatus: session.currentRun.status,
        lastEventAt: session.lastSeenAt,
      }) || this.supervisor.get(workerId) || null;

      await this.handleWorkerFinalization(
        card,
        slotName,
        slot.worktree || resolveWorktreePath(this.ctx.projectName, seq, this.ctx.config.WORKTREE_DIR),
        slot.branch || this.buildBranchName(card),
        this.acpRunExitCode(session.currentRun.status),
        handle,
        resolveWorkflowTransport(this.ctx.config) === 'pty' ? 'pty' : 'acp',
      );

      return {
        action: 'complete',
        entity: `seq:${seq}`,
        result: session.currentRun.status === 'completed' ? 'ok' : 'fail',
        message: `${resolveWorkflowTransport(this.ctx.config).toUpperCase()} run ${session.currentRun.status}`,
      };
    }

    this.runtimeStore.updateState('pipeline-acp-lost', (freshState) => {
      const lostSlot = freshState.workers[slotName];
      if (lostSlot) {
        lostSlot.sessionState = 'offline';
        lostSlot.remoteStatus = 'lost';
        lostSlot.lastEventAt = new Date().toISOString();
        lostSlot.lastHeartbeat = new Date().toISOString();
      }
    });

    const handle = this.supervisor.updateAcpHandle(workerId, {
      exitCode: 1,
      exitedAt: new Date().toISOString(),
      sessionState: 'offline',
      remoteStatus: 'lost',
      lastEventAt: new Date().toISOString(),
    }) || this.supervisor.get(workerId) || null;

    await this.handleWorkerFinalization(
      card,
      slotName,
      slot.worktree || resolveWorktreePath(this.ctx.projectName, seq, this.ctx.config.WORKTREE_DIR),
      slot.branch || this.buildBranchName(card),
      1,
      handle,
      resolveWorkflowTransport(this.ctx.config) === 'pty' ? 'pty' : 'acp',
    );

    return {
      action: 'complete',
      entity: `seq:${seq}`,
      result: 'fail',
      message: 'ACP session lost',
    };
  }

  private async handleWorkerFinalization(
    card: Card,
    slotName: string,
    worktree: string,
    branch: string,
    exitCode: number,
    handle: WorkerHandle | null,
    transport: 'proc' | 'acp' | 'pty',
  ): Promise<void> {
    const completion = this.completionJudge.judge({
      worktree,
      branch,
      baseBranch: this.ctx.mergeBranch,
      outputFile: handle?.outputFile || null,
      exitCode,
      logsDir: this.ctx.paths.logsDir,
      phase: selectWorkerPhase(card.state, this.runtimeStore.readState().leases[card.seq]?.phase),
    });

    const ctx: PostActionContext = {
      project: this.ctx.projectName,
      seq: card.seq,
      slot: slotName,
      transport,
      branch,
      worktree,
      baseBranch: this.ctx.mergeBranch,
      stateFile: this.ctx.paths.stateFile,
      maxWorkers: this.ctx.maxWorkers,
      mrMode: this.ctx.mrMode,
      gitlabProjectId: resolveGitlabProjectId(this.ctx.config),
      gitlabUrl: this.ctx.config.raw.GITLAB_URL || process.env.GITLAB_URL || '',
      gitlabToken: this.ctx.config.raw.GITLAB_TOKEN || process.env.GITLAB_TOKEN || '',
      qaStateId: this.ctx.config.raw.PLANE_STATE_QA || this.ctx.config.raw.TRELLO_QA_LIST_ID || 'QA',
      doneStateId: this.ctx.config.raw.PLANE_STATE_DONE || this.ctx.config.raw.TRELLO_DONE_LIST_ID || '',
      maxRetries: this.ctx.config.WORKER_RESTART_LIMIT,
      logsDir: this.ctx.paths.logsDir,
      tool: handle?.tool || this.ctx.config.ACP_AGENT || this.ctx.config.WORKER_TOOL,
      pmStateObserved: card.state,
    };

    const state = this.runtimeStore.readState();
    const retryCount = this.getRetryCount(state, card.seq);
    const workerId = `${this.ctx.projectName}:${slotName}:${card.seq}`;

    try {
      if (completion.status === 'completed') {
        const results = await this.postActions.executeCompletion(ctx, completion, handle?.sessionId || null);
        const allOk = results.every(r => r.ok);
        this.log.ok(`seq ${card.seq}: PostActions completed (${allOk ? 'all ok' : 'some failures'})`);
      } else {
        const retrySessionId = transport === 'proc' ? (handle?.sessionId || null) : null;
        await this.postActions.executeFailure(ctx, completion, exitCode, retrySessionId, retryCount, {
          onExit: (code: number) => this.onWorkerExit(workerId, card, slotName, worktree, branch, code),
        });
        this.log.info(`seq ${card.seq}: Failure handling done`);
      }
    } catch (err) {
      this.log.error(`seq ${card.seq}: PostActions error: ${err}`);
    }
  }

  private requireAgentRuntime(): AgentRuntime {
    if (!this.agentRuntime) {
      throw new Error('ACP transport requested but AgentRuntime is not configured');
    }
    return this.agentRuntime;
  }

  private applyAcpSessionToSlot(slot: import('../core/state.js').WorkerSlotState, session: ACPSessionRecord): void {
    const transport = resolveWorkflowTransport(this.ctx.config) === 'pty' ? 'pty' : 'acp';
    slot.mode = transport;
    slot.transport = transport;
    slot.agent = session.tool;
    slot.tmuxSession = session.sessionName;
    slot.sessionId = session.sessionId;
    slot.runId = session.currentRun?.runId || null;
    slot.sessionState = session.sessionState;
    slot.remoteStatus = session.currentRun?.status || null;
    slot.lastEventAt = session.lastSeenAt;
    slot.pid = null;
    slot.outputFile = null;
    slot.exitCode = null;
  }

  private isAcpRunActive(status: ACPRunStatus): boolean {
    return ['submitted', 'running', 'waiting_input', 'needs_confirmation', 'stalled_submit'].includes(status);
  }

  private acpRunExitCode(status: ACPRunStatus): number {
    return status === 'completed' ? 0 : 1;
  }

  private findRuntimeSlotName(
    state: RuntimeState,
    seq: string,
    lease: TaskLease | null,
  ): string | null {
    if (lease?.slot && state.workers[lease.slot]) return lease.slot;

    const slotEntry = Object.entries(state.workers).find(
      ([, worker]) => worker.seq === parseInt(seq, 10) && worker.status !== 'idle',
    );
    return slotEntry?.[0] || null;
  }

  private getRetryCount(state: RuntimeState, seq: string): number {
    return state.leases[seq]?.retryCount ?? state.activeCards[seq]?.retryCount ?? 0;
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  /**
   * Build branch name from card: feature/<seq>-<slug>
   */
  private buildBranchName(card: Card): string {
    const slug = card.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    return `feature/${card.seq}-${slug}`;
  }

  /**
   * Write task-specific prompt to worktree.
   *
   * CLAUDE.md and AGENTS.md are managed by `sps doctor --fix` and committed
   * to the repo — worktrees inherit them automatically via git.
   *
   * The prompt file includes the project rules (from CLAUDE.md) followed by
   * the task-specific details. This ensures that when a session is reused
   * (WORKER_SESSION_REUSE=true), the worker always receives the latest
   * project rules via tmux paste — even though /clear + cd does not
   * trigger Claude/Codex to re-read CLAUDE.md from disk.
   */
  private buildTaskContext(card: Card, worktreePath: string): void {
    if (!existsSync(worktreePath)) {
      mkdirSync(worktreePath, { recursive: true });
    }

    const branchName = this.buildBranchName(card);

    // ── 1. Skill Profiles (label-driven) ──
    const skillContent = this.loadSkillProfiles(card);

    // ── 2. Project Rules (CLAUDE.md + AGENTS.md) ──
    const claudeMdPath = resolve(worktreePath, 'CLAUDE.md');
    const agentsMdPath = resolve(worktreePath, 'AGENTS.md');
    let projectRules = '';
    if (existsSync(claudeMdPath)) {
      projectRules = readFileSync(claudeMdPath, 'utf-8').trim();
    } else {
      this.log.warn(`CLAUDE.md not found in worktree — run: sps doctor ${this.ctx.projectName} --fix`);
    }
    if (existsSync(agentsMdPath)) {
      const agentsRules = readFileSync(agentsMdPath, 'utf-8').trim();
      projectRules = projectRules ? `${projectRules}\n\n${agentsRules}` : agentsRules;
    }

    // ── 3. Project Knowledge (truncated) ──
    const knowledge = this.loadProjectKnowledge(worktreePath);

    const mrMode = this.ctx.mrMode;

    const sharedPromptContext = {
      taskSeq: card.seq,
      taskTitle: card.name,
      taskDescription: card.desc || '(no description)',
      cardId: card.id,
      worktreePath,
      branchName,
      targetBranch: this.ctx.mergeBranch,
      mergeMode: mrMode,
      gitlabProjectId: resolveGitlabProjectId(this.ctx.config),
      skillContent,
      projectRules,
      knowledge,
    } as const;

    const developmentPrompt = buildPhasePrompt({
      ...sharedPromptContext,
      phase: 'development',
    });
    const integrationPrompt = buildPhasePrompt({
      ...sharedPromptContext,
      phase: 'integration',
    });

    const spsDir = resolve(worktreePath, '.sps');
    if (!existsSync(spsDir)) {
      mkdirSync(spsDir, { recursive: true });
    }
    writeFileSync(resolve(spsDir, DEVELOPMENT_PROMPT_FILE), developmentPrompt);
    writeFileSync(resolve(spsDir, INTEGRATION_PROMPT_FILE), integrationPrompt);
    writeFileSync(resolve(spsDir, LEGACY_TASK_PROMPT_FILE), developmentPrompt);
  }

  /**
   * Release a worker slot and remove card from active cards.
   * Used for launch failure rollback.
   */
  private releaseSlot(slotName: string, seq: string): void {
    try {
      this.runtimeStore.updateState('pipeline-release', (state) => {
        this.runtimeStore.releaseTaskProjection(state, seq, { dropLease: true });
      });
      this.taskBackend.releaseClaim(seq).catch(() => {});
    } catch {
      this.log.warn(`Failed to release slot ${slotName} for seq ${seq}`);
    }
  }

  // ─── Skill Profile Loading (label-driven) ─────────────────────

  /**
   * Load skill profiles based on card labels (skill:xxx) or project default.
   * Returns combined profile content for prompt injection.
   */
  private loadSkillProfiles(card: Card): string {
    // 1. Extract skill:xxx labels from card
    let skills = card.labels
      .filter(l => l.startsWith('skill:'))
      .map(l => l.slice('skill:'.length));

    // 2. Fallback to project default
    if (skills.length === 0) {
      const defaultSkills = this.ctx.config.raw.DEFAULT_WORKER_SKILLS;
      if (defaultSkills) {
        skills = defaultSkills.split(',').map(s => s.trim()).filter(Boolean);
      }
    }

    if (skills.length === 0) return '';

    // 3. Load profile files from ~/.coral/profiles/
    const profilesDir = resolve(process.env.HOME || '~', '.coral', 'profiles');
    const sections: string[] = ['# Skill Profiles'];

    for (const skill of skills) {
      const filePath = resolve(profilesDir, `${skill}.md`);
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, 'utf-8').trim();
        // Strip YAML frontmatter
        const body = content.replace(/^---[\s\S]*?---\s*/, '');
        sections.push(body);
        this.log.ok(`Loaded skill profile: ${skill}`);
      } else {
        this.log.warn(`Skill profile not found: ${filePath}`);
      }
    }

    return sections.length > 1 ? sections.join('\n\n') : '';
  }

  // ─── Project Knowledge Loading (truncated) ────────────────────

  /**
   * Load recent project knowledge from docs/DECISIONS.md and docs/CHANGELOG.md.
   * Truncates to recent entries to keep prompt size manageable.
   */
  private loadProjectKnowledge(worktreePath: string): string {
    const sections: string[] = ['# Project Knowledge (from previous tasks)'];
    let hasContent = false;

    // Recent decisions (last 10 sections)
    const decisionsPath = resolve(worktreePath, 'docs', 'DECISIONS.md');
    if (existsSync(decisionsPath)) {
      const content = readFileSync(decisionsPath, 'utf-8');
      const recent = this.extractRecentSections(content, 10);
      if (recent) {
        sections.push('## Recent Decisions\n' + recent);
        hasContent = true;
      }
    }

    // Recent changelog (last 5 sections)
    const changelogPath = resolve(worktreePath, 'docs', 'CHANGELOG.md');
    if (existsSync(changelogPath)) {
      const content = readFileSync(changelogPath, 'utf-8');
      const recent = this.extractRecentSections(content, 5);
      if (recent) {
        sections.push('## Recent Changes\n' + recent);
        hasContent = true;
      }
    }

    return hasContent ? sections.join('\n\n') : '';
  }

  /**
   * Extract the last N ## sections from a markdown file.
   */
  private extractRecentSections(content: string, maxSections: number): string {
    const lines = content.split('\n');
    const sectionStarts: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) {
        sectionStarts.push(i);
      }
    }
    if (sectionStarts.length === 0) return content.trim();
    const start = sectionStarts[Math.max(0, sectionStarts.length - maxSections)];
    return lines.slice(start).join('\n').trim();
  }

  private logEvent(action: string, seq: string, result: 'ok' | 'fail', meta?: Record<string, unknown>): void {
    this.log.event({
      component: 'pipeline',
      action,
      entity: `seq:${seq}`,
      result,
      meta,
    });
  }
}
