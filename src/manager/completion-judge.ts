/**
 * CompletionJudge — determines whether a worker completed its task.
 *
 * Called immediately when a worker process exits (via Supervisor exit callback).
 * Checks git artifacts and phase-specific completion evidence.
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  branchPushed,
  branchCommitsAhead,
  extractLastAssistantText,
} from '../providers/outputParser.js';
import type { WorkerTaskPhase } from '../core/taskPrompts.js';

// ─── Types ──────────────────────────────────────────────────────

export interface JudgeInput {
  worktree: string;
  branch: string;
  baseBranch: string;
  outputFile: string | null;
  exitCode: number;
  logsDir?: string;
  phase: WorkerTaskPhase;
}

export interface CompletionResult {
  status: 'completed' | 'failed' | 'incomplete';
  reason: string;
}

/** Keywords that suggest the worker believes it finished. */
const COMPLETION_KEYWORDS =
  /\b(done|完成|全部完成|MR created|merge request|已提交|已推送)\b|🎉/i;

// ─── Judge ──────────────────────────────────────────────────────

export class CompletionJudge {

  /**
   * Determine whether the worker completed the task based on artifacts.
   *
   * Priority:
 * development:
 * 1. Branch already merged into target -> completed (exception path)
 * 2. Marker file (task_completed)
 * 3. Branch pushed with commits ahead
 * 4. Local commits ahead on task branch
 * 5. Otherwise incomplete/failed
 *
 * integration:
 * 1. Branch already merged into target -> completed
 * 2. Otherwise incomplete/failed
   */
  judge(input: JudgeInput): CompletionResult {
    const { worktree, branch, baseBranch, outputFile, exitCode, logsDir, phase } = input;

    const mergedToBase = this.isMergedToBase(worktree, branch, baseBranch);
    if (mergedToBase) {
      // Guard: a freshly created branch with no work is trivially an
      // ancestor of origin/base. Only trust "already merged" if:
      // - Branch was pushed (worker pushed their work), OR
      // - Branch has local commits ahead (worker committed locally)
      // Without either, the branch just sits at the base commit.
      const pushed = branchPushed(worktree, branch);
      const localAhead = branchCommitsAhead(worktree, branch, baseBranch);
      if (pushed || localAhead > 0) {
        this.log(`Branch ${branch} already merged into ${baseBranch}`);
        return { status: 'completed', reason: 'already_merged' };
      }
      this.log(`Branch ${branch} is ancestor of ${baseBranch} but has no artifacts — not a real merge`);
    }

    if (phase === 'integration') {
      // Check if branch was pushed to target (worker did git push origin branch:target)
      // even if exit code is non-zero (claude/codex may exit 1 after successful push)
      const pushed = branchPushed(worktree, branch);
      if (pushed) {
        const ahead = branchCommitsAhead(worktree, branch, baseBranch);
        if (ahead > 0) {
          return { status: 'completed', reason: 'branch_pushed' };
        }
      }
      if (exitCode === 0) {
        return { status: 'incomplete', reason: 'integration_not_merged' };
      }
      return { status: 'failed', reason: `crash(${exitCode})` };
    }

    // 1. Marker file
    if (logsDir) {
      const markerPath = resolve(logsDir, 'task_completed');
      if (existsSync(markerPath)) {
        return { status: 'completed', reason: 'marker_file' };
      }
    }

    // 2. Branch pushed with commits ahead
    const pushed = branchPushed(worktree, branch);
    if (pushed) {
      const ahead = branchCommitsAhead(worktree, branch, baseBranch);
      if (ahead > 0) {
        return { status: 'completed', reason: 'branch_pushed' };
      }
    }

    // 3. Local commits not pushed are sufficient for development completion.
    const localAhead = branchCommitsAhead(worktree, branch, baseBranch);
    if (!pushed && localAhead > 0) {
      return { status: 'completed', reason: 'branch_local_commits' };
    }

    if (pushed && localAhead === 0) {
      try {
        execFileSync('git', [
          '-C', worktree, 'rev-parse', '--verify', '--quiet', 'HEAD',
        ], { timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        this.log(`Unable to inspect HEAD for branch ${branch}`);
      }
    }

    // 4. Output keywords (only when git check found nothing)
    if (outputFile) {
      const lastText = extractLastAssistantText(outputFile);
      if (COMPLETION_KEYWORDS.test(lastText)) {
        this.log(`Completion keywords found but no git artifacts for branch ${branch}`);
      }
    }

    // 5. No artifacts
    if (exitCode === 0) {
      return { status: 'incomplete', reason: 'no_artifacts' };
    }
    return { status: 'failed', reason: `crash(${exitCode})` };
  }

  private isMergedToBase(worktree: string, branch: string, baseBranch: string): boolean {
    try {
      execFileSync('git', [
        '-C', worktree, 'merge-base', '--is-ancestor', branch, `origin/${baseBranch}`,
      ], { timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] });
      return true;
    } catch {
      return false;
    }
  }

  private log(msg: string): void {
    process.stderr.write(`[completion-judge] ${msg}\n`);
  }
}
