/**
 * PostActions — executes the full post-completion/failure chain.
 *
 * Called immediately from Supervisor exit callback → CompletionJudge → here.
 *
 * v0.19: Merges are serialized via MergeMutex (per-project). Workers code
 * in parallel but merge one at a time. If merge conflicts, L2 spawns a
 * --resume worker to resolve conflicts before retrying.
 */
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { readState, writeState } from '../core/state.js';
import { isProcessAlive } from '../providers/outputParser.js';
import type { CompletionResult } from './completion-judge.js';
import type { PMClient } from './pm-client.js';
import type { ProcessSupervisor, SpawnOpts } from './supervisor.js';
import type { ResourceLimiter } from './resource-limiter.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { MergeMutex } from './merge-mutex.js';
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';
import type { ACPRunStatus, ACPSessionRecord } from '../models/acp.js';

// ─── Types ──────────────────────────────────────────────────────

export interface PostActionContext {
  project: string;
  seq: string;
  slot: string;
  transport: 'proc' | 'acp';
  branch: string;
  worktree: string;
  baseBranch: string;
  stateFile: string;
  maxWorkers: number;
  mrMode: 'none' | 'create';
  gitlabProjectId: string;
  gitlabUrl: string;
  gitlabToken: string;
  /** Plane state UUID for Done (or Trello list ID) */
  doneStateId: string;
  maxRetries: number;
  logsDir: string;
  tool: 'claude' | 'codex';
}

interface StepResult {
  step: string;
  ok: boolean;
  error?: string;
}

/** Max merge conflict resolution retries (L2 cycles) */
const MAX_MERGE_RETRIES = 2;

/** How often to check if resume worker has exited (ms) */
const PID_POLL_INTERVAL = 3000;

/** Max time to wait for a resume worker to exit (ms) */
const RESOLVE_TIMEOUT = 300_000; // 5 minutes

// ─── PostActions ────────────────────────────────────────────────

export class PostActions {
  constructor(
    private readonly pmClient: PMClient,
    private readonly supervisor: ProcessSupervisor,
    private readonly resourceLimiter: ResourceLimiter,
    private readonly notifier: Notifier | null,
    private readonly mergeMutex?: MergeMutex,
    private readonly agentRuntime: AgentRuntime | null = null,
  ) {}

  /**
   * Handle worker completion — serial merge + PM update + release + notify.
   */
  async executeCompletion(
    ctx: PostActionContext,
    completion: CompletionResult,
    sessionId: string | null,
  ): Promise<StepResult[]> {
    const results: StepResult[] = [];

    // ── Phase 1: Set slot to "merging" ──────────────────────────
    this.setSlotStatus(ctx, 'merging');

    // ── Phase 2: Serial merge (via MergeMutex) ──────────────────
    let mergeOk = false;
    if (ctx.mrMode === 'none') {
      if (this.mergeMutex) {
        await this.mergeMutex.acquire();
      }
      try {
        mergeOk = await this.serialMerge(ctx, sessionId, results);
      } finally {
        if (this.mergeMutex) {
          this.mergeMutex.release();
        }
      }
    } else {
      results.push(await this.createMR(ctx));
      mergeOk = results[results.length - 1].ok;
    }

    if (!mergeOk) {
      // Merge failed after all retries — release and bail
      results.push(await this.releaseSlot(ctx));
      this.resourceLimiter.release();
      const workerId = `${ctx.project}:${ctx.slot}:${ctx.seq}`;
      this.supervisor.remove(workerId);
      return results;
    }

    // ── Phase 3: Post-merge cleanup ─────────────────────────────
    results.push(await this.pmMove(ctx));
    results.push(await this.releaseSlot(ctx));
    results.push(await this.pmReleaseClaim(ctx));
    results.push(await this.markWorktreeCleanup(ctx));
    results.push(await this.archiveKnowledge(ctx));
    results.push(await this.notify(
      ctx,
      `seq:${ctx.seq} completed (${completion.reason}), merged to ${ctx.baseBranch}`,
      'success',
    ));

    this.resourceLimiter.release();
    const workerId = `${ctx.project}:${ctx.slot}:${ctx.seq}`;
    this.supervisor.remove(workerId);

    return results;
  }

