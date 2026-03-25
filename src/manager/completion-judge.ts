/**
 * CompletionJudge — determines whether a worker completed its task.
 *
 * Called immediately when a worker process exits (via Supervisor exit callback).
 * Checks git artifacts, auto-pushes if needed, falls back to keyword detection.
 */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  branchPushed,
  branchCommitsAhead,
  extractLastAssistantText,
} from '../providers/outputParser.js';

// ─── Types ──────────────────────────────────────────────────────

export interface JudgeInput {
  worktree: string;
  branch: string;
  baseBranch: string;
  outputFile: string | null;
  exitCode: number;
  logsDir?: string;
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
   * 1. Marker file (task_completed) — definitive signal
   * 2. Branch pushed with new commits — strong signal
   * 3. Local commits not pushed → auto-push, then completed
   * 4. Output keywords (only when no git artifacts available)
   * 5. No artifacts → incomplete or failed
   */
  judge(input: JudgeInput): CompletionResult {
    const { worktree, branch, baseBranch, outputFile, exitCode, logsDir } = input;

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

      // 2b. Branch pushed but commits ahead = 0 → may already be merged into target
      // This happens when worker ran merge.sh successfully (MR_MODE=none)
      try {
        const mergeCheck = execFileSync('git', [
          '-C', worktree, 'log', '--oneline', '--grep',
          `Merge.*${branch.replace('feature/', '')}`,
          `origin/${baseBranch}`, '-1',
        ], { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
        if (mergeCheck) {
          this.log(`Branch ${branch} already merged into ${baseBranch}`);
          return { status: 'completed', reason: 'already_merged' };
        }
      } catch { /* git error, fall through */ }
    }

    // 3. Local commits not pushed → auto-push
    if (!pushed) {
      const localAhead = branchCommitsAhead(worktree, branch, baseBranch);
      if (localAhead > 0) {
        try {
          execFileSync('git', ['-C', worktree, 'push', '-u', 'origin', branch], {
            encoding: 'utf-8',
            timeout: 30_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          this.log(`Auto-pushed branch ${branch} (${localAhead} commits)`);
          return { status: 'completed', reason: 'auto_pushed' };
        } catch (err) {
          this.log(`Auto-push failed for ${branch}: ${err}`);
          // Fall through to other checks
        }
      }
    }

    // 4. Output keywords (only when git check found nothing)
    if (outputFile) {
      const lastText = extractLastAssistantText(outputFile);
      if (COMPLETION_KEYWORDS.test(lastText)) {
        // Keywords without git artifacts are unreliable — worker may have said
        // "done" without actually pushing. Mark as incomplete, not completed.
        // PostActions will handle retry or NEEDS-FIX.
        this.log(`Completion keywords found but no git artifacts for branch ${branch}`);
      }
    }

    // 5. No artifacts
    if (exitCode === 0) {
      return { status: 'incomplete', reason: 'no_artifacts' };
    }
    return { status: 'failed', reason: `crash(${exitCode})` };
  }

  private log(msg: string): void {
    process.stderr.write(`[completion-judge] ${msg}\n`);
  }
}
