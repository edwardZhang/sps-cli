import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectContext } from '../core/context.js';
import { resolveWorkflowTransport } from '../core/config.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { CommandResult, ActionRecord, Card, RecommendedAction } from '../models/types.js';
import type { WorkerManager, TaskRunRequest } from '../manager/worker-manager.js';
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
    private workerManager: WorkerManager,
    private notifier?: Notifier,
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

    const snapshots = this.workerManager.inspect({ taskId: String(card.seq) });
    if (snapshots.length === 0) return 'idle';

    const snapshot = snapshots[0];

    if (snapshot.state === 'idle') return 'idle';

    if (snapshot.state === 'waiting_input') {
      this.log.info(`seq ${card.seq}: integration worker waiting for input — ${snapshot.pendingInput?.prompt || 'input required'}`);
      actions.push({
        action: 'qa-waiting',
        entity: `seq:${card.seq}`,
        result: 'skip',
        message: 'Integration worker waiting_input',
      });
      return 'waiting';
    }

    if (snapshot.state === 'needs_confirmation') {
      this.log.warn(`seq ${card.seq}: integration worker needs confirmation — ${snapshot.pendingInput?.prompt || 'confirmation required'}`);
      actions.push({
        action: 'qa-waiting',
        entity: `seq:${card.seq}`,
        result: 'skip',
        message: 'Integration worker needs_confirmation',
      });
      return 'waiting';
    }

    if (snapshot.state === 'starting' || snapshot.state === 'running') {
      actions.push({
        action: 'qa-running',
        entity: `seq:${card.seq}`,
        result: 'skip',
        message: `Integration worker ${snapshot.state}`,
      });
      return 'active';
    }

    if (snapshot.state === 'completed') {
      if (this.isMergedToBase(worktree, branchName)) {
        await this.releaseAndDone(card, actions);
        return 'done';
      }
    }

    // 'failed' or 'completed' without merge
    await this.releaseQaSlot(card.seq, slotName);
    await this.markNeedsFix(card.seq, `Integration worker ${snapshot.state} before merge completed`);
    actions.push({
      action: 'mark-needs-fix',
      entity: `seq:${card.seq}`,
      result: 'ok',
      message: `Integration worker ${snapshot.state} before merge completed`,
    });
    return 'failed';
  }

  private async startIntegrationWorker(
    card: Card,
    _preferredSlot: string | null,
    worktree: string,
    branchName: string,
    actions: ActionRecord[],
  ): Promise<void> {
    const seq = card.seq;

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

    const prompt = readFileSync(promptFile, 'utf-8').trim();
    const workflowTransport = resolveWorkflowTransport(this.ctx.config);
    const logsDir = this.ctx.paths.logsDir;

    const runRequest: TaskRunRequest = {
      taskId: String(card.seq),
      cardId: String(card.seq),
      project: this.ctx.projectName,
      phase: 'integration',
      prompt,
      cwd: worktree,
      branch: branchName,
      targetBranch: this.ctx.mergeBranch,
      tool: (this.ctx.config.ACP_AGENT || this.ctx.config.WORKER_TOOL) as 'claude' | 'codex',
      transport: workflowTransport === 'pty' ? 'pty' : 'proc',
      outputFile: resolve(logsDir, `${this.ctx.projectName}-integration-${card.seq}-${Date.now()}.jsonl`),
    };

    const response = await this.workerManager.run(runRequest);
    if (!response.accepted) {
      this.log.info(`seq ${seq}: WM rejected integration run: ${response.rejectReason ?? 'unknown'}`);
      actions.push({
        action: 'qa-launch',
        entity: `seq:${seq}`,
        result: 'skip',
        message: `WM rejected: ${response.rejectReason ?? 'unknown'}`,
      });
      return;
    }

    // Queued in IntegrationQueue — no slot yet, will be spawned when active finishes
    if (response.queued) {
      this.log.info(`seq ${seq}: Queued for integration (position=${response.queuePosition})`);
      actions.push({
        action: 'qa-launch',
        entity: `seq:${seq}`,
        result: 'ok',
        message: `Queued for integration (position=${response.queuePosition})`,
      });
      return;
    }

    // PM claim (best-effort, non-blocking)
    const slotName = response.slot!;
    try {
      await this.taskBackend.claim(seq, slotName);
    } catch (err) {
      this.log.warn(`seq ${seq}: PM claim for QA worker failed: ${err instanceof Error ? err.message : err}`);
    }

    // Update local runtime projections with the slot WM allocated
    this.runtimeStore.updateState('closeout-launch-integration', (draft) => {
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
        sessionId: response.sessionId || null,
        runId: null,
        claimedAt: new Date().toISOString(),
        retryCount: draft.leases[seq]?.retryCount ?? 0,
        lastTransitionAt: new Date().toISOString(),
      };
    });

    actions.push({
      action: 'qa-launch',
      entity: `seq:${seq}`,
      result: 'ok',
      message: `Started integration worker on ${slotName}`,
    });
    this.logEvent('qa-launch', seq, 'ok', { worker: slotName });
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

    if (slotEntry) {
      const [slotName] = slotEntry;
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

    // Step 4: Cancel worker via WM (idempotent, safe for already-completed workers)
    try {
      await this.workerManager.cancel({ taskId: seq, project: this.ctx.projectName, reason: 'user_cancel' });
      this.log.ok(`seq ${seq}: Worker cancelled via WorkerManager`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`seq ${seq}: Failed to cancel worker: ${msg}`);
      errors.push(`cancel-worker: ${msg}`);
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
    try {
      await this.workerManager.cancel({ taskId: seq, project: this.ctx.projectName, reason: 'anomaly' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`seq ${seq}: WM cancel in releaseQaSlot failed: ${msg}`);
    }

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