  /**
   * Handle worker failure — retry or mark NEEDS-FIX.
   */
  async executeFailure(
    ctx: PostActionContext,
    completion: CompletionResult,
    exitCode: number,
    sessionId: string | null,
    retryCount: number,
    /** Original spawn options for retry */
    respawnOpts?: Partial<SpawnOpts>,
  ): Promise<StepResult[]> {
    const results: StepResult[] = [];

    if (retryCount < ctx.maxRetries) {
      if (ctx.transport === 'acp' && this.agentRuntime) {
        results.push(await this.pmComment(
          ctx,
          `Worker ${completion.reason} (exit ${exitCode}). Retry #${retryCount + 1} on the same ACP session...`,
        ));

        const respawnResult = await this.respawnAcp(ctx, retryCount);
        results.push(respawnResult);
        if (respawnResult.ok) {
          return results;
        }
      } else if (sessionId) {
        // Release old worker resources BEFORE respawning
        this.resourceLimiter.release();
        const workerId = `${ctx.project}:${ctx.slot}:${ctx.seq}`;
        this.supervisor.remove(workerId);

        // Retry with --resume
        results.push(await this.pmComment(
          ctx,
          `Worker ${completion.reason} (exit ${exitCode}). Retry #${retryCount + 1} with --resume...`,
        ));

        const respawnResult = await this.respawn(ctx, sessionId, retryCount, respawnOpts);
        results.push(respawnResult);
        if (respawnResult.ok) {
          return results;
        }
      }
    }

    // Retries exhausted or retry launch failed → NEEDS-FIX
    results.push(await this.pmAddLabel(ctx, 'NEEDS-FIX'));
    results.push(await this.pmComment(
      ctx,
      `Worker ${completion.reason} (exit ${exitCode}). Retries exhausted (${retryCount}/${ctx.maxRetries}).`,
    ));
    results.push(await this.releaseSlot(ctx));
    results.push(await this.notify(
      ctx,
      `seq:${ctx.seq} FAILED — ${completion.reason}, retries exhausted`,
      'error',
    ));

    this.resourceLimiter.release();
    const workerId = `${ctx.project}:${ctx.slot}:${ctx.seq}`;
    this.supervisor.remove(workerId);

    return results;
  }

  // ─── Serial Merge with L0/L1/L2/L3 ────────────────────────────

