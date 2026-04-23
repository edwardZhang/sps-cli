/**
 * @module        StageEngine
 * @description   通用阶段引擎，根据 YAML 配置驱动任意流水线阶段的执行与流转
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-04-03
 * @updated       2026-04-03
 *
 * @role          engine
 * @layer         engine
 * @boundedContext pipeline-execution
 *
 * @stateTransition stage.from → stage.to (由 StageDefinition 配置驱动)
 * @workflow       tick → prepare (first stage) → claim → launch worker → complete → release (last stage)
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveGitlabProjectId, resolveWorkflowTransport } from '../core/config.js';
import type { ProjectContext } from '../core/context.js';
import { Logger } from '../core/logger.js';
import { buildFullMemoryContext, buildMemoryWriteInstructions } from '../core/memory.js';
import type { ProjectPipelineAdapter, StageDefinition } from '../core/projectPipelineAdapter.js';
import { readQueue } from '../core/queue.js';
import { RuntimeStore } from '../core/runtimeStore.js';
import type { RuntimeState, TaskLease, WorkerSlotState } from '../core/state.js';
import { buildPhasePrompt, buildTaskPrompt } from '../core/taskPrompts.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
// IntegrationQueue removed — single worker, no merge queue
import type { TaskRunRequest, TaskRunResponse, WorkerManager } from '../manager/worker-manager.js';
import type { ActionRecord, AuxiliaryState, Card, CommandResult, RecommendedAction } from '../shared/types.js';

// branchPushed/branchCommitsAhead removed — no worktree/branch management

const SKIP_LABELS: AuxiliaryState[] = ['BLOCKED', 'NEEDS-FIX', 'CONFLICT', 'WAITING-CONFIRMATION', 'STALE-RUNTIME'];
// CLEANUP_LABELS: cleared when a card re-enters a stage (backlog prepare step).
// ACK-TIMEOUT: left over when a dispatch failed; must be wiped before re-try.
// Per-stage ACK-RETRIED-<stage> is wiped separately in cleanAuxiliaryLabels().
// v0.50.17：RACE-CANDIDATE 是 onCompleted 打的 race 标记，重新入 stage 要清
const CLEANUP_LABELS: string[] = [...SKIP_LABELS, 'CLAIMED', 'ACK-TIMEOUT', 'RACE-CANDIDATE'];

/**
 * StageEngine — generic engine that handles any pipeline stage.
 *
 * Replaces both ExecutionEngine and CloseoutEngine. Behavior is driven by
 * the StageDefinition from YAML config + positional flags (isFirstStage / isLastStage).
 *
 * Single-worker model: worker runs directly in PROJECT_DIR on the current branch.
 * First stage: handles prepare (Backlog → Ready) and launches workers.
 * Last stage: handles release (resource cleanup).
 */
export class StageEngine {
  private log: Logger;
  private runtimeStore: RuntimeStore;

  constructor(
    private ctx: ProjectContext,
    private stage: StageDefinition,
    private stageIndex: number,
    private totalStages: number,
    private taskBackend: TaskBackend,
    _repoBackend: RepoBackend,
    private workerManager: WorkerManager,
    private pipelineAdapter: ProjectPipelineAdapter,
    private notifier?: Notifier,
  ) {
    this.log = new Logger(`stage-${stage.name}`, ctx.projectName, ctx.paths.logsDir);
    this.runtimeStore = new RuntimeStore(ctx);
  }

  /** Stage name from YAML */
  get name(): string { return this.stage.name; }

  /** Whether this is the first stage (responsible for prepare: branch + worktree) */
  get isFirstStage(): boolean { return this.stageIndex === 0; }

  /** Whether this is the last stage (responsible for release: worktree cleanup) */
  get isLastStage(): boolean { return this.stageIndex === this.totalStages - 1; }

  /** Whether this stage uses FIFO queue for serialization */
  // usesQueue removed — single worker, no queue needed

