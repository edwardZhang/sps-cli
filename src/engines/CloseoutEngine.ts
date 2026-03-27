import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectContext } from '../core/context.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { WorkerProvider } from '../interfaces/WorkerProvider.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';
import type { ACPSessionRecord } from '../models/acp.js';
import type { CommandResult, ActionRecord, Card, RecommendedAction } from '../models/types.js';
import { INTEGRATION_PROMPT_FILE, LEGACY_TASK_PROMPT_FILE } from '../core/taskPrompts.js';
import { RuntimeStore } from '../core/runtimeStore.js';
import { resolveWorktreePath } from '../core/paths.js';
import { Logger } from '../core/logger.js';

/**
 * CloseoutEngine handles the QA → Done pipeline.
 *
 * In the worker-owned two-phase model, QA means integration:
 * - the worker performs rebase / merge / conflict resolution
 * - SPS only checks evidence, starts or resumes the integration worker,
 *   and finalizes the task after the branch is merged.
 */
export class CloseoutEngine {
  private log: Logger;
  private runtimeStore: RuntimeStore;

  constructor(
    private ctx: ProjectContext,
    private taskBackend: TaskBackend,
    private repoBackend: RepoBackend,
    private workerProvider: WorkerProvider,
    private notifier?: Notifier,
    private agentRuntime: AgentRuntime | null = null,
  ) {
    this.log = new Logger('qa', ctx.projectName, ctx.paths.logsDir);
    this.runtimeStore = new RuntimeStore(ctx);
  }