  /**
   * Attempt to merge the feature branch into the target branch.
   * Called while holding the MergeMutex — only one merge at a time per project.
   *
   * L0: fetch + rebase + merge (pure git, no AI)
   * L1: rebase failed — abort and retry rebase (in case of transient issue)
   * L2: rebase has real conflicts — spawn --resume Worker to resolve
   * L3: all retries exhausted — mark CONFLICT
   *
   * Returns true if merge succeeded, false if all attempts failed.
   */
  private async serialMerge(
    ctx: PostActionContext,
    sessionId: string | null,
    results: StepResult[],
  ): Promise<boolean> {
    // L0: Try direct merge (rebase + merge)
    const l0Result = this.tryRebaseMerge(ctx);
    if (l0Result.ok) {
      this.log(`L0: Merged ${ctx.branch} → ${ctx.baseBranch}`);
      results.push({ step: 'merge-l0', ok: true });
      return true;
    }

    this.log(`L0: Merge failed for ${ctx.branch}: ${l0Result.error}`);

    // Abort any in-progress rebase before L2
    this.abortRebase(ctx.worktree);

    // L2: Spawn --resume Worker to resolve conflicts
    if (ctx.transport !== 'acp' && !sessionId) {
      this.log(`L2: No sessionId for ${ctx.branch}, cannot spawn resume worker`);
      results.push({ step: 'merge-l0', ok: false, error: l0Result.error });
      await this.markConflict(ctx, results, `Merge conflict, no session to resume`);
      return false;
    }

    for (let attempt = 0; attempt < MAX_MERGE_RETRIES; attempt++) {
      this.log(`L2: Attempt ${attempt + 1}/${MAX_MERGE_RETRIES} — spawning resume worker for ${ctx.branch}`);

      // Update slot status to "resolving"
      this.setSlotStatus(ctx, 'resolving');

      // Release mutex while AI works (so other completed workers aren't blocked indefinitely)
      if (this.mergeMutex) this.mergeMutex.release();

      // Spawn resume worker and wait for exit
      const resolveResult = ctx.transport === 'acp'
        ? await this.spawnAcpConflictResolver(ctx, attempt)
        : await this.spawnConflictResolver(ctx, sessionId!, attempt);

      // Re-acquire mutex for merge retry
      if (this.mergeMutex) await this.mergeMutex.acquire();

      // Update slot back to "merging"
      this.setSlotStatus(ctx, 'merging');

      if (!resolveResult.ok) {
        this.log(`L2: Resume worker failed: ${resolveResult.error}`);
        results.push({ step: `merge-l2-attempt-${attempt + 1}`, ok: false, error: resolveResult.error });
        continue;
      }

      // Retry L0 after conflict resolution
      const retryResult = this.tryRebaseMerge(ctx);
      if (retryResult.ok) {
        this.log(`L2: Merge succeeded after conflict resolution (attempt ${attempt + 1})`);
        results.push({ step: `merge-l2-attempt-${attempt + 1}`, ok: true });
        return true;
      }

      this.log(`L2: Merge still fails after resolution attempt ${attempt + 1}: ${retryResult.error}`);
      this.abortRebase(ctx.worktree);
      results.push({ step: `merge-l2-attempt-${attempt + 1}`, ok: false, error: retryResult.error });
    }

    // L3: All retries exhausted
    await this.markConflict(ctx, results, `Merge conflict after ${MAX_MERGE_RETRIES} resolution attempts`);
    return false;
  }