  async tick(opts: { dryRun?: boolean } = {}): Promise<CommandResult> {
    const actions: ActionRecord[] = [];
    const recommendedActions: RecommendedAction[] = [];
    const result: CommandResult = {
      project: this.ctx.projectName,
      component: `stage-${this.stage.name}`,
      status: 'ok',
      exitCode: 0,
      actions,
      recommendedActions,
      details: {},
    };

    let actionsThisTick = 0;
    const maxActions = this.ctx.config.MAX_ACTIONS_PER_TICK;

    try {
      // ── ACK timeout handling (runs before everything else) ──
      // MonitorEngine may have flagged some active-state cards with
      // ACK-TIMEOUT (resumeRun dispatched but Claude never ack'd with
      // STARTED-<stage>). Handle them first: kill worker + retry once, or
      // escalate to NEEDS-FIX if already retried. Runs for ALL stages.
      actions.push(...await this.handleAckTimeouts(opts));

      // ── First stage only: reconcile PM states + prepare backlog cards ──
      if (this.isFirstStage) {
        actions.push(...await this.reconcilePmStatesWithRuntime());

        // 1. Check active cards for completion (free slots before launching)
        const activeCards = await this.listRuntimeAwareActiveCards();
        for (const card of activeCards) {
          if (this.shouldSkip(card)) continue;
          const checkResult = await this.checkActiveCard(card, opts);
          if (checkResult) actions.push(checkResult);
        }

        // 2. Prepare backlog cards (branch + worktree + move to ready)
        const backlogCards = await this.taskBackend.listByState(this.pipelineAdapter.states.backlog);
        const currentState = this.runtimeStore.readState();
        const idleSlots = Object.values(currentState.workers).filter(w => w.status === 'idle').length;
        const readyCards0 = await this.taskBackend.listByState(this.pipelineAdapter.states.ready);
        const readyCount = readyCards0.filter(c => !this.shouldSkip(c)).length;
        const prepareLimit = Math.max(0, idleSlots - readyCount);
        let preparedThisTick = 0;

        for (const card of backlogCards) {
          if (preparedThisTick >= prepareLimit) break;
          await this.cleanAuxiliaryLabels(card);
          if (this.shouldSkip(card)) {
            actions.push({ action: 'skip', entity: `seq:${card.seq}`, result: 'skip', message: 'Has auxiliary state label' });
            continue;
          }
          const prepareResult = await this.prepareCard(card, opts);
          actions.push(prepareResult);
          if (prepareResult.result === 'ok') preparedThisTick++;
        }

        // 3. Launch ready cards (claim + context + worker + move to active)
        let readyCards = await this.taskBackend.listByState(this.pipelineAdapter.states.ready);
        const pipelineOrder = readQueue(this.ctx.paths.pipelineOrderFile);
        if (pipelineOrder.length > 0) {
          readyCards = readyCards.sort((a, b) => {
            const aIdx = pipelineOrder.indexOf(parseInt(a.seq, 10));
            const bIdx = pipelineOrder.indexOf(parseInt(b.seq, 10));
            if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
            if (aIdx >= 0) return -1;
            if (bIdx >= 0) return 1;
            return parseInt(a.seq, 10) - parseInt(b.seq, 10);
          });
        }
        const failedSlots = new Set<string>();
        for (const card of readyCards) {
          if (actionsThisTick >= maxActions) break;
          if (this.shouldSkip(card)) {
            actions.push({ action: 'skip', entity: `seq:${card.seq}`, result: 'skip', message: 'Has auxiliary state label' });
            continue;
          }
          const launchResult = await this.launchWorker(card, opts, failedSlots);
          actions.push(launchResult);
          if (launchResult.result === 'ok') actionsThisTick++;
        }
      } else {
        // ── Non-first stages: process trigger-state cards ──
        const triggerCards = await this.taskBackend.listByState(this.stage.triggerState);
        if (triggerCards.length === 0) {
          this.log.info(`No ${this.stage.triggerState} cards to process`);
          result.details = { reason: `no_${this.stage.name}_cards` };
        } else {
          this.log.info(`Processing ${triggerCards.length} ${this.stage.triggerState} card(s)`);

          for (const card of triggerCards) {
            if (card.labels.includes('BLOCKED')) {
              this.log.debug(`Skipping seq ${card.seq}: BLOCKED`);
              actions.push({ action: 'skip', entity: `seq:${card.seq}`, result: 'skip', message: 'Card is BLOCKED' });
              continue;
            }

            try {
              await this.processStageCard(card, actions, recommendedActions);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              this.log.error(`Unexpected error processing seq ${card.seq}: ${msg}`);
              actions.push({
                action: `stage-${this.stage.name}`,
                entity: `seq:${card.seq}`,
                result: 'fail',
                message: `Unexpected error: ${msg}`,
              });
            }
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Stage ${this.stage.name} tick failed: ${msg}`);
      result.status = 'fail';
      result.exitCode = 1;
      result.details = { error: msg };
    }

    if (actions.some((a) => a.result === 'fail') && result.status === 'ok') {
      result.status = this.isLastStage ? 'degraded' : 'fail';
      result.exitCode = 1;
    }

    return result;
  }

  // ─── Non-first stage: process a card in trigger state ──────────

  private async processStageCard(
    card: Card,
    actions: ActionRecord[],
    recommendedActions: RecommendedAction[],
  ): Promise<void> {
    const seq = card.seq;
    const state = this.runtimeStore.readState();
    const runtime = this.runtimeStore.getTask(seq, state);
    const worktree = this.ctx.paths.repoDir;
    const taskId = `task-${seq}`;  // Logical identifier, not a git branch

    // Check if worker is already running for this card
    const activeStatus = await this.inspectStageWorker(card, runtime.slotName, worktree, taskId, actions);
    if (activeStatus === 'active' || activeStatus === 'waiting' || activeStatus === 'done') {
      return;
    }
    if (activeStatus === 'failed') {
      recommendedActions.push({
        action: `Review ${this.stage.name} task seq:${seq}`,
        reason: `${this.stage.name} worker exited without completing`,
        severity: 'warning',
        autoExecutable: false,
        requiresConfirmation: true,
        safeToRetry: true,
      });
      return;
    }

    // Start a new worker for this stage
    await this.startStageWorker(card, runtime.slotName, worktree, taskId, actions);
  }

  private async inspectStageWorker(
    card: Card,
    slotName: string | null,
    _worktree: string,
    _taskId: string,
    actions: ActionRecord[],
  ): Promise<'idle' | 'active' | 'waiting' | 'failed' | 'done'> {
    if (!slotName) return 'idle';

    const snapshots = this.workerManager.inspect({ taskId: String(card.seq) });
    if (snapshots.length === 0) return 'idle';

    const snapshot = snapshots[0];
    if (snapshot.state === 'idle') return 'idle';

    if (snapshot.state === 'waiting_input') {
      this.log.info(`seq ${card.seq}: ${this.stage.name} worker waiting for input`);
      actions.push({
        action: `${this.stage.name}-waiting`,
        entity: `seq:${card.seq}`,
        result: 'skip',
        message: `${this.stage.name} worker waiting_input`,
      });
      return 'waiting';
    }

    if (snapshot.state === 'needs_confirmation') {
      this.log.warn(`seq ${card.seq}: ${this.stage.name} worker needs confirmation`);
      actions.push({
        action: `${this.stage.name}-waiting`,
        entity: `seq:${card.seq}`,
        result: 'skip',
        message: `${this.stage.name} worker needs_confirmation`,
      });
      return 'waiting';
    }

    if (snapshot.state === 'starting' || snapshot.state === 'running') {
      actions.push({
        action: `${this.stage.name}-running`,
        entity: `seq:${card.seq}`,
        result: 'skip',
        message: `${this.stage.name} worker ${snapshot.state}`,
      });
      return 'active';
    }

    if (snapshot.state === 'completed') {
      await this.completeAndAdvance(card, actions);
      return 'done';
    }

    // 'failed' or 'completed' without expected completion
    await this.releaseSlotForStage(card.seq, slotName);
    await this.markNeedsFix(card.seq, `${this.stage.name} worker ${snapshot.state} before completion`);
    actions.push({
      action: 'mark-needs-fix',
      entity: `seq:${card.seq}`,
      result: 'ok',
      message: `${this.stage.name} worker ${snapshot.state} before completion`,
    });
    return 'failed';
  }

  private async startStageWorker(
    card: Card,
    _preferredSlot: string | null,
    worktree: string,
    taskId: string,
    actions: ActionRecord[],
  ): Promise<void> {
    const seq = card.seq;

    const prompt = this.buildStagePrompt(card, worktree, taskId);
    const _workflowTransport = resolveWorkflowTransport(this.ctx.config);
    const logsDir = this.ctx.paths.logsDir;

    const runRequest: TaskRunRequest = {
      taskId: String(card.seq),
      cardId: String(card.seq),
      project: this.ctx.projectName,
      phase: this.stage.name as 'development',
      stageName: this.stage.name,
      cardTitle: card.title,
      prompt,
      cwd: worktree,
      branch: taskId,
      targetBranch: this.ctx.mergeBranch,
      tool: 'claude',
      transport: 'acp-sdk',
      outputFile: resolve(logsDir, `${this.ctx.projectName}-${this.stage.name}-${card.seq}-${Date.now()}.jsonl`),
      completionStrategy: this.stage.completion,
    };

    const response = await this.workerManager.run(runRequest);
    if (!response.accepted) {
      this.log.info(`seq ${seq}: WM rejected ${this.stage.name} run: ${response.rejectReason ?? 'unknown'}`);
      actions.push({
        action: `${this.stage.name}-launch`,
        entity: `seq:${seq}`,
        result: 'skip',
        message: `WM rejected: ${response.rejectReason ?? 'unknown'}`,
      });
      return;
    }

    // Queued (fifo mode)
    if (response.queued) {
      this.log.info(`seq ${seq}: Queued for ${this.stage.name} (position=${response.queuePosition})`);
      this.runtimeStore.updateState(`stage-${this.stage.name}-queue`, (draft) => {
        if (draft.leases[seq]) {
          draft.leases[seq].phase = 'merging';
          draft.leases[seq].lastTransitionAt = new Date().toISOString();
        }
      });
      actions.push({
        action: `${this.stage.name}-launch`,
        entity: `seq:${seq}`,
        result: 'ok',
        message: `Queued for ${this.stage.name} (position=${response.queuePosition})`,
      });
      return;
    }

    // PM claim (best-effort)
    const slotName = response.slot!;
    try {
      await this.taskBackend.claim(seq, slotName);
    } catch (err) {
      this.log.warn(`seq ${seq}: PM claim for ${this.stage.name} worker failed: ${err instanceof Error ? err.message : err}`);
    }

    // Update runtime state
    this.runtimeStore.updateState(`stage-${this.stage.name}-launch`, (draft) => {
      draft.activeCards[seq] = {
        seq: parseInt(seq, 10),
        state: this.stage.activeState,
        worker: slotName,
        mrUrl: draft.activeCards[seq]?.mrUrl || null,
        conflictDomains: draft.activeCards[seq]?.conflictDomains || [],
        startedAt: draft.activeCards[seq]?.startedAt || new Date().toISOString(),
        retryCount: draft.activeCards[seq]?.retryCount ?? draft.leases[seq]?.retryCount ?? 0,
      };

      draft.leases[seq] = {
        seq: parseInt(seq, 10),
        pmStateObserved: this.stage.activeState,
        phase: 'coding',
        slot: slotName,
        branch: taskId,
        worktree,
        sessionId: response.sessionId || null,
        runId: null,
        claimedAt: new Date().toISOString(),
        retryCount: draft.leases[seq]?.retryCount ?? 0,
        lastTransitionAt: new Date().toISOString(),
      };
    });

    actions.push({
      action: `${this.stage.name}-launch`,
      entity: `seq:${seq}`,
      result: 'ok',
      message: `Started ${this.stage.name} worker on ${slotName}`,
    });
    this.logEvent(`${this.stage.name}-launch`, seq, 'ok', { worker: slotName });
  }

  // ─── Completion: advance card to next state or release ─────────

  private async completeAndAdvance(card: Card, actions: ActionRecord[]): Promise<void> {
    if (this.isLastStage) {
      await this.releaseAndDone(card, actions);
    } else {
      // Move card to next state
      const seq = card.seq;
      try {
        await this.taskBackend.move(seq, this.stage.onCompleteState);
        this.log.ok(`seq ${seq}: ${this.stage.name} complete → ${this.stage.onCompleteState}`);
        // Release the current slot so next stage can use it
        const state = this.runtimeStore.readState();
        const runtime = this.runtimeStore.getTask(seq, state);
        if (runtime.slotName) {
          await this.releaseSlotForStage(seq, runtime.slotName);
        }
        actions.push({
          action: `${this.stage.name}-complete`,
          entity: `seq:${seq}`,
          result: 'ok',
          message: `${this.stage.activeState} → ${this.stage.onCompleteState}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`seq ${seq}: Failed to advance: ${msg}`);
        actions.push({
          action: `${this.stage.name}-complete`,
          entity: `seq:${seq}`,
          result: 'fail',
          message: `Advance failed: ${msg}`,
        });
      }
    }
  }

  /**
   * Release resources after final stage completion.
   * Order: Move Done → Release claim → Release slot → Stop worker → Mark worktree cleanup
   */
  private async releaseAndDone(card: Card, actions: ActionRecord[]): Promise<void> {
    const seq = card.seq;
    const errors: string[] = [];

    // Clean auxiliary labels
    for (const label of this.pipelineAdapter.auxiliaryLabels) {
      if (card.labels.includes(label)) {
        try { await this.taskBackend.removeLabel(seq, label); } catch { /* best effort */ }
      }
    }

    // Step 1: Move card to Done
    try {
      await this.taskBackend.move(seq, this.pipelineAdapter.states.done);
      this.log.ok(`seq ${seq}: Moved to ${this.pipelineAdapter.states.done}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`seq ${seq}: Failed to move to Done: ${msg}`);
      errors.push(`move-done: ${msg}`);
    }

    // Step 2: Release claim
    try {
      await this.taskBackend.releaseClaim(seq);
      this.log.ok(`seq ${seq}: Claim released`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`seq ${seq}: Failed to release claim: ${msg}`);
      errors.push(`release-claim: ${msg}`);
    }

    // Step 3: Release worker slot
    const state = this.runtimeStore.readState();
    const runtime = this.runtimeStore.getTask(seq, state);
    const slotEntry = runtime.slotName && runtime.slot ? [runtime.slotName, runtime.slot] as const : null;

    if (slotEntry) {
      const [slotName] = slotEntry;
      try {
        this.runtimeStore.updateState('stage-release', (draft) => {
          this.runtimeStore.releaseTaskProjection(draft, seq, { dropLease: true });
        });
        this.log.ok(`seq ${seq}: Worker slot ${slotName} released`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`seq ${seq}: Failed to release slot: ${msg}`);
        errors.push(`release-slot: ${msg}`);
      }
    } else {
      if (state.activeCards[seq] || state.leases[seq]) {
        try {
          this.runtimeStore.updateState('stage-release', (draft) => {
            this.runtimeStore.releaseTaskProjection(draft, seq, { dropLease: true });
          });
        } catch { /* non-fatal */ }
      }
    }

    // Step 4: Stop worker process
    try {
      const snapshots = this.workerManager.inspect({ taskId: seq });
      for (const snap of snapshots) {
        if (snap.pid && snap.pid > 0) {
          try { process.kill(snap.pid, 'SIGTERM'); } catch { /* already dead */ }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.debug(`seq ${seq}: Worker cleanup: ${msg}`);
    }

    // Notify
    if (errors.length === 0) {
      await this.notifySafe(`✅ [${this.ctx.projectName}] seq:${seq} completed and released successfully`);
    } else {
      await this.notifySafe(`⚠️ [${this.ctx.projectName}] seq:${seq} completed but release had errors: ${errors.join('; ')}`);
    }

    const actionResult = errors.length === 0 ? 'ok' as const : 'fail' as const;
    actions.push({
      action: 'stage-complete',
      entity: `seq:${seq}`,
      result: actionResult,
      message: errors.length === 0
        ? `Completed → ${this.pipelineAdapter.states.done}, resources released`
        : `Completed → ${this.pipelineAdapter.states.done} with errors: ${errors.join('; ')}`,
    });
    this.logEvent('stage-complete', seq, actionResult, errors.length > 0 ? { errors } : undefined);
  }

  // ─── First stage: active card check (detect completion) ────────

  private async checkActiveCard(
    card: Card,
    _opts: { dryRun?: boolean },
  ): Promise<ActionRecord | null> {
    const seq = card.seq;
    const state = this.runtimeStore.readState();
    const lease = state.leases[seq] || null;
    const slotName = this.findRuntimeSlotName(state, seq, lease);

    if (!slotName) return null;

    const snapshots = this.workerManager.inspect({ project: this.ctx.projectName, taskId: seq });
    const snapshot = snapshots[0];

    if (snapshot && (snapshot.state === 'running' || snapshot.state === 'starting')) {
      try {
        this.runtimeStore.updateState('stage-heartbeat', (freshState) => {
          if (freshState.workers[slotName]) {
            freshState.workers[slotName].lastHeartbeat = new Date().toISOString();
          }
        });
      } catch { /* non-fatal */ }
      return null;
    }

    if (snapshot && (snapshot.state === 'waiting_input' || snapshot.state === 'needs_confirmation')) {
      return null;
    }

    if (snapshot && snapshot.state === 'completed') {
      this.log.ok(`seq ${seq}: Completed (handled by WM exit callback)`);
      return { action: 'complete', entity: `seq:${seq}`, result: 'ok', message: 'Completed via WM exit callback' };
    }

    if (snapshot && snapshot.state === 'failed') {
      this.log.info(`seq ${seq}: Failed (handled by WM exit callback)`);
      return { action: 'complete', entity: `seq:${seq}`, result: 'fail', message: 'Failed via WM exit callback' };
    }

    const freshState = this.runtimeStore.readState();
    if (!freshState.workers[slotName] || freshState.workers[slotName].status === 'idle') {
      return { action: 'complete', entity: `seq:${seq}`, result: 'ok', message: 'Completed (WM processed)' };
    }
    return null;
  }

  // ─── First stage: prepare (Backlog → Ready) ────────────────────

  // ─── First stage: prepare (Backlog → Ready) ─────────────────
  // Single worker model: no branch/worktree creation. Just move card to Ready.

  private async prepareCard(card: Card, opts: { dryRun?: boolean }): Promise<ActionRecord> {
    const seq = card.seq;

    if (opts.dryRun) {
      return { action: 'prepare', entity: `seq:${seq}`, result: 'ok', message: 'dry-run' };
    }

    try {
      await this.taskBackend.move(seq, this.pipelineAdapter.states.ready);
      this.log.ok(`Moved seq ${seq} ${this.pipelineAdapter.states.backlog} → ${this.pipelineAdapter.states.ready}`);
      this.logEvent('prepare', seq, 'ok');
      await this.notifySafe(`ℹ️ [${this.ctx.projectName}] seq:${seq} ready (${this.pipelineAdapter.states.backlog} → ${this.pipelineAdapter.states.ready})`);
      return { action: 'prepare', entity: `seq:${seq}`, result: 'ok', message: `${this.pipelineAdapter.states.backlog} → ${this.pipelineAdapter.states.ready}` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Prepare failed for seq ${seq}: ${msg}`);
      this.logEvent('prepare', seq, 'fail', { error: msg });
      return { action: 'prepare', entity: `seq:${seq}`, result: 'fail', message: `Move to ${this.pipelineAdapter.states.ready} failed: ${msg}` };
    }
  }

  // ─── First stage: launch worker (Ready → Active) ───────────────

  private async launchWorker(
    card: Card,
    opts: { dryRun?: boolean },
    failedSlots: Set<string> = new Set(),
  ): Promise<ActionRecord> {
    const seq = card.seq;
    const worktreePath = this.ctx.paths.repoDir;  // Single worker: always use PROJECT_DIR
    const taskId = `task-${seq}`;              // Logical identifier, not a git branch

    if (opts.dryRun) {
      return { action: 'launch', entity: `seq:${seq}`, result: 'ok', message: 'dry-run' };
    }

    // PM claim
    try {
      await this.taskBackend.claim(seq, `pending-wm`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`PM claim for seq ${seq} failed (non-fatal): ${msg}`);
    }

    // Build prompt
    let prompt: string;
    try {
      prompt = this.buildStagePrompt(card, worktreePath, taskId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Prompt build failed for seq ${seq}: ${msg}`);
      this.logEvent('launch-context', seq, 'fail', { error: msg });
      return { action: 'launch', entity: `seq:${seq}`, result: 'fail', message: `Context build failed: ${msg}` };
    }

    // Launch worker
    const logsDir = this.ctx.config.raw.LOGS_DIR || `/tmp/sps-${this.ctx.projectName}`;
    const runRequest: TaskRunRequest = {
      taskId: String(card.seq),
      cardId: String(card.seq),
      project: this.ctx.projectName,
      phase: 'development',
      stageName: this.stage.name,
      cardTitle: card.title,
      prompt,
      cwd: worktreePath,
      branch: taskId,
      targetBranch: this.ctx.mergeBranch,
      tool: 'claude',
      transport: 'acp-sdk',
      outputFile: resolve(logsDir, `${this.ctx.projectName}-worker-${card.seq}-${Date.now()}.jsonl`),
      timeoutSec: this.ctx.config.WORKER_LAUNCH_TIMEOUT_S,
      maxRetries: this.ctx.config.WORKER_RESTART_LIMIT,
      completionStrategy: this.stage.completion,
    };

    let response: TaskRunResponse;
    try {
      response = await this.workerManager.run(runRequest);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`WM.run failed for seq ${seq}: ${msg}`);
      failedSlots.add(`wm-error-${seq}`);
      this.logEvent('launch-worker', seq, 'fail', { error: msg });
      return { action: 'launch', entity: `seq:${seq}`, result: 'fail', message: `Worker launch failed: ${msg}` };
    }

    if (!response.accepted) {
      this.log.warn(`WM rejected seq ${seq}: ${response.rejectReason}`);
      return {
        action: 'launch',
        entity: `seq:${seq}`,
        result: response.rejectReason === 'resource_exhausted' ? 'skip' : 'fail',
        message: `WM rejected: ${response.rejectReason}`,
      };
    }

    const slotName = response.slot!;
    this.log.ok(`WM launched worker for seq ${seq} (slot=${slotName}, pid=${response.pid ?? 'n/a'})`);
    await this.notifySafe(`▶️ [${this.ctx.projectName}] seq:${seq} worker started (${slotName})`);

    // Move card to active state
    try {
      await this.taskBackend.move(seq, this.stage.activeState);
      this.runtimeStore.updateState('stage-launch', (freshState) => {
        if (freshState.activeCards[seq]) {
          freshState.activeCards[seq].state = this.stage.activeState;
          if (freshState.leases[seq]) {
            freshState.leases[seq].pmStateObserved = this.stage.activeState;
            if (freshState.leases[seq].phase === 'preparing' || freshState.leases[seq].phase === 'queued') {
              freshState.leases[seq].phase = 'coding';
            }
            freshState.leases[seq].lastTransitionAt = new Date().toISOString();
          }
        }
      });
      this.log.ok(`Moved seq ${seq} ${this.pipelineAdapter.states.ready} → ${this.stage.activeState}`);
      this.logEvent('launch', seq, 'ok', { worker: slotName });
      return { action: 'launch', entity: `seq:${seq}`, result: 'ok', message: `${this.pipelineAdapter.states.ready} → ${this.stage.activeState} (${slotName})` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Move failed for seq ${seq}: ${msg}`);
      try {
        await this.workerManager.cancel({ taskId: String(card.seq), project: this.ctx.projectName, reason: 'anomaly' });
      } catch { /* best effort */ }
      this.releaseSlot(slotName, seq);
      this.logEvent('launch-move', seq, 'fail', { error: msg });
      return { action: 'launch', entity: `seq:${seq}`, result: 'fail', message: `Move to ${this.stage.activeState} failed: ${msg}` };
    }
  }

  // ─── Runtime helpers ───────────────────────────────────────────

  private async listRuntimeAwareActiveCards(): Promise<Card[]> {
    const cards = await this.taskBackend.listByState(this.stage.activeState);
    const bySeq = new Map(cards.map(card => [card.seq, card]));
    const state = this.runtimeStore.readState();

    for (const [seq, lease] of Object.entries(state.leases)) {
      const slot = lease.slot ? state.workers[lease.slot] || null : null;
      if (this.derivePmStateFromLease(lease, slot) !== this.stage.activeState || bySeq.has(seq)) continue;
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

      // Never pull a card BACK from Done — Done is terminal
      if (card.state === this.pipelineAdapter.states.done) {
        // Stale lease for a completed card — clean it up
        this.runtimeStore.updateState('reconcile-cleanup-done', (draft) => {
          this.runtimeStore.releaseTaskProjection(draft, seq, { dropLease: true });
        });
        continue;
      }

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
  ): string | null {
    const s = this.pipelineAdapter.states;
    if (lease.phase === 'queued' || lease.phase === 'preparing') {
      return s.ready;
    }
    if (lease.phase === 'coding') {
      return this.stage.activeState;
    }
    if (lease.phase === 'waiting_confirmation') {
      // If in a later stage (merging context), keep current observed state
      if (lease.pmStateObserved && lease.pmStateObserved !== this.stage.activeState
          && slot?.status !== 'merging' && slot?.status !== 'resolving') {
        return this.stage.activeState;
      }
      return lease.pmStateObserved || this.stage.activeState;
    }
    if (['merging', 'resolving_conflict', 'closing'].includes(lease.phase)) {
      return this.stage.activeState;
    }
    return null;
  }

  // ─── Prompt building ───────────────────────────────────────────

  private buildStagePrompt(card: Card, worktreePath: string, taskId: string): string {
    const skillContent = this.loadSkillProfiles(card);

    let projectRules = '';
    const claudeMdPath = resolve(worktreePath, 'CLAUDE.md');
    const agentsMdPath = resolve(worktreePath, 'AGENTS.md');
    if (existsSync(claudeMdPath)) {
      projectRules = readFileSync(claudeMdPath, 'utf-8').trim();
    }
    if (existsSync(agentsMdPath)) {
      const agentsRules = readFileSync(agentsMdPath, 'utf-8').trim();
      projectRules = projectRules ? `${projectRules}\n\n${agentsRules}` : agentsRules;
    }

    // Memory system: inject user + project memories + write instructions
    // v0.50.18：可通过 ENABLE_MEMORY=false 关闭。关闭时 instructions 不注入，但已有的
    // memory content 仍然会注入（读已存内容不烧 prompt 预算）。
    const memoryEnabled = this.ctx.config.raw.ENABLE_MEMORY !== 'false';
    const memoryContext = buildFullMemoryContext({ project: this.ctx.projectName, cardSeq: card.seq });
    const memoryInstructions = memoryEnabled
      ? buildMemoryWriteInstructions(this.ctx.projectName)
      : '';
    const knowledge = [memoryContext, memoryInstructions].filter(Boolean).join('\n\n---\n\n');

    const promptCtx = {
      taskSeq: card.seq,
      taskTitle: card.title,
      taskDescription: card.desc || '(no description)',
      cardId: card.id,
      worktreePath,
      branchName: taskId,
      targetBranch: this.ctx.mergeBranch,
      mergeMode: this.ctx.mrMode,
      gitlabProjectId: resolveGitlabProjectId(this.ctx.config),
      skillContent,
      projectRules: projectRules || undefined,
      knowledge,
      // v0.50.18：COMPLETION_SIGNAL env 覆盖默认 "done"
      completionSignal: this.ctx.config.raw.COMPLETION_SIGNAL || undefined,
    };

    let prompt: string;
    if (this.pipelineAdapter.gitEnabled) {
      prompt = buildPhasePrompt({ ...promptCtx, phase: 'development' });
    } else {
      prompt = buildTaskPrompt(promptCtx);
    }

    return prompt;
  }

  private loadSkillProfiles(card: Card): string {
    const skills = resolveRequiredSkills(card, this.stage, this.ctx.config.raw.DEFAULT_WORKER_SKILLS);
    if (skills.length === 0) return '';
    this.log.ok(`Skills: ${skills.join(', ')}`);
    return formatSkillRequirement(skills);
  }

  // loadProjectKnowledge removed — replaced by memory system (buildMemoryContext)

  // ─── Worktree cleanup (last stage only) ────────────────────────

  // ─── Common helpers ────────────────────────────────────────────

  private shouldSkip(card: Card): boolean {
    return SKIP_LABELS.some((label) => card.labels.includes(label));
  }

  private async cleanAuxiliaryLabels(card: Card): Promise<void> {
    const perStageLabel = `ACK-RETRIED-${this.stage.name}`;
    const targets = [...CLEANUP_LABELS, perStageLabel];
    for (const label of targets) {
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

  /**
   * Handle cards flagged with ACK-TIMEOUT by MonitorEngine.
   *
   *  - First-time timeout: cancel the worker, wipe ACK-TIMEOUT, add
   *    ACK-RETRIED-<stage>, move card back to triggerState so the normal
   *    launch flow re-dispatches in the same tick (fresh session).
   *  - Already retried (ACK-RETRIED-<stage> present): escalate to NEEDS-FIX.
   *
   * Runs for all stages; only processes cards in this stage's activeState.
   */
  private async handleAckTimeouts(opts: { dryRun?: boolean }): Promise<ActionRecord[]> {
    const actions: ActionRecord[] = [];
    if (!this.stage.activeState) return actions;

    let cards: Card[] = [];
    try {
      cards = await this.taskBackend.listByState(this.stage.activeState as any);
    } catch {
      return actions;
    }

    const retriedLabel = `ACK-RETRIED-${this.stage.name}`;

    for (const card of cards) {
      if (!card.labels.includes('ACK-TIMEOUT')) continue;

      const seq = card.seq;
      const alreadyRetried = card.labels.includes(retriedLabel);

      if (alreadyRetried) {
        this.log.warn(`seq ${seq}: ACK timeout after retry, escalating to NEEDS-FIX`);
        if (opts.dryRun) {
          actions.push({ action: 'ack-timeout-escalate', entity: `seq:${seq}`, result: 'skip', message: '[dry-run]' });
          continue;
        }
        try { await this.taskBackend.removeLabel(seq, 'ACK-TIMEOUT'); } catch { /* best effort */ }
        await this.markNeedsFix(seq, `ACK timeout: Claude did not acknowledge prompt after ${this.ctx.config.WORKER_ACK_MAX_RETRIES} retry`);
        actions.push({
          action: 'ack-timeout-escalate',
          entity: `seq:${seq}`,
          result: 'ok',
          message: 'Escalated to NEEDS-FIX after retry',
        });
        continue;
      }

      if (opts.dryRun) {
        actions.push({ action: 'ack-timeout-retry', entity: `seq:${seq}`, result: 'skip', message: '[dry-run] would kill worker and retry' });
        continue;
      }

      this.log.warn(`seq ${seq}: ACK timeout, killing worker and moving back to ${this.stage.triggerState} for re-dispatch`);
      try {
        await this.workerManager.cancel({ taskId: String(seq), project: this.ctx.projectName, reason: 'anomaly' });
      } catch (err) {
        this.log.error(`cancel worker for seq ${seq} failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      try { await this.taskBackend.removeLabel(seq, 'ACK-TIMEOUT'); } catch { /* best effort */ }
      // v0.41.1: Clear STARTED-<stage> before re-dispatch. If left, the next
      // MonitorEngine tick sees the stale STARTED label and skips the ACK
      // check for this card — silently disabling the ACK probe after the
      // first retry.
      try { await this.taskBackend.removeLabel(seq, `STARTED-${this.stage.name}`); } catch { /* best effort */ }
      try { await this.taskBackend.addLabel(seq, retriedLabel); } catch { /* best effort */ }

      // Move back to trigger state so the normal launch flow re-dispatches
      // this card in the same tick (with a fresh claude session).
      try {
        await this.taskBackend.move(seq, this.stage.triggerState as any);
      } catch (err) {
        this.log.error(`Failed to move seq ${seq} back to ${this.stage.triggerState}: ${err instanceof Error ? err.message : String(err)}`);
      }

      actions.push({
        action: 'ack-timeout-retry',
        entity: `seq:${seq}`,
        result: 'ok',
        message: `Killed worker; moved to ${this.stage.triggerState} for re-dispatch`,
      });
    }

    return actions;
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

  private releaseSlot(slotName: string, seq: string): void {
    try {
      this.runtimeStore.updateState('stage-release-slot', (state) => {
        this.runtimeStore.releaseTaskProjection(state, seq, { dropLease: true });
      });
      this.taskBackend.releaseClaim(seq).catch(() => {});
    } catch {
      this.log.warn(`Failed to release slot ${slotName} for seq ${seq}`);
    }
  }

  private async releaseSlotForStage(seq: string, slotName: string): Promise<void> {
    try {
      await this.workerManager.cancel({ taskId: seq, project: this.ctx.projectName, reason: 'anomaly' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`seq ${seq}: WM cancel failed: ${msg}`);
    }

    this.runtimeStore.updateState(`stage-${this.stage.name}-release`, (draft) => {
      this.runtimeStore.releaseTaskProjection(draft, seq, {
        dropLease: false,
        phase: 'coding',
        keepWorktree: true,
        pmStateObserved: this.stage.activeState,
      });
    });

    try {
      await this.taskBackend.releaseClaim(seq);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`seq ${seq}: Failed to release claim for ${slotName}: ${msg}`);
    }
  }

  private async markNeedsFix(seq: string, reason: string): Promise<void> {
    const label = this.stage.onFailLabel || 'NEEDS-FIX';
    const comment = this.stage.onFailComment || reason;
    await this.addLabelSafe(seq, label);
    await this.commentSafe(seq, `${label}: ${comment}`);
    await this.notifySafe(`⚠️ [${this.ctx.projectName}] seq:${seq} marked ${label}: ${reason}`);
  }

  private async addLabelSafe(seq: string, label: string): Promise<void> {
    try { await this.taskBackend.addLabel(seq, label); } catch (err) {
      this.log.error(`Failed to add label ${label} to seq ${seq}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async commentSafe(seq: string, text: string): Promise<void> {
    try { await this.taskBackend.comment(seq, text); } catch (err) {
      this.log.error(`Failed to comment on seq ${seq}: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async notifySafe(message: string): Promise<void> {
    if (!this.notifier) return;
    try { await this.notifier.send(message); } catch { /* non-fatal */ }
  }

  private logEvent(action: string, seq: string, result: 'ok' | 'fail', meta?: Record<string, unknown>): void {
    this.log.event({
      component: `stage-${this.stage.name}`,
      action,
      entity: `seq:${seq}`,
      result,
      meta,
    });
  }

  // ─── Public: single-card launch (for sps worker launch) ────────

  /**
   * Launch a single card (for `sps worker launch <project> <seq>`).
   * Only available on the first stage.
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

    if (!this.isFirstStage) {
      result.status = 'fail';
      result.exitCode = 2;
      result.details = { error: 'launchSingle only available on first stage' };
      return result;
    }

    const card = await this.taskBackend.getBySeq(seq);
    if (!card) {
      result.status = 'fail';
      result.exitCode = 1;
      result.details = { error: `Card seq:${seq} not found` };
      return result;
    }

    // v0.49.15：手动单卡 launch 允许从任意非活跃态启动（Done/QA/Review/Canceled
     // 等终态卡片视为"重跑"）。已在跑（activeState）就拒绝——要先 kill worker。
    if (card.state === this.stage.activeState) {
      result.status = 'fail';
      result.exitCode = 2;
      result.details = { error: `Card seq:${seq} already in ${card.state}. Kill the worker first before re-launching.` };
      return result;
    }

    // 任何非 Backlog/Ready 的终态卡片先移回 Ready，再走统一 launch
    const readyState = this.pipelineAdapter.states.ready;
    const backlogState = this.pipelineAdapter.states.backlog;
    if (card.state !== readyState && card.state !== backlogState) {
      try {
        await this.taskBackend.move(seq, readyState);
        card.state = readyState;
      } catch (err) {
        result.status = 'fail';
        result.exitCode = 1;
        result.details = { error: `Failed to move seq:${seq} from ${card.state} to ${readyState}: ${err instanceof Error ? err.message : String(err)}` };
        return result;
      }
    }

    // If card is in Backlog, do prepare first
    if (card.state === backlogState) {
      const prepareAction = await this.prepareCard(card, opts);
      result.actions.push(prepareAction);
      if (prepareAction.result === 'fail') {
        result.status = 'fail';
        result.exitCode = 1;
        return result;
      }
      const updated = await this.taskBackend.getBySeq(seq);
      if (!updated || updated.state !== readyState) {
        result.status = 'fail';
        result.exitCode = 1;
        result.details = { error: `Card not in ${readyState} after prepare` };
        return result;
      }
    }

    const launchAction = await this.launchWorker(card, opts);
    result.actions.push(launchAction);
    if (launchAction.result === 'fail') {
      result.status = 'fail';
      result.exitCode = 1;
    }

    return result;
  }
}

// ─── Exported pure helpers (for testing) ─────────────────────────────

/**
 * v0.50.17：skill 解析的纯函数版本。顺序：card.skills → stage.profile → DEFAULT_WORKER_SKILLS。
 * 三条都空返空数组。
 *
 * 历史：v0.42 前读 `card.labels` 里 `skill:*` 前缀；v0.42 起改 frontmatter `skills` 字段；
 * v0.50.9 修了 StageEngine 还在读 labels 的 bug；v0.50.17 抽成纯函数补上测试。
 */
export function resolveRequiredSkills(
  card: { skills?: string[] },
  stage: { profile?: string },
  defaultWorkerSkills: string | undefined,
): string[] {
  const fromCard = Array.isArray(card.skills) ? card.skills.filter(Boolean) : [];
  if (fromCard.length > 0) return fromCard;

  if (stage.profile) {
    const fromStage = stage.profile.split(',').map((s) => s.trim()).filter(Boolean);
    if (fromStage.length > 0) return fromStage;
  }

  if (defaultWorkerSkills) {
    const fromDefault = defaultWorkerSkills.split(',').map((s) => s.trim()).filter(Boolean);
    if (fromDefault.length > 0) return fromDefault;
  }

  return [];
}

/** v0.50.17：skill 段模板，和 loadSkillProfiles 共用。 */
export function formatSkillRequirement(skills: string[]): string {
  return `# Required Skills\n\nThis task requires: ${skills.join(', ')}. Load the dev-worker skill and read the corresponding references before starting.`;
}
