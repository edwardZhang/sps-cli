/**
 * PostActions — executes the full post-completion/failure chain.
 *
 * Called immediately from Supervisor exit callback → CompletionJudge → here.
 * Each step is independent try/catch — one failure does not block the rest.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { readState, writeState } from '../core/state.js';
import type { CompletionResult } from './completion-judge.js';
import type { PMClient } from './pm-client.js';
import type { ProcessSupervisor, SpawnOpts } from './supervisor.js';
import type { ResourceLimiter } from './resource-limiter.js';
import type { Notifier } from '../interfaces/Notifier.js';

// ─── Types ──────────────────────────────────────────────────────

export interface PostActionContext {
  project: string;
  seq: string;
  slot: string;
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

// ─── PostActions ────────────────────────────────────────────────

export class PostActions {
  constructor(
    private readonly pmClient: PMClient,
    private readonly supervisor: ProcessSupervisor,
    private readonly resourceLimiter: ResourceLimiter,
    private readonly notifier: Notifier | null,
  ) {}

  /**
   * Handle worker completion — merge + PM update + release + notify.
   */
  async executeCompletion(
    ctx: PostActionContext,
    completion: CompletionResult,
    sessionId: string | null,
  ): Promise<StepResult[]> {
    const results: StepResult[] = [];

    // 1. Merge code
    if (ctx.mrMode === 'none') {
      results.push(await this.directMerge(ctx));
    } else {
      results.push(await this.createMR(ctx));
    }

    // 2. PM move → Done
    results.push(await this.pmMove(ctx));

    // 3. Release worker slot
    results.push(await this.releaseSlot(ctx));

    // 4. Release PM claim
    results.push(await this.pmReleaseClaim(ctx));

    // 5. Mark worktree for cleanup
    results.push(await this.markWorktreeCleanup(ctx));

    // 6. Knowledge archive
    results.push(await this.archiveKnowledge(ctx));

    // 7. Notify
    results.push(await this.notify(
      ctx,
      `seq:${ctx.seq} completed (${completion.reason}), merged to ${ctx.baseBranch}`,
      'success',
    ));

    // Release global resource
    this.resourceLimiter.release();

    // Remove from supervisor tracking
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

    if (retryCount < ctx.maxRetries && sessionId) {
      // Release old worker resources BEFORE respawning
      this.resourceLimiter.release();
      const workerId = `${ctx.project}:${ctx.slot}:${ctx.seq}`;
      this.supervisor.remove(workerId);

      // Retry with --resume
      results.push(await this.pmComment(
        ctx,
        `Worker ${completion.reason} (exit ${exitCode}). Retry #${retryCount + 1} with --resume...`,
      ));

      results.push(await this.respawn(ctx, sessionId, retryCount, respawnOpts));
    } else {
      // Retries exhausted → NEEDS-FIX
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
    }

    return results;
  }

  // ─── Individual Steps ───────────────────────────────────────

  private async directMerge(ctx: PostActionContext): Promise<StepResult> {
    try {
      const { worktree, branch, baseBranch } = ctx;

      // Fetch latest target
      try {
        execFileSync('git', ['-C', worktree, 'fetch', 'origin', baseBranch, '--quiet'], {
          timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { /* offline ok */ }

      // Rebase feature onto latest target
      execFileSync('git', ['-C', worktree, 'rebase', `origin/${baseBranch}`], {
        timeout: 30_000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Force push rebased feature (in case rebase rewrote commits)
      execFileSync('git', ['-C', worktree, 'push', '--force-with-lease', 'origin', branch], {
        timeout: 30_000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Switch to target, merge, push
      execFileSync('git', ['-C', worktree, 'checkout', baseBranch], {
        timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      execFileSync('git', ['-C', worktree, 'pull', 'origin', baseBranch], {
        timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      execFileSync('git', ['-C', worktree, 'merge', '--no-ff', branch, '-m',
        `Merge ${branch} into ${baseBranch}`], {
        timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
      execFileSync('git', ['-C', worktree, 'push', 'origin', baseBranch], {
        timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.log(`Merged ${branch} → ${baseBranch}`);
      return { step: 'merge', ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`Merge failed: ${msg}`);
      // Mark NEEDS-FIX on merge failure
      try { await this.pmClient.addLabel(ctx.seq, 'NEEDS-FIX'); } catch { /* best effort */ }
      try { await this.pmClient.comment(ctx.seq, `Auto-merge failed: ${msg}`); } catch { /* best effort */ }
      return { step: 'merge', ok: false, error: msg };
    }
  }

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
          mode: null, sessionId: null, pid: null, outputFile: null, exitCode: null,
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
      // Extract git diff stat
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
        'Remember to push your changes and run bash .jarvis/merge.sh when done.',
      ].join('\n');

      const outputFile = resolve(
        ctx.logsDir,
        `${ctx.project}-${ctx.slot}-retry${retryCount + 1}-${Date.now()}.jsonl`,
      );

      // Acquire resource for new worker
      if (!this.resourceLimiter.tryAcquire()) {
        this.log(`Cannot respawn ${workerId}: global worker limit reached`);
        return { step: 'respawn', ok: false, error: 'Global worker limit reached' };
      }

      // Spawn FIRST, then update state (C5 fix: avoid state corruption on spawn failure)
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

      // Update retry count in state.json AFTER successful spawn
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
      // Release resource if spawn failed
      this.resourceLimiter.release();
      return { step: 'respawn', ok: false, error: msg };
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