  async tick(): Promise<CommandResult> {
    const actions: ActionRecord[] = [];
    const recommendedActions: RecommendedAction[] = [];
    const result: CommandResult = {
      project: this.ctx.projectName,
      component: 'qa',
      status: 'ok',
      exitCode: 0,
      actions,
      recommendedActions,
      details: {},
    };

    try {
      const qaCards = await this.taskBackend.listByState('QA');
      if (qaCards.length === 0) {
        this.log.info('No QA cards to process');
        result.details = { reason: 'no_qa_cards' };
      } else {
        this.log.info(`Processing ${qaCards.length} QA card(s)`);

        for (const card of qaCards) {
          // Skip cards with BLOCKED label
          if (card.labels.includes('BLOCKED')) {
            this.log.debug(`Skipping seq ${card.seq}: BLOCKED`);
            actions.push({
              action: 'skip',
              entity: `seq:${card.seq}`,
              result: 'skip',
              message: 'Card is BLOCKED',
            });
            continue;
          }

          try {
            await this.processQaCard(card, actions, recommendedActions);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.error(`Unexpected error processing seq ${card.seq}: ${msg}`);
            actions.push({
              action: 'closeout',
              entity: `seq:${card.seq}`,
              result: 'fail',
              message: `Unexpected error: ${msg}`,
            });
          }
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Closeout tick failed: ${msg}`);
      result.status = 'fail';
      result.exitCode = 1;
      result.details = { error: msg };
    }

    // Always run worktree cleanup — independent of QA card processing
    await this.cleanupWorktrees(actions);

    if (actions.some((a) => a.result === 'fail') && result.status === 'ok') {
      result.status = 'degraded';
    }

    return result;
  }

  // ─── Core Decision Tree ───────────────────────────────────────

  private async processQaCard(
    card: Card,
    actions: ActionRecord[],
    recommendedActions: RecommendedAction[],
  ): Promise<void> {
    const seq = card.seq;
    const state = this.runtimeStore.readState();
    const runtime = this.runtimeStore.getTask(seq, state);
    const branchName =
      runtime.lease?.branch ||
      runtime.evidence?.branch ||
      this.buildBranchName(card);
    const worktree =
      runtime.lease?.worktree ||
      runtime.evidence?.worktree ||
      resolveWorktreePath(this.ctx.projectName, seq, this.ctx.config.WORKTREE_DIR);

    if (!worktree || !existsSync(worktree)) {
      await this.markNeedsFix(seq, 'QA task has no usable worktree');
      actions.push({
        action: 'mark-needs-fix',
        entity: `seq:${seq}`,
        result: 'ok',
        message: 'No usable worktree for QA task',
      });
      return;
    }

    if (this.isMergedToBase(worktree, branchName)) {
      this.log.info(`seq ${seq}: integration already complete, proceeding to release`);
      await this.releaseAndDone(card, actions);
      return;
    }

    const activeStatus = await this.inspectQaWorker(card, runtime.slotName, worktree, branchName, actions);
    if (activeStatus === 'active' || activeStatus === 'waiting' || activeStatus === 'done') {
      return;
    }
    if (activeStatus === 'failed') {
      recommendedActions.push({
        action: `Review QA task seq:${seq}`,
        reason: 'Integration worker exited without merging the branch',
        severity: 'warning',
        autoExecutable: false,
        requiresConfirmation: true,
        safeToRetry: true,
      });
      return;
    }

    await this.startIntegrationWorker(card, runtime.slotName, worktree, branchName, actions);
  }

  private async inspectQaWorker(
    card: Card,
    slotName: string | null,
    worktree: string,
    branchName: string,
    actions: ActionRecord[],
  ): Promise<'idle' | 'active' | 'waiting' | 'failed' | 'done'> {
    if (!slotName) return 'idle';

    const state = this.runtimeStore.readState();
    const slot = state.workers[slotName];
    if (!slot || slot.status === 'idle') return 'idle';

    if (slot.transport === 'pty' || slot.transport === 'acp' || slot.mode === 'pty' || slot.mode === 'acp') {
      if (!this.agentRuntime) return 'failed';
      const inspected = await this.agentRuntime.inspect(slotName);
      const session = inspected.sessions[slotName];

      if (!session) return 'idle';

      this.runtimeStore.updateState('closeout-sync-qa-session', (draft) => {
        const worker = draft.workers[slotName];
        if (!worker) return;
        worker.mode = this.ctx.config.WORKER_TRANSPORT === 'pty' ? 'pty' : 'acp';
        worker.transport = this.ctx.config.WORKER_TRANSPORT === 'pty' ? 'pty' : 'acp';
        worker.agent = session.tool;
        worker.tmuxSession = session.sessionName;
        worker.sessionId = session.sessionId;
        worker.runId = session.currentRun?.runId || null;
        worker.sessionState = session.sessionState;
        worker.remoteStatus = session.currentRun?.status || null;
        worker.lastEventAt = session.lastSeenAt;
        worker.lastHeartbeat = new Date().toISOString();
        worker.pid = session.pid ?? null;
        worker.outputFile = null;
        worker.exitCode = null;
        worker.status = session.pendingInput || session.currentRun?.status === 'waiting_input'
          ? 'resolving'
          : 'merging';
        if (draft.leases[card.seq]) {
          draft.leases[card.seq].slot = slotName;
          draft.leases[card.seq].sessionId = session.sessionId;
          draft.leases[card.seq].runId = session.currentRun?.runId || null;
          draft.leases[card.seq].phase = session.pendingInput || session.currentRun?.status === 'waiting_input'
            ? 'waiting_confirmation'
            : 'merging';
          draft.leases[card.seq].pmStateObserved = 'QA';
          draft.leases[card.seq].lastTransitionAt = new Date().toISOString();
        }
      });

      const run = session.currentRun;
      if (!run) return 'idle';
      if (run.status === 'waiting_input') {
        actions.push({
          action: 'qa-waiting',
          entity: `seq:${card.seq}`,
          result: 'skip',
          message: 'Integration worker waiting for input',
        });
        return 'waiting';
      }
      if (['submitted', 'running'].includes(run.status)) {
        actions.push({
          action: 'qa-running',
          entity: `seq:${card.seq}`,
          result: 'skip',
          message: `Integration worker ${run.status}`,
        });
        return 'active';
      }
      if (this.isMergedToBase(worktree, branchName)) {
        await this.releaseAndDone(card, actions);
        return 'done';
      }

      await this.releaseQaSlot(card.seq, slotName);
      await this.markNeedsFix(card.seq, `Integration run ${run.status} before merge completed`);
      actions.push({
        action: 'mark-needs-fix',
        entity: `seq:${card.seq}`,
        result: 'ok',
        message: `Integration run ${run.status} before merge completed`,
      });
      return 'failed';
    }

    const sessionName = slot.tmuxSession || `${this.ctx.projectName}-${slotName}`;
    try {
      const inspection = await this.workerProvider.inspect(sessionName);
      if (inspection.alive) {
        this.runtimeStore.updateState('closeout-sync-qa-proc', (draft) => {
          const worker = draft.workers[slotName];
          if (!worker) return;
          worker.lastHeartbeat = new Date().toISOString();
          worker.status = 'merging';
        });
        actions.push({
          action: 'qa-running',
          entity: `seq:${card.seq}`,
          result: 'skip',
          message: 'Integration worker running',
        });
        return 'active';
      }
    } catch {
      // fall through to merged/failure checks
    }

    if (this.isMergedToBase(worktree, branchName)) {
      await this.releaseAndDone(card, actions);
      return 'done';
    }

    await this.releaseQaSlot(card.seq, slotName);
    await this.markNeedsFix(card.seq, 'Integration worker exited before merge completed');
    actions.push({
      action: 'mark-needs-fix',
      entity: `seq:${card.seq}`,
      result: 'ok',
      message: 'Integration worker exited before merge completed',
    });
    return 'failed';
  }

  private async startIntegrationWorker(
    card: Card,
    preferredSlot: string | null,
    worktree: string,
    branchName: string,
    actions: ActionRecord[],
  ): Promise<void> {
    const seq = card.seq;
    const state = this.runtimeStore.readState();
    const slotName = this.runtimeStore.findAvailableSlot(state, { preferred: preferredSlot });
    if (!slotName) {
      actions.push({
        action: 'qa-launch',
        entity: `seq:${seq}`,
        result: 'skip',
        message: 'No idle worker slot for integration',
      });
      return;
    }

    const promptFile = this.resolveIntegrationPrompt(worktree);
    if (!promptFile) {
      await this.markNeedsFix(seq, 'Missing integration prompt in worktree');
      actions.push({
        action: 'mark-needs-fix',
        entity: `seq:${seq}`,
        result: 'ok',
        message: 'Missing integration prompt in worktree',
      });
      return;
    }

    try {
      await this.taskBackend.claim(seq, slotName);
    } catch (err) {
      this.log.warn(`seq ${seq}: PM claim for QA worker failed: ${err instanceof Error ? err.message : err}`);
    }

    if (this.ctx.config.WORKER_TRANSPORT !== 'proc' && this.agentRuntime) {
      const prompt = readFileSync(promptFile, 'utf-8').trim();
      const session = await this.agentRuntime.startRun(
        slotName,
        prompt,
        (this.ctx.config.ACP_AGENT || this.ctx.config.WORKER_TOOL) as 'claude' | 'codex',
        worktree,
      );

      this.runtimeStore.updateState('closeout-launch-integration', (draft) => {
        const worker = draft.workers[slotName];
        if (!worker) return;
        worker.status = 'merging';
        worker.seq = parseInt(seq, 10);
        worker.branch = branchName;
        worker.worktree = worktree;
        worker.claimedAt = worker.claimedAt || new Date().toISOString();
        worker.lastHeartbeat = new Date().toISOString();
        worker.mode = this.ctx.config.WORKER_TRANSPORT === 'pty' ? 'pty' : 'acp';
        worker.transport = this.ctx.config.WORKER_TRANSPORT === 'pty' ? 'pty' : 'acp';
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

        draft.activeCards[seq] = {
          seq: parseInt(seq, 10),
          state: 'QA',
          worker: slotName,
          mrUrl: draft.activeCards[seq]?.mrUrl || null,
          conflictDomains: draft.activeCards[seq]?.conflictDomains || [],
          startedAt: draft.activeCards[seq]?.startedAt || new Date().toISOString(),
          retryCount: draft.activeCards[seq]?.retryCount ?? draft.leases[seq]?.retryCount ?? 0,
        };

        draft.leases[seq] = {
          seq: parseInt(seq, 10),
          pmStateObserved: 'QA',
          phase: session.pendingInput ? 'waiting_confirmation' : 'merging',
          slot: slotName,
          branch: branchName,
          worktree,
          sessionId: session.sessionId,
          runId: session.currentRun?.runId || null,
          claimedAt: worker.claimedAt,
          retryCount: draft.leases[seq]?.retryCount ?? 0,
          lastTransitionAt: new Date().toISOString(),
        };
      });
    } else {
      const sessionName = `${this.ctx.projectName}-${slotName}`;
      const result = await this.workerProvider.launch(sessionName, worktree, promptFile);
      this.runtimeStore.updateState('closeout-launch-integration-proc', (draft) => {
        const worker = draft.workers[slotName];
        if (!worker) return;
        worker.status = 'merging';
        worker.seq = parseInt(seq, 10);
        worker.branch = branchName;
        worker.worktree = worktree;
        worker.claimedAt = worker.claimedAt || new Date().toISOString();
        worker.lastHeartbeat = new Date().toISOString();
        worker.mode = 'print';
        worker.transport = 'proc';
        worker.agent = this.ctx.config.WORKER_TOOL;
        worker.tmuxSession = sessionName;
        worker.sessionId = result.sessionId || null;
        worker.runId = null;
        worker.sessionState = null;
        worker.remoteStatus = null;
        worker.lastEventAt = null;
        worker.pid = result.pid;
        worker.outputFile = result.outputFile;
        worker.exitCode = null;

        draft.activeCards[seq] = {
          seq: parseInt(seq, 10),
          state: 'QA',
          worker: slotName,
          mrUrl: draft.activeCards[seq]?.mrUrl || null,
          conflictDomains: draft.activeCards[seq]?.conflictDomains || [],
          startedAt: draft.activeCards[seq]?.startedAt || new Date().toISOString(),
          retryCount: draft.activeCards[seq]?.retryCount ?? draft.leases[seq]?.retryCount ?? 0,
        };

        draft.leases[seq] = {
          seq: parseInt(seq, 10),
          pmStateObserved: 'QA',
          phase: 'merging',
          slot: slotName,
          branch: branchName,
          worktree,
          sessionId: result.sessionId || null,
          runId: null,
          claimedAt: worker.claimedAt,
          retryCount: draft.leases[seq]?.retryCount ?? 0,
          lastTransitionAt: new Date().toISOString(),
        };
      });
    }

    actions.push({
      action: 'qa-launch',
      entity: `seq:${seq}`,
      result: 'ok',
      message: `Started integration worker on ${slotName}`,
    });
    this.logEvent('qa-launch', seq, 'ok', { worker: slotName });
  }

  private async processOpenMr(
    card: Card,
    mrStatus: { ciStatus: string; mergeStatus: string; iid: number | null },
    actions: ActionRecord[],
    recommendedActions: RecommendedAction[],
  ): Promise<void> {
    const seq = card.seq;

    // Check merge conflicts — attempt auto-resolution (L1 rebase → L2 worker)
    if (mrStatus.mergeStatus === 'cannot_be_merged') {
      this.log.warn(`seq ${seq}: MR has merge conflicts, attempting resolution`);
      await this.notifySafe(`seq:${seq} merge conflict detected — attempting auto-resolution`, 'warning');
      const resolved = await this.resolveConflict(card, actions);
      if (resolved) {
        // Conflict resolved — skip this tick, let next tick re-check CI/merge status
        return;
      }
      // Resolution failed — mark CONFLICT
      await this.addLabelSafe(seq, 'CONFLICT');
      await this.commentSafe(seq, 'Merge conflict could not be auto-resolved. Manual intervention needed.');
      await this.notifySafe(`seq:${seq} conflict auto-resolution FAILED — needs manual fix`, 'error');
      actions.push({
        action: 'mark-conflict',
        entity: `seq:${seq}`,
        result: 'ok',
        message: 'Conflict unresolvable',
      });
      this.logEvent('closeout-conflict', seq, 'ok');
      return;
    }

    // Determine effective CI mode:
    // - CI_MODE=none → no CI, skip checks
    // - CI_MODE=gitlab/local but ciStatus=unknown (no pipeline) → treat as no CI
    const noCi = this.ctx.ciMode === 'none'
      || (mrStatus.ciStatus === 'unknown' && mrStatus.iid != null);

    if (noCi) {
      // No CI configured or no pipeline on this MR → go straight to merge
      this.log.info(`seq ${seq}: No CI (mode=${this.ctx.ciMode}, ciStatus=${mrStatus.ciStatus}), proceeding to merge`);
      if (mrStatus.iid != null) {
        await this.attemptMerge(card, mrStatus.iid, actions);
      } else {
        actions.push({
          action: 'skip',
          entity: `seq:${seq}`,
          result: 'skip',
          message: 'No CI, but MR has no iid',
        });
      }
      return;
    }

    // CI exists — check status
    switch (mrStatus.ciStatus) {
      case 'running':
      case 'pending':
      case 'created':
        // CI still running → skip, wait for next tick
        this.log.debug(`seq ${seq}: CI is ${mrStatus.ciStatus}, waiting`);
        actions.push({
          action: 'skip',
          entity: `seq:${seq}`,
          result: 'skip',
          message: `CI is ${mrStatus.ciStatus}`,
        });
        return;

      case 'failed':
        await this.handleCiFailure(card, actions, recommendedActions);
        return;

      case 'success':
        if (mrStatus.mergeStatus === 'can_be_merged' && mrStatus.iid != null) {
          await this.attemptMerge(card, mrStatus.iid, actions);
        } else if (mrStatus.mergeStatus === 'checking') {
          this.log.debug(`seq ${seq}: merge status is 'checking', waiting`);
          actions.push({
            action: 'skip',
            entity: `seq:${seq}`,
            result: 'skip',
            message: 'Merge status checking',
          });
        } else {
          this.log.warn(`seq ${seq}: CI passed but merge status is ${mrStatus.mergeStatus}`);
          recommendedActions.push({
            action: `Check MR merge status for seq:${seq}`,
            reason: `CI passed but mergeStatus=${mrStatus.mergeStatus}`,
            severity: 'warning',
            autoExecutable: false,
            requiresConfirmation: true,
            safeToRetry: true,
          });
          actions.push({
            action: 'skip',
            entity: `seq:${seq}`,
            result: 'skip',
            message: `CI passed, mergeStatus=${mrStatus.mergeStatus}`,
          });
        }
        return;

      default:
        // Unexpected CI status
        this.log.debug(`seq ${seq}: CI status is ${mrStatus.ciStatus}, skipping`);
        actions.push({
          action: 'skip',
          entity: `seq:${seq}`,
          result: 'skip',
          message: `CI status unexpected: ${mrStatus.ciStatus}`,
        });
        return;
    }
  }

  // ─── CI Failure Self-Repair (doc 12 §4) ────────────────────────

  private async handleCiFailure(
    card: Card,
    actions: ActionRecord[],
    _recommendedActions: RecommendedAction[],
  ): Promise<void> {
    const seq = card.seq;
    const branchName = this.buildBranchName(card);
    const maxAttempts = this.ctx.config.AUTOFIX_ATTEMPTS;

    // Read autofix attempts from card meta
    let meta: Record<string, unknown>;
    try {
      meta = await this.taskBackend.metaRead(seq);
    } catch {
      meta = {};
    }

    const autofixAttempts = typeof meta.autofixAttempts === 'number' ? meta.autofixAttempts : 0;

    if (autofixAttempts < maxAttempts) {
      // Try self-repair: prefer lease/worktree evidence, then reuse or rebuild a worker slot.
      const state = this.runtimeStore.readState();
      const runtime = this.runtimeStore.getTask(seq, state);
      const slotName =
        runtime.slotName ||
        this.runtimeStore.findAvailableSlot(state);
      const slotState = slotName ? state.workers[slotName] || null : null;
      const session = slotState?.tmuxSession || null;
      const worktree = runtime.lease?.worktree || runtime.evidence?.worktree || slotState?.worktree || '';
      const isPrintMode = slotState?.mode === 'print';
      const isAcpMode =
        !!slotState &&
        (
          slotState.transport === 'acp' ||
          slotState.transport === 'pty' ||
          slotState.mode === 'acp' ||
          slotState.mode === 'pty'
        );

      if (slotName && (session || (isAcpMode && this.agentRuntime && worktree))) {
        try {
          const fixPrompt = `CI pipeline has failed. Please review the CI logs, fix the issues, commit, and push. This is autofix attempt ${autofixAttempts + 1} of ${maxAttempts}.`;

          if (isAcpMode && this.agentRuntime) {
            await this.resumeAcpWorker(
              slotName,
              seq,
              worktree,
              branchName,
              fixPrompt,
              'active',
              'closeout-autofix-resume',
            );
          } else if (isPrintMode) {
            // Print mode: spawn new process with --resume (process already exited)
            const resumeResult = await this.workerProvider.sendFix(
              session!, fixPrompt, slotState?.sessionId || undefined,
            );

            // Update state with new process info
            if (resumeResult && typeof resumeResult === 'object' && 'pid' in resumeResult) {
              this.runtimeStore.updateState('closeout-autofix-resume', (freshState) => {
                if (freshState.workers[slotName]) {
                  freshState.workers[slotName].pid = resumeResult.pid;
                  freshState.workers[slotName].outputFile = resumeResult.outputFile;
                  if (resumeResult.sessionId) {
                    freshState.workers[slotName].sessionId = resumeResult.sessionId;
                  }
                  freshState.workers[slotName].exitCode = null;
                }
              });
            }
          } else {
            // Interactive mode: send text to live tmux session
            const inspection = await this.workerProvider.inspect(session!);
            if (!inspection.alive) {
              this.log.warn(`seq ${seq}: Worker session dead, cannot autofix`);
              // Fall through to NEEDS-FIX below
              throw new Error('Worker session dead');
            }
            await this.workerProvider.sendFix(session!, fixPrompt);
          }

          // Increment counter
          await this.taskBackend.metaWrite(seq, {
            ...meta,
            autofixAttempts: autofixAttempts + 1,
          });

          this.log.info(
            `seq ${seq}: CI failed, sent fix prompt (attempt ${autofixAttempts + 1}/${maxAttempts})`,
          );
          actions.push({
            action: 'autofix',
            entity: `seq:${seq}`,
            result: 'ok',
            message: `Sent fix prompt (attempt ${autofixAttempts + 1}/${maxAttempts})`,
          });
          this.logEvent('closeout-autofix', seq, 'ok', {
            attempt: autofixAttempts + 1,
            max: maxAttempts,
          });
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(`seq ${seq}: Failed to send fix prompt: ${msg}`);
        }
      }

      // Worker session not found or dead — fall through to NEEDS-FIX
      this.log.warn(`seq ${seq}: CI failed, no live worker session for autofix`);
    } else {
      this.log.warn(
        `seq ${seq}: CI failed, autofix attempts exhausted (${autofixAttempts}/${maxAttempts})`,
      );
    }

    // Exhausted or no worker → mark NEEDS-FIX
    await this.markNeedsFix(seq, `CI failed after ${autofixAttempts} autofix attempt(s)`);
    actions.push({
      action: 'mark-needs-fix',
      entity: `seq:${seq}`,
      result: 'ok',
      message: `CI failed, autofix exhausted (${autofixAttempts}/${maxAttempts})`,
    });
    this.logEvent('closeout-ci-fail', seq, 'ok', { autofixAttempts });
  }

  // ─── Merge Attempt ─────────────────────────────────────────────

  private async attemptMerge(
    card: Card,
    iid: number,
    actions: ActionRecord[],
  ): Promise<void> {
    const seq = card.seq;
    this.log.info(`seq ${seq}: Attempting merge (iid=${iid})`);

    try {
      const mergeResult = await this.repoBackend.mergeMr(iid);

      if (mergeResult.merged) {
        this.log.ok(`seq ${seq}: MR merged successfully`);
        await this.releaseAndDone(card, actions);
      } else {
        // Merge failed
        this.log.warn(`seq ${seq}: Merge failed: ${mergeResult.error || 'unknown reason'}`);
        await this.markNeedsFix(seq, `Merge failed: ${mergeResult.error || 'unknown'}`);
        actions.push({
          action: 'mark-needs-fix',
          entity: `seq:${seq}`,
          result: 'ok',
          message: `Merge failed: ${mergeResult.error || 'unknown'}`,
        });
        this.logEvent('closeout-merge-fail', seq, 'ok', { error: mergeResult.error });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`seq ${seq}: Merge threw: ${msg}`);
      await this.markNeedsFix(seq, `Merge error: ${msg}`);
      actions.push({
        action: 'mark-needs-fix',
        entity: `seq:${seq}`,
        result: 'ok',
        message: `Merge error: ${msg}`,
      });
    }
  }

  // ─── Resource Release (01 §10.3.3) ─────────────────────────────

  /**
   * Release resources after successful merge. Each step failure MUST NOT
   * block subsequent steps — log and continue.
   *
   * Order:
   *   1. Move card to Done
   *   2. Release claim in PM
   *   3. Release worker slot in state.json (→ idle)
   *   4. Stop worker session
   *   5. Mark worktree for cleanup
   */
  private async releaseAndDone(card: Card, actions: ActionRecord[]): Promise<void> {
    const seq = card.seq;
    const errors: string[] = [];

    // Step 1: Move card to Done
    try {
      await this.taskBackend.move(seq, 'Done');
      this.log.ok(`seq ${seq}: Moved to Done`);
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

    // Step 3: Release worker slot in state.json
    const state = this.runtimeStore.readState();
    const runtime = this.runtimeStore.getTask(seq, state);
    const slotEntry = runtime.slotName && runtime.slot ? [runtime.slotName, runtime.slot] as const : null;
    let sessionName: string | null = null;

    if (slotEntry) {
      const [slotName, slotState] = slotEntry;
      sessionName = slotState.tmuxSession;
      try {
        this.runtimeStore.updateState('closeout-release', (draft) => {
          this.runtimeStore.releaseTaskProjection(draft, seq, { dropLease: true });
        });
        this.log.ok(`seq ${seq}: Worker slot ${slotName} released`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`seq ${seq}: Failed to release slot: ${msg}`);
        errors.push(`release-slot: ${msg}`);
      }
    } else {
      // No active slot found — already released (idempotency)
      // Still clean up activeCards entry if present
      if (state.activeCards[seq] || state.leases[seq]) {
        try {
          this.runtimeStore.updateState('closeout-release', (draft) => {
            this.runtimeStore.releaseTaskProjection(draft, seq, { dropLease: true });
          });
        } catch {
          // non-fatal
        }
      }
      this.log.debug(`seq ${seq}: No active worker slot found (already released)`);
    }

    // Step 4: Release worker session (keeps session alive for reuse if configured)
    if (sessionName && slotEntry?.[1].transport === 'proc') {
      try {
        await this.workerProvider.release(sessionName);
        this.log.ok(`seq ${seq}: Worker session ${sessionName} released`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`seq ${seq}: Failed to release session: ${msg}`);
        errors.push(`release-session: ${msg}`);
      }
    }

    // Step 5: Mark worktree for cleanup (actual removal runs at end of tick)
    try {
      const freshState = this.runtimeStore.readState();
      const branchName = this.buildBranchName(card);
      const worktreePath =
        runtime.lease?.worktree ||
        runtime.evidence?.worktree ||
        resolveWorktreePath(this.ctx.projectName, seq, this.ctx.config.WORKTREE_DIR);
      const cleanup = freshState.worktreeCleanup ?? [];
      const alreadyMarked = cleanup.some((e) => e.branch === branchName);
      if (!alreadyMarked) {
        cleanup.push({ branch: branchName, worktreePath, markedAt: new Date().toISOString() });
        this.runtimeStore.updateState('closeout-worktree-mark', (draft) => {
          draft.worktreeCleanup = cleanup;
        });
      }
      this.log.ok(`seq ${seq}: Worktree marked for cleanup`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`seq ${seq}: Failed to mark worktree for cleanup: ${msg}`);
      errors.push(`worktree-mark: ${msg}`);
    }

    // Notify
    if (errors.length === 0) {
      await this.notifySafe(`seq:${seq} merged and released successfully`, 'success');
    } else {
      await this.notifySafe(
        `seq:${seq} merged but release had errors: ${errors.join('; ')}`,
        'warning',
      );
    }

    // Record action
    const actionResult = errors.length === 0 ? 'ok' as const : 'fail' as const;
    actions.push({
      action: 'closeout',
      entity: `seq:${seq}`,
      result: actionResult,
      message: errors.length === 0
        ? 'Merged → Done, resources released'
        : `Merged → Done with errors: ${errors.join('; ')}`,
    });
    this.logEvent('closeout', seq, actionResult, errors.length > 0 ? { errors } : undefined);
  }

  // ─── Conflict Resolution (L1 rebase → L2 worker) ──────────────

  /**
   * Attempt to resolve merge conflict automatically.
   * L1: auto rebase + force push
   * L2: send conflict to original worker to resolve
   * Returns true if resolution was initiated (wait for next tick to verify).
   */
  private async resolveConflict(card: Card, actions: ActionRecord[]): Promise<boolean> {
    const seq = card.seq;
    const branchName = this.buildBranchName(card);
    const state = this.runtimeStore.readState();
    const runtime = this.runtimeStore.getTask(seq, state);
    const baseBranch = this.ctx.mergeBranch;

    // Find worktree for this card
    const worktree = runtime.lease?.worktree || runtime.evidence?.worktree || runtime.slot?.worktree;
    if (!worktree) {
      this.log.warn(`seq ${seq}: No worktree found for conflict resolution`);
      return false;
    }

    // ── L1: Auto rebase ──────────────────────────────────────────
    this.log.info(`seq ${seq}: L1 — attempting auto rebase onto ${baseBranch}`);
    try {
      const rebaseResult = await this.repoBackend.rebase(worktree, baseBranch);
      if (rebaseResult.success) {
        // Rebase succeeded — force push
        await this.repoBackend.push(worktree, branchName, true);
        this.log.ok(`seq ${seq}: L1 rebase succeeded, pushed with --force-with-lease`);
        await this.notifySafe(`seq:${seq} conflict auto-resolved via rebase`, 'success');
        actions.push({
          action: 'conflict-rebase',
          entity: `seq:${seq}`,
          result: 'ok',
          message: 'Auto rebase succeeded, waiting for CI re-check',
        });
        this.logEvent('conflict-rebase', seq, 'ok');
        return true;
      }

      // Rebase failed — real conflicts
      this.log.warn(
        `seq ${seq}: L1 rebase failed, conflicts in: ${(rebaseResult.conflictFiles || []).join(', ')}`,
      );
      await this.notifySafe(
        `seq:${seq} auto-rebase failed — conflict files: ${(rebaseResult.conflictFiles || []).join(', ')}`,
        'warning',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`seq ${seq}: L1 rebase threw: ${msg}`);
    }

    // ── L2: Send to original worker ──────────────────────────────
    const slotName = runtime.slotName || this.runtimeStore.findAvailableSlot(state);
    if (!slotName) return false;
    const slotState = state.workers[slotName];
    const session = slotState?.tmuxSession || null;

    const isPrintMode = slotState?.mode === 'print';
    const isAcpMode =
      !!slotState &&
      (
        slotState.transport === 'acp' ||
        slotState.transport === 'pty' ||
        slotState.mode === 'acp' ||
        slotState.mode === 'pty'
      );

    try {
      if (isAcpMode && this.agentRuntime) {
        await this.resumeAcpWorker(
          slotName,
          seq,
          worktree,
          branchName,
          [
            `There is a merge conflict on branch ${branchName} against ${baseBranch}.`,
            `Working directory: ${worktree}`,
            'Please resolve the conflict, continue the rebase/merge, and push the fixed branch.',
          ].join('\n'),
          'resolving',
          'closeout-conflict-resume',
        );
      } else if (isPrintMode) {
        if (!session) {
          this.log.warn(`seq ${seq}: No worker session for L2 conflict resolution`);
          return false;
        }
        // Print mode: spawn new process with --resume
        this.log.info(`seq ${seq}: L2 — spawning conflict resolution via --resume`);
        const resumeResult = await this.workerProvider.resolveConflict(
          session, worktree, branchName, slotState?.sessionId || undefined,
        );

        // Update state with new process info
        if (resumeResult && typeof resumeResult === 'object' && 'pid' in resumeResult) {
          this.runtimeStore.updateState('closeout-conflict-resume', (freshState) => {
            if (freshState.workers[slotName]) {
              freshState.workers[slotName].pid = resumeResult.pid;
              freshState.workers[slotName].outputFile = resumeResult.outputFile;
              if (resumeResult.sessionId) {
                freshState.workers[slotName].sessionId = resumeResult.sessionId;
              }
              freshState.workers[slotName].exitCode = null;
            }
          });
        }
      } else {
        if (!session) {
          this.log.warn(`seq ${seq}: No live worker session for interactive L2 conflict resolution`);
          return false;
        }
        // Interactive mode: send to live tmux session
        const inspection = await this.workerProvider.inspect(session);
        if (!inspection.alive) {
          this.log.warn(`seq ${seq}: Worker session dead, cannot do L2 resolution`);
          return false;
        }

        this.log.info(`seq ${seq}: L2 — sending conflict resolution to worker ${session}`);
        await this.workerProvider.resolveConflict(session, worktree, branchName);
      }

      await this.notifySafe(
        `seq:${seq} sent conflict resolution instructions to worker`,
        'info',
      );
      actions.push({
        action: 'conflict-worker',
        entity: `seq:${seq}`,
        result: 'ok',
        message: 'Sent conflict resolution to worker, waiting for fix',
      });
      this.logEvent('conflict-worker', seq, 'ok');
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`seq ${seq}: L2 conflict resolution failed: ${msg}`);
      return false;
    }
  }

  // ─── Worktree Cleanup ──────────────────────────────────────────

  /**
   * Process the worktreeCleanup queue: remove worktree directories and
   * delete local branches that have been merged.
   *
   * Each entry is processed independently — one failure does not block others.
   */
  private async cleanupWorktrees(actions: ActionRecord[]): Promise<void> {
    const state = this.runtimeStore.readState();
    const queue = state.worktreeCleanup ?? [];
    if (queue.length === 0) return;

    this.log.info(`Cleaning up ${queue.length} worktree(s)`);
    const remaining: typeof queue = [];

    for (const entry of queue) {
      try {
        await this.repoBackend.removeWorktree(
          this.ctx.paths.repoDir,
          entry.worktreePath,
          entry.branch,
        );
        this.log.ok(`Cleaned up worktree: ${entry.branch}`);
        actions.push({
          action: 'worktree-cleanup',
          entity: entry.branch,
          result: 'ok',
          message: `Removed worktree ${entry.worktreePath}`,
        });
        this.logEvent('worktree-cleanup', entry.branch, 'ok');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`Failed to clean up worktree ${entry.branch}: ${msg}`);
        remaining.push(entry); // retry next tick
        actions.push({
          action: 'worktree-cleanup',
          entity: entry.branch,
          result: 'fail',
          message: `Cleanup failed: ${msg}`,
        });
      }
    }

    // Update state with remaining entries
    this.runtimeStore.updateState('closeout-worktree-cleanup', (freshState) => {
      freshState.worktreeCleanup = remaining;
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private buildBranchName(card: Card): string {
    const slug = card.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    return `feature/${card.seq}-${slug}`;
  }

  private async markNeedsFix(seq: string, reason: string): Promise<void> {
    await this.addLabelSafe(seq, 'NEEDS-FIX');
    await this.commentSafe(seq, `NEEDS-FIX: ${reason}`);
    await this.notifySafe(`seq:${seq} marked NEEDS-FIX: ${reason}`, 'warning');
  }

  private async addLabelSafe(seq: string, label: string): Promise<void> {
    try {
      await this.taskBackend.addLabel(seq, label);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Failed to add label ${label} to seq ${seq}: ${msg}`);
    }
  }

  private async commentSafe(seq: string, text: string): Promise<void> {
    try {
      await this.taskBackend.comment(seq, text);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Failed to comment on seq ${seq}: ${msg}`);
    }
  }

  private async notifySafe(
    message: string,
    level: 'info' | 'success' | 'warning' | 'error',
  ): Promise<void> {
    if (!this.notifier) return;
    try {
      await this.notifier.send(`[${this.ctx.projectName}] ${message}`, level);
    } catch {
      // Notification failures are never fatal
    }
  }

  private async resumeAcpWorker(
    slotName: string,
    seq: string,
    worktree: string,
    branchName: string,
    prompt: string,
    slotStatus: 'active' | 'resolving',
    updatedBy: string,
  ): Promise<void> {
    if (!this.agentRuntime) {
      throw new Error('ACP runtime is not configured');
    }

    let session: ACPSessionRecord;
    try {
      session = await this.agentRuntime.resumeRun(slotName, prompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.info(
        `seq ${seq}: Agent resume unavailable for ${slotName}: ${msg}. Creating a fresh ${this.ctx.config.WORKER_TRANSPORT.toUpperCase()} session.`,
      );
      await this.agentRuntime.ensureSession(slotName, undefined, worktree);
      session = await this.agentRuntime.startRun(slotName, prompt, undefined, worktree);
    }
    this.runtimeStore.updateState(updatedBy, (state) => {
      const slot = state.workers[slotName];
      if (slot) {
        slot.status = slotStatus;
        slot.mode = this.ctx.config.WORKER_TRANSPORT === 'pty' ? 'pty' : 'acp';
        slot.transport = this.ctx.config.WORKER_TRANSPORT === 'pty' ? 'pty' : 'acp';
        slot.agent = session.tool;
        slot.tmuxSession = session.sessionName;
        slot.sessionId = session.sessionId;
        slot.runId = session.currentRun?.runId || null;
        slot.sessionState = session.sessionState;
        slot.remoteStatus = session.currentRun?.status || null;
        slot.lastEventAt = session.lastSeenAt;
        slot.lastHeartbeat = new Date().toISOString();
        slot.branch = slot.branch || branchName;
        slot.worktree = slot.worktree || worktree;
        slot.seq = parseInt(seq, 10);
        slot.pid = null;
        slot.outputFile = null;
        slot.exitCode = null;
      }
      if (state.leases[seq]) {
        state.leases[seq].slot = slotName;
        state.leases[seq].branch = branchName;
        state.leases[seq].worktree = worktree;
        state.leases[seq].sessionId = session.sessionId;
        state.leases[seq].runId = session.currentRun?.runId || null;
        state.leases[seq].phase = slotStatus === 'resolving' ? 'resolving_conflict' : 'coding';
        state.leases[seq].lastTransitionAt = new Date().toISOString();
      }
    });
  }

  private logEvent(
    action: string,
    seq: string,
    result: 'ok' | 'fail',
    meta?: Record<string, unknown>,
  ): void {
    this.log.event({
      component: 'qa',
      action,
      entity: `seq:${seq}`,
      result,
      meta,
    });
  }

  private resolveIntegrationPrompt(worktree: string): string | null {
    const promptPath = resolve(worktree, '.sps', INTEGRATION_PROMPT_FILE);
    if (existsSync(promptPath)) return promptPath;

    const legacyPromptPath = resolve(worktree, '.sps', LEGACY_TASK_PROMPT_FILE);
    if (existsSync(legacyPromptPath)) return legacyPromptPath;

    return null;
  }

  private isMergedToBase(worktree: string, branchName: string): boolean {
    try {
      execFileSync('git', ['-C', worktree, 'fetch', 'origin', this.ctx.mergeBranch], { stdio: 'ignore' });
    } catch {
      // Best effort. A stale fetch is still usable for local containment checks.
    }

    try {
      execFileSync(
        'git',
        ['-C', worktree, 'merge-base', '--is-ancestor', branchName, `origin/${this.ctx.mergeBranch}`],
        { stdio: 'ignore' },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async releaseQaSlot(seq: string, slotName: string): Promise<void> {
    this.runtimeStore.updateState('closeout-release-qa-slot', (draft) => {
      this.runtimeStore.releaseTaskProjection(draft, seq, {
        dropLease: false,
        phase: 'merging',
        keepWorktree: true,
        pmStateObserved: 'QA',
      });
    });

    try {
      await this.taskBackend.releaseClaim(seq);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`seq ${seq}: Failed to release QA claim for ${slotName}: ${msg}`);
    }
  }
}
