import type { ProjectContext } from '../core/context.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { WorkerProvider } from '../interfaces/WorkerProvider.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';
import type { CommandResult, ActionRecord, Card, RecommendedAction } from '../models/types.js';
import { readState, writeState } from '../core/state.js';
import { resolveWorktreePath } from '../core/paths.js';
import { Logger } from '../core/logger.js';

/**
 * CloseoutEngine handles the QA → merge → Done → resource release pipeline.
 *
 * Decision tree per 01 §10.3.2:
 *   QA card → check MR exists?
 *     ├─ MR not found → NEEDS-FIX
 *     └─ MR exists → check MR state
 *         ├─ already merged → resource release → Done
 *         ├─ open + CI success + can_be_merged → attempt merge
 *         ├─ open + CI failed → self-repair or NEEDS-FIX
 *         ├─ open + CI running/pending → skip
 *         ├─ open + cannot_be_merged → CONFLICT
 *         └─ closed (not merged) → NEEDS-FIX
 */
export class CloseoutEngine {
  private log: Logger;

  constructor(
    private ctx: ProjectContext,
    private taskBackend: TaskBackend,
    private repoBackend: RepoBackend,
    private workerProvider: WorkerProvider,
    private notifier?: Notifier,
    private agentRuntime: AgentRuntime | null = null,
  ) {
    this.log = new Logger('qa', ctx.projectName, ctx.paths.logsDir);
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
    const branchName = this.buildBranchName(card);

    // Check MR status
    const mrStatus = await this.repoBackend.getMrStatus(branchName);

    if (!mrStatus.exists || mrStatus.state === 'not_found') {
      // MR not found → auto-create it (worker may have pushed but not created MR)
      this.log.warn(`seq ${seq}: MR not found for branch ${branchName}, auto-creating`);
      try {
        const mrResult = await this.repoBackend.createOrUpdateMr(
          branchName,
          `${card.seq}: ${card.name}`,
          `Auto-created by CloseoutEngine for seq:${card.seq}.\n\nBranch: ${branchName}`,
        );
        this.log.ok(`seq ${seq}: Auto-created MR ${mrResult.url} (iid=${mrResult.iid})`);
        actions.push({
          action: 'auto-create-mr',
          entity: `seq:${seq}`,
          result: 'ok',
          message: `Auto-created MR (iid=${mrResult.iid})`,
        });
        this.logEvent('closeout-auto-mr', seq, 'ok', { url: mrResult.url, iid: mrResult.iid });
        // Re-check MR status and process it on next tick
        return;
      } catch (mrErr) {
        const mrMsg = mrErr instanceof Error ? mrErr.message : String(mrErr);
        this.log.error(`seq ${seq}: Failed to auto-create MR: ${mrMsg}`);
        await this.markNeedsFix(seq, `MR not found and auto-creation failed: ${mrMsg}`);
        actions.push({
          action: 'mark-needs-fix',
          entity: `seq:${seq}`,
          result: 'ok',
          message: `MR auto-creation failed: ${mrMsg}`,
        });
        this.logEvent('closeout-no-mr', seq, 'ok');
        return;
      }
    }

    // MR exists — check state
    switch (mrStatus.state) {
      case 'merged':
        // Already merged externally (doc 12 §6.2) → resource release → Done
        this.log.info(`seq ${seq}: MR already merged, proceeding to release`);
        await this.releaseAndDone(card, actions);
        return;

      case 'closed':
        // Closed without merge → NEEDS-FIX
        this.log.warn(`seq ${seq}: MR is closed (not merged)`);
        await this.markNeedsFix(seq, 'MR was closed without merging');
        actions.push({
          action: 'mark-needs-fix',
          entity: `seq:${seq}`,
          result: 'ok',
          message: 'MR closed without merge',
        });
        this.logEvent('closeout-mr-closed', seq, 'ok');
        return;

      case 'opened':
        await this.processOpenMr(card, mrStatus, actions, recommendedActions);
        return;
    }
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
      // Try self-repair: find the worker session for this card
      const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
      const slotEntry = Object.entries(state.workers).find(
        ([, w]) => w.seq === parseInt(seq, 10) && w.tmuxSession,
      );

      if (slotEntry) {
        const [slotName, slotState] = slotEntry;
        const session = slotState.tmuxSession!;
        const isPrintMode = slotState.mode === 'print';
        const isAcpMode = slotState.transport === 'acp' || slotState.mode === 'acp';

        try {
          const fixPrompt = `CI pipeline has failed. Please review the CI logs, fix the issues, commit, and push. This is autofix attempt ${autofixAttempts + 1} of ${maxAttempts}.`;

          if (isAcpMode && this.agentRuntime) {
            await this.resumeAcpWorker(
              slotName,
              seq,
              slotState.worktree || '',
              branchName,
              fixPrompt,
              'active',
              'closeout-autofix-resume',
            );
          } else if (isPrintMode) {
            // Print mode: spawn new process with --resume (process already exited)
            const resumeResult = await this.workerProvider.sendFix(
              session, fixPrompt, slotState.sessionId || undefined,
            );

            // Update state with new process info
            if (resumeResult && typeof resumeResult === 'object' && 'pid' in resumeResult) {
              const freshState = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
              if (freshState.workers[slotName]) {
                freshState.workers[slotName].pid = resumeResult.pid;
                freshState.workers[slotName].outputFile = resumeResult.outputFile;
                if (resumeResult.sessionId) {
                  freshState.workers[slotName].sessionId = resumeResult.sessionId;
                }
                freshState.workers[slotName].exitCode = null;
                writeState(this.ctx.paths.stateFile, freshState, 'closeout-autofix-resume');
              }
            }
          } else {
            // Interactive mode: send text to live tmux session
            const inspection = await this.workerProvider.inspect(session);
            if (!inspection.alive) {
              this.log.warn(`seq ${seq}: Worker session dead, cannot autofix`);
              // Fall through to NEEDS-FIX below
              throw new Error('Worker session dead');
            }
            await this.workerProvider.sendFix(session, fixPrompt);
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
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    const slotEntry = Object.entries(state.workers).find(
      ([, w]) => w.seq === parseInt(seq, 10),
    );
    let sessionName: string | null = null;

    if (slotEntry) {
      const [slotName, slotState] = slotEntry;
      sessionName = slotState.tmuxSession;
      try {
        state.workers[slotName] = {
          status: 'idle',
          seq: null,
          branch: null,
          worktree: null,
          tmuxSession: null,
          claimedAt: null,
          lastHeartbeat: null,
          mode: null,
          transport: null,
          agent: null,
          sessionId: null,
          runId: null,
          sessionState: null,
          remoteStatus: null,
          lastEventAt: null,
          pid: null,
          outputFile: null,
          exitCode: null,
        };
        delete state.activeCards[seq];
        writeState(this.ctx.paths.stateFile, state, 'closeout-release');
        this.log.ok(`seq ${seq}: Worker slot ${slotName} released`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`seq ${seq}: Failed to release slot: ${msg}`);
        errors.push(`release-slot: ${msg}`);
      }
    } else {
      // No active slot found — already released (idempotency)
      // Still clean up activeCards entry if present
      if (state.activeCards[seq]) {
        delete state.activeCards[seq];
        try {
          writeState(this.ctx.paths.stateFile, state, 'closeout-release');
        } catch {
          // non-fatal
        }
      }
      this.log.debug(`seq ${seq}: No active worker slot found (already released)`);
    }

    // Step 4: Release worker session (keeps session alive for reuse if configured)
    if (sessionName) {
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
      const freshState = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
      const branchName = this.buildBranchName(card);
      const worktreePath = resolveWorktreePath(this.ctx.projectName, seq, this.ctx.config.WORKTREE_DIR);
      const cleanup = freshState.worktreeCleanup ?? [];
      const alreadyMarked = cleanup.some((e) => e.branch === branchName);
      if (!alreadyMarked) {
        cleanup.push({ branch: branchName, worktreePath, markedAt: new Date().toISOString() });
        freshState.worktreeCleanup = cleanup;
        writeState(this.ctx.paths.stateFile, freshState, 'closeout-worktree-mark');
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
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    const baseBranch = this.ctx.mergeBranch;

    // Find worktree for this card
    const slotEntry = Object.entries(state.workers).find(
      ([, w]) => w.seq === parseInt(seq, 10),
    );
    const worktree = slotEntry?.[1]?.worktree;
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
    if (!slotEntry) return false;
    const [slotName, slotState] = slotEntry;
    const session = slotState.tmuxSession;
    if (!session) {
      this.log.warn(`seq ${seq}: No worker session for L2 conflict resolution`);
      return false;
    }

    const isPrintMode = slotState.mode === 'print';
    const isAcpMode = slotState.transport === 'acp' || slotState.mode === 'acp';

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
        // Print mode: spawn new process with --resume
        this.log.info(`seq ${seq}: L2 — spawning conflict resolution via --resume`);
        const resumeResult = await this.workerProvider.resolveConflict(
          session, worktree, branchName, slotState.sessionId || undefined,
        );

        // Update state with new process info
        if (resumeResult && typeof resumeResult === 'object' && 'pid' in resumeResult) {
          const freshState = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
          if (freshState.workers[slotName]) {
            freshState.workers[slotName].pid = resumeResult.pid;
            freshState.workers[slotName].outputFile = resumeResult.outputFile;
            if (resumeResult.sessionId) {
              freshState.workers[slotName].sessionId = resumeResult.sessionId;
            }
            freshState.workers[slotName].exitCode = null;
            writeState(this.ctx.paths.stateFile, freshState, 'closeout-conflict-resume');
          }
        }
      } else {
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
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
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
    const freshState = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    freshState.worktreeCleanup = remaining;
    writeState(this.ctx.paths.stateFile, freshState, 'closeout-worktree-cleanup');
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

    const session = await this.agentRuntime.resumeRun(slotName, prompt);
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    const slot = state.workers[slotName];
    if (slot) {
      slot.status = slotStatus;
      slot.mode = 'acp';
      slot.transport = 'acp';
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
      slot.pid = null;
      slot.outputFile = null;
      slot.exitCode = null;
    }
    writeState(this.ctx.paths.stateFile, state, updatedBy);
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
}