  /**
   * Try rebase + merge (L0). Returns { ok, error }.
   */
  private tryRebaseMerge(ctx: PostActionContext): { ok: boolean; error?: string } {
    let mergeWorktree: string | null = null;
    try {
      const { worktree, branch, baseBranch } = ctx;

      // Fetch latest target
      try {
        execFileSync('git', ['-C', worktree, 'fetch', 'origin', baseBranch, '--quiet'], {
          timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { /* offline ok */ }

      // Checkout feature branch (may be on baseBranch from previous merge attempt)
      try {
        execFileSync('git', ['-C', worktree, 'checkout', branch], {
          timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { /* already on branch */ }

      // Rebase feature onto latest target
      execFileSync('git', ['-C', worktree, 'rebase', `origin/${baseBranch}`], {
        timeout: 30_000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Force push rebased feature
      execFileSync('git', ['-C', worktree, 'push', '--force-with-lease', 'origin', branch], {
        timeout: 30_000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Final integration happens in a temporary detached merge worktree so we do
      // not touch the user's main working copy or hit "branch already in use".
      const repoDir = this.resolveRepoDir(worktree);
      mergeWorktree = this.createMergeWorktree(repoDir, ctx);

      execFileSync('git', ['-C', mergeWorktree, 'fetch', 'origin', '--quiet'], {
        timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      execFileSync('git', ['-C', mergeWorktree, 'reset', '--hard', `origin/${baseBranch}`], {
        timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      execFileSync('git', ['-C', mergeWorktree, 'merge', '--no-ff', `origin/${branch}`, '-m',
        `Merge ${branch} into ${baseBranch}`], {
        timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      execFileSync('git', ['-C', mergeWorktree, 'push', 'origin', `HEAD:${baseBranch}`], {
        timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
      });

      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      this.cleanupMergeWorktree(mergeWorktree);
    }
  }

  /**
   * Abort any in-progress rebase.
   */
  private abortRebase(worktree: string): void {
    try {
      execFileSync('git', ['-C', worktree, 'rebase', '--abort'], {
        timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { /* no rebase in progress */ }
  }

  /**
   * Spawn a --resume worker to resolve merge conflicts.
   * Waits for the worker to exit before returning.
   */
  private async spawnConflictResolver(
    ctx: PostActionContext,
    sessionId: string,
    attempt: number,
  ): Promise<{ ok: boolean; error?: string }> {
    const workerId = `${ctx.project}:${ctx.slot}:${ctx.seq}`;
    const outputFile = resolve(
      ctx.logsDir,
      `${ctx.project}-${ctx.slot}-conflict-${attempt + 1}-${Date.now()}.jsonl`,
    );

    const instruction = [
      `There is a merge conflict on branch ${ctx.branch} when rebasing onto origin/${ctx.baseBranch}.`,
      `Working directory: ${ctx.worktree}`,
      '',
      'Please resolve the conflict:',
      `1. Run: cd ${ctx.worktree}`,
      `2. Run: git fetch origin && git checkout ${ctx.branch}`,
      `3. Run: git rebase origin/${ctx.baseBranch}`,
      '4. For each conflicting file: open it, understand both sides, resolve the conflict',
      '5. Run: git add <resolved-files> && git rebase --continue',
      '6. Run: git push --force-with-lease origin ' + ctx.branch,
      '7. Say "done"',
      '',
      'You have full context from the previous coding session. Use it to make correct conflict resolution decisions.',
    ].join('\n');

    // Remove old supervisor tracking before respawning
    this.supervisor.remove(workerId);

    // Release + re-acquire global resource for the resume worker
    this.resourceLimiter.release();
    const acquire = this.resourceLimiter.tryAcquireDetailed();
    if (!acquire.acquired) {
      return { ok: false, error: 'Global resource limit reached for conflict resolver' };
    }

    try {
      // Spawn and capture PID via Promise-based exit wait
      let spawnedPid = 0;

      const exitPromise = new Promise<number>((resolveExit) => {
        const handle = this.supervisor.spawn({
          id: workerId,
          project: ctx.project,
          seq: ctx.seq,
          slot: ctx.slot,
          worktree: ctx.worktree,
          branch: ctx.branch,
          prompt: instruction,
          outputFile,
          tool: ctx.tool,
          resumeSessionId: sessionId,
          onExit: async (exitCode: number) => {
            resolveExit(exitCode);
          },
        });
        spawnedPid = handle.pid ?? 0;
      });

      // Update state with new PID
      const state = readState(ctx.stateFile, ctx.maxWorkers);
      if (state.workers[ctx.slot]) {
        state.workers[ctx.slot].pid = spawnedPid;
        state.workers[ctx.slot].outputFile = outputFile;
        state.workers[ctx.slot].exitCode = null;
        state.workers[ctx.slot].mergeRetries = (state.workers[ctx.slot].mergeRetries ?? 0) + 1;
      }
      writeState(ctx.stateFile, state, 'post-actions-conflict-resolve');

      this.log(`Spawned conflict resolver for ${workerId} (pid=${spawnedPid})`);

      // Wait for the resume worker to exit (with timeout)
      const exitCode = await Promise.race([
        exitPromise,
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('Conflict resolver timed out')), RESOLVE_TIMEOUT)
        ),
      ]);

      this.supervisor.remove(workerId);

      if (exitCode === 0) {
        this.log(`Conflict resolver exited successfully (pid=${spawnedPid})`);
        return { ok: true };
      } else {
        return { ok: false, error: `Conflict resolver exited with code ${exitCode}` };
      }
    } catch (err) {
      this.resourceLimiter.release();
      this.supervisor.remove(workerId);
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private async spawnAcpConflictResolver(
    ctx: PostActionContext,
    attempt: number,
  ): Promise<{ ok: boolean; error?: string }> {
    if (!this.agentRuntime) {
      return { ok: false, error: 'ACP runtime is not configured' };
    }

    const instruction = [
      `There is a merge conflict on branch ${ctx.branch} when rebasing onto origin/${ctx.baseBranch}.`,
      `Working directory: ${ctx.worktree}`,
      '',
      'Please resolve the conflict:',
      `1. Run: cd ${ctx.worktree}`,
      `2. Run: git fetch origin && git checkout ${ctx.branch}`,
      `3. Run: git rebase origin/${ctx.baseBranch}`,
      '4. For each conflicting file: open it, understand both sides, resolve the conflict',
      '5. Run: git add <resolved-files> && git rebase --continue',
      '6. Run: git push --force-with-lease origin ' + ctx.branch,
      '7. Say "done"',
      '',
      'You are resuming the same task session. Use the existing context to make correct conflict resolution decisions.',
    ].join('\n');

    try {
      const session = await this.agentRuntime.resumeRun(ctx.slot, instruction);
      this.syncAcpRuntimeState(ctx, session, 'resolving', 'post-actions-conflict-resume', {
        mergeRetryIncrement: true,
      });
      this.log(
        `Spawned ACP conflict resolver for ${ctx.project}:${ctx.slot}:${ctx.seq} ` +
        `(run=${session.currentRun?.runId || 'unknown'})`,
      );

      const completed = await this.waitForAcpRun(
        ctx,
        session.currentRun?.runId || null,
        RESOLVE_TIMEOUT,
        'resolving',
      );
      if (!completed.currentRun) {
        return { ok: false, error: 'ACP conflict resolver finished without a run record' };
      }
      if (completed.currentRun.status === 'completed') {
        return { ok: true };
      }
      return { ok: false, error: `ACP conflict resolver ended with ${completed.currentRun.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Mark a card with CONFLICT label and comment.
   */
  private async markConflict(
    ctx: PostActionContext,
    results: StepResult[],
    reason: string,
  ): Promise<void> {
    this.log(`L3: Giving up on ${ctx.branch}: ${reason}`);
    try { await this.pmClient.addLabel(ctx.seq, 'CONFLICT'); } catch { /* best effort */ }
    try { await this.pmClient.comment(ctx.seq, `Auto-merge failed: ${reason}`); } catch { /* best effort */ }
    results.push(await this.notify(ctx, `seq:${ctx.seq} CONFLICT — ${reason}`, 'error'));
    results.push({ step: 'merge-conflict', ok: false, error: reason });
  }

  /**
   * Update slot status in state.json.
   */
  private setSlotStatus(ctx: PostActionContext, status: 'merging' | 'resolving'): void {
    try {
      const state = readState(ctx.stateFile, ctx.maxWorkers);
      if (state.workers[ctx.slot]) {
        state.workers[ctx.slot].status = status;
        if (status === 'merging' && !state.workers[ctx.slot].completedAt) {
          state.workers[ctx.slot].completedAt = new Date().toISOString();
        }
      }
      writeState(ctx.stateFile, state, `post-actions-${status}`);
    } catch { /* best effort */ }
  }

  // ─── Individual Steps (unchanged) ──────────────────────────────

  private async createMR(ctx: PostActionContext): Promise<StepResult> {
    try {
      const { branch, baseBranch, seq, gitlabProjectId, gitlabUrl, gitlabToken } = ctx;
      const title = `${seq}: Merge ${branch}`;
      const res = await fetch(
        `${gitlabUrl}/api/v4/projects/${gitlabProjectId}/merge_requests`,
        {
          method: 'POST',
          headers: { 'PRIVATE-TOKEN': gitlabToken, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source_branch: branch,
            target_branch: baseBranch,
            title,
          }),
        },
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`GitLab MR creation failed (${res.status}): ${text}`);
      }
      this.log(`Created MR for ${branch}`);
      return { step: 'create-mr', ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`MR creation failed: ${msg}`);
      return { step: 'create-mr', ok: false, error: msg };
    }
  }

  private async pmMove(ctx: PostActionContext): Promise<StepResult> {
    try {
      await this.pmClient.move(ctx.seq, ctx.doneStateId);
      return { step: 'pm-move-done', ok: true };
    } catch (err) {
      return { step: 'pm-move-done', ok: false, error: String(err) };
    }
  }

  private async releaseSlot(ctx: PostActionContext): Promise<StepResult> {
    try {
      const state = readState(ctx.stateFile, ctx.maxWorkers);
      if (state.workers[ctx.slot]) {
        state.workers[ctx.slot] = {
          status: 'idle', seq: null, branch: null, worktree: null,
          tmuxSession: null, claimedAt: null, lastHeartbeat: null,
          mode: null, transport: null, agent: null,
          sessionId: null, runId: null, sessionState: null, remoteStatus: null, lastEventAt: null,
          pid: null, outputFile: null, exitCode: null,
          mergeRetries: 0, completedAt: null,
        };
      }
      delete state.activeCards[ctx.seq];
      writeState(ctx.stateFile, state, 'post-actions-release');
      return { step: 'release-slot', ok: true };
    } catch (err) {
      return { step: 'release-slot', ok: false, error: String(err) };
    }
  }

  private async pmReleaseClaim(ctx: PostActionContext): Promise<StepResult> {
    try {
      await this.pmClient.releaseClaim(ctx.seq);
      return { step: 'pm-release-claim', ok: true };
    } catch (err) {
      return { step: 'pm-release-claim', ok: false, error: String(err) };
    }
  }

  private async markWorktreeCleanup(ctx: PostActionContext): Promise<StepResult> {
    try {
      const state = readState(ctx.stateFile, ctx.maxWorkers);
      const cleanup = state.worktreeCleanup ?? [];
      if (!cleanup.some(e => e.branch === ctx.branch)) {
        cleanup.push({
          branch: ctx.branch,
          worktreePath: ctx.worktree,
          markedAt: new Date().toISOString(),
        });
        state.worktreeCleanup = cleanup;
        writeState(ctx.stateFile, state, 'post-actions-cleanup');
      }
      return { step: 'mark-worktree-cleanup', ok: true };
    } catch (err) {
      return { step: 'mark-worktree-cleanup', ok: false, error: String(err) };
    }
  }

  private async archiveKnowledge(ctx: PostActionContext): Promise<StepResult> {
    try {
      const diffStat = safeExec('git', [
        '-C', ctx.worktree, 'diff', '--stat',
        `origin/${ctx.baseBranch}...${ctx.branch}`,
      ]);
      const commits = safeExec('git', [
        '-C', ctx.worktree, 'log', '--oneline',
        `origin/${ctx.baseBranch}..${ctx.branch}`,
      ]);

      const archiveFile = resolve(ctx.logsDir, 'task-archive.jsonl');
      mkdirSync(resolve(ctx.logsDir), { recursive: true });

      const entry = {
        ts: new Date().toISOString(),
        seq: ctx.seq,
        branch: ctx.branch,
        commits: commits.split('\n').filter(Boolean),
        filesChanged: diffStat.trim(),
      };
      appendFileSync(archiveFile, JSON.stringify(entry) + '\n');
      return { step: 'archive-knowledge', ok: true };
    } catch (err) {
      return { step: 'archive-knowledge', ok: false, error: String(err) };
    }
  }

  private async respawn(
    ctx: PostActionContext,
    sessionId: string,
    retryCount: number,
    respawnOpts?: Partial<SpawnOpts>,
  ): Promise<StepResult> {
    try {
      const workerId = `${ctx.project}:${ctx.slot}:${ctx.seq}`;
      const resumePrompt = [
        'The previous attempt did not fully complete. Please continue where you left off.',
        'Check the current state of the code, and complete any remaining steps.',
        'Remember to push your changes when done.',
      ].join('\n');

      const outputFile = resolve(
        ctx.logsDir,
        `${ctx.project}-${ctx.slot}-retry${retryCount + 1}-${Date.now()}.jsonl`,
      );

      const acquire = this.resourceLimiter.tryAcquireDetailed();
      if (!acquire.acquired) {
        const reason = this.resourceLimiter.formatBlockReason(acquire.stats);
        this.log(`Cannot respawn ${workerId}: global resource limit reached: ${reason}`);
        return { step: 'respawn', ok: false, error: `Global resource limit reached: ${reason}` };
      }

      this.supervisor.spawn({
        id: workerId,
        project: ctx.project,
        seq: ctx.seq,
        slot: ctx.slot,
        worktree: ctx.worktree,
        branch: ctx.branch,
        prompt: resumePrompt,
        outputFile,
        tool: ctx.tool,
        resumeSessionId: sessionId,
        onExit: respawnOpts?.onExit || (async () => {}),
        ...respawnOpts,
      });

      const state = readState(ctx.stateFile, ctx.maxWorkers);
      const card = state.activeCards[ctx.seq];
      if (card) {
        card.retryCount = retryCount + 1;
        writeState(ctx.stateFile, state, 'post-actions-retry');
      }

      this.log(`Respawned ${workerId} with --resume (retry #${retryCount + 1})`);
      return { step: 'respawn', ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Respawn failed: ${msg}`);
      this.resourceLimiter.release();
      return { step: 'respawn', ok: false, error: msg };
    }
  }

  private async respawnAcp(
    ctx: PostActionContext,
    retryCount: number,
  ): Promise<StepResult> {
    if (!this.agentRuntime) {
      return { step: 'respawn-acp', ok: false, error: 'ACP runtime is not configured' };
    }

    try {
      const resumePrompt = [
        'The previous attempt did not fully complete. Please continue where you left off.',
        'Check the current state of the code, and complete any remaining steps.',
        'Remember to push your changes when done.',
      ].join('\n');

      const session = await this.agentRuntime.resumeRun(ctx.slot, resumePrompt);
      this.syncAcpRuntimeState(ctx, session, 'active', 'post-actions-retry-acp', {
        retryCount: retryCount + 1,
      });

      this.log(
        `Respawned ${ctx.project}:${ctx.slot}:${ctx.seq} on ACP session ${session.sessionId} ` +
        `(retry #${retryCount + 1})`,
      );
      return { step: 'respawn-acp', ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`ACP respawn failed: ${msg}`);
      return { step: 'respawn-acp', ok: false, error: msg };
    }
  }

  private async pmComment(ctx: PostActionContext, text: string): Promise<StepResult> {
    try {
      await this.pmClient.comment(ctx.seq, text);
      return { step: 'pm-comment', ok: true };
    } catch (err) {
      return { step: 'pm-comment', ok: false, error: String(err) };
    }
  }

  private async pmAddLabel(ctx: PostActionContext, label: string): Promise<StepResult> {
    try {
      await this.pmClient.addLabel(ctx.seq, label);
      return { step: 'pm-add-label', ok: true };
    } catch (err) {
      return { step: 'pm-add-label', ok: false, error: String(err) };
    }
  }

  private async notify(
    ctx: PostActionContext,
    message: string,
    level: 'success' | 'info' | 'error',
  ): Promise<StepResult> {
    if (!this.notifier) return { step: 'notify', ok: true };
    try {
      const fullMsg = `[${ctx.project}] ${message}`;
      if (level === 'success') await this.notifier.sendSuccess(fullMsg);
      else if (level === 'error') await this.notifier.sendWarning(fullMsg);
      else await this.notifier.send(fullMsg, 'info');
      return { step: 'notify', ok: true };
    } catch (err) {
      return { step: 'notify', ok: false, error: String(err) };
    }
  }

  private log(msg: string): void {
    process.stderr.write(`[post-actions] ${msg}\n`);
  }

  private resolveRepoDir(worktree: string): string {
    const commonDir = execFileSync('git', ['-C', worktree, 'rev-parse', '--git-common-dir'], {
      timeout: 10_000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    const absCommonDir = commonDir.startsWith('/') ? commonDir : resolve(worktree, commonDir);
    return dirname(absCommonDir);
  }

  private createMergeWorktree(repoDir: string, ctx: PostActionContext): string {
    const mergeRoot = mkdtempSync(resolve(tmpdir(), `sps-merge-${ctx.project}-${ctx.seq}-`));
    execFileSync('git', ['-C', repoDir, 'worktree', 'add', '--detach', mergeRoot, `origin/${ctx.baseBranch}`], {
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return mergeRoot;
  }

  private cleanupMergeWorktree(mergeWorktree: string | null): void {
    if (!mergeWorktree) return;
    let repoDir: string | null = null;
    try {
      repoDir = this.resolveRepoDir(mergeWorktree);
    } catch {
      repoDir = null;
    }
    try {
      execFileSync('git', ['-C', repoDir || mergeWorktree, 'worktree', 'remove', '--force', mergeWorktree], {
        timeout: 10_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      try {
        rmSync(mergeWorktree, { recursive: true, force: true });
      } catch {
        // best effort
      }
      if (repoDir) {
        try {
          execFileSync('git', ['-C', repoDir, 'worktree', 'prune'], {
            timeout: 10_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch {
          // best effort
        }
      } else {
        try {
          execFileSync('git', ['-C', mergeWorktree, 'worktree', 'prune'], {
            timeout: 10_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch {
          // best effort
        }
      }
    }
  }

  private syncAcpRuntimeState(
    ctx: PostActionContext,
    session: ACPSessionRecord,
    slotStatus: 'active' | 'resolving' | 'merging',
    updatedBy: string,
    options?: { retryCount?: number; mergeRetryIncrement?: boolean },
  ): void {
    const workerId = `${ctx.project}:${ctx.slot}:${ctx.seq}`;
    const nowIso = new Date().toISOString();
    const state = readState(ctx.stateFile, ctx.maxWorkers);
    const slot = state.workers[ctx.slot];

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
      slot.lastHeartbeat = nowIso;
      slot.pid = null;
      slot.outputFile = null;
      slot.exitCode = null;
      if (options?.mergeRetryIncrement) {
        slot.mergeRetries = (slot.mergeRetries ?? 0) + 1;
      }
    }

    const card = state.activeCards[ctx.seq];
    if (card && options?.retryCount != null) {
      card.retryCount = options.retryCount;
    }

    writeState(ctx.stateFile, state, updatedBy);

    this.supervisor.registerAcpHandle({
      id: workerId,
      pid: null,
      outputFile: null,
      project: ctx.project,
      seq: ctx.seq,
      slot: ctx.slot,
      branch: ctx.branch,
      worktree: ctx.worktree,
      tool: session.tool,
      exitCode: null,
      sessionId: session.sessionId,
      runId: session.currentRun?.runId || null,
      sessionState: session.sessionState,
      remoteStatus: session.currentRun?.status || null,
      lastEventAt: session.lastSeenAt,
      startedAt: slot?.claimedAt || nowIso,
      exitedAt: null,
    });
  }

  private async waitForAcpRun(
    ctx: PostActionContext,
    runId: string | null,
    timeoutMs: number,
    slotStatus: 'active' | 'resolving' | 'merging',
  ): Promise<ACPSessionRecord> {
    if (!this.agentRuntime) {
      throw new Error('ACP runtime is not configured');
    }

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const inspected = await this.agentRuntime.inspect(ctx.slot);
      const session = inspected.sessions[ctx.slot];
      if (!session) {
        throw new Error(`ACP session for ${ctx.slot} was lost`);
      }

      this.syncAcpRuntimeState(ctx, session, slotStatus, 'post-actions-acp-poll');
      const currentRun = session.currentRun;
      if (runId && currentRun && currentRun.runId !== runId) {
        await this.sleep(PID_POLL_INTERVAL);
        continue;
      }
      if (currentRun && currentRun.status === 'waiting_input') {
        throw new Error(`ACP run ${currentRun.runId} is waiting for input`);
      }
      if (currentRun && this.isTerminalAcpStatus(currentRun.status)) {
        const exitCode = currentRun.status === 'completed' ? 0 : 1;
        this.supervisor.updateAcpHandle(`${ctx.project}:${ctx.slot}:${ctx.seq}`, {
          exitCode,
          exitedAt: new Date().toISOString(),
          sessionState: session.sessionState,
          remoteStatus: currentRun.status,
          lastEventAt: session.lastSeenAt,
        });
        return session;
      }

      await this.sleep(PID_POLL_INTERVAL);
    }

    throw new Error(`ACP run timed out after ${Math.round(timeoutMs / 1000)}s`);
  }

  private isTerminalAcpStatus(status: ACPRunStatus): boolean {
    return ['completed', 'failed', 'cancelled', 'lost'].includes(status);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function safeExec(cmd: string, args: string[]): string {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return '';
  }
}
