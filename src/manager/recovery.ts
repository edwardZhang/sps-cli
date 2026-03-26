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
import { readState, writeState } from '../core/state.js';
import { resolveGitlabProjectId } from '../core/config.js';
import { isProcessAlive } from '../providers/outputParser.js';
import { CompletionJudge, type JudgeInput } from './completion-judge.js';
import { PostActions, type PostActionContext } from './post-actions.js';
import { ProcessSupervisor } from './supervisor.js';
import { ResourceLimiter } from './resource-limiter.js';
import type { ProjectConfig } from '../core/config.js';

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

  /**
   * Scan all projects for active workers and recover them.
   *
   * @param projects - List of project info (from tick runners)
   */
  async recover(projects: ProjectInfo[]): Promise<RecoveryResult> {
    const result: RecoveryResult = { found: 0, alive: 0, completed: 0, failed: 0 };

    for (const project of projects) {
      const state = readState(project.stateFile, project.config.MAX_CONCURRENT_WORKERS);

      // Create per-project PostActions (C3 fix: use correct PM config per project)
      const postActions = this.postActionsFactory(project.config);

      for (const [slotName, slot] of Object.entries(state.workers)) {
        // Recover active, merging, and resolving slots
        if (!['active', 'merging', 'resolving'].includes(slot.status)) continue;

        // For merging slots without PID: reset to active so completion flow picks it up
        if ((slot.status === 'merging' || slot.status === 'resolving') && !slot.pid) {
          process.stderr.write(`[recovery] ${project.name}:${slotName}:${slot.seq}: slot in ${slot.status} state without PID, resetting\n`);
          // Set back to active so the normal completion flow picks it up
          const freshState = readState(project.stateFile, project.config.MAX_CONCURRENT_WORKERS);
          if (freshState.workers[slotName]) {
            freshState.workers[slotName].status = 'active';
          }
          writeState(project.stateFile, freshState, 'recovery-merge-reset');
          continue;
        }

        if (!slot.pid) continue;

        result.found++;
        const workerId = `${project.name}:${slotName}:${slot.seq}`;
        const seq = String(slot.seq);

        if (isProcessAlive(slot.pid)) {
          // Worker still running — attach PID monitoring
          result.alive++;
          this.resourceLimiter.tryAcquire(); // Count toward global limit

          const buildOnExit = this.buildOnExitCallback(project, slotName, slot, seq, postActions);

          this.supervisor.monitorOrphanPid(
            workerId,
            slot.pid,
            {
              id: workerId,
              pid: slot.pid,
              outputFile: slot.outputFile || '',
              project: project.name,
              seq,
              slot: slotName,
              branch: slot.branch || '',
              worktree: slot.worktree || '',
              tool: (project.config.WORKER_TOOL || 'claude') as 'claude' | 'codex',
              exitCode: null,
              sessionId: slot.sessionId || null,
              startedAt: slot.claimedAt || new Date().toISOString(),
              exitedAt: null,
            },
            buildOnExit,
          );

          this.log(`Recovered active worker ${workerId} (pid ${slot.pid})`);
        } else {
          // Worker is dead — run completion check
          this.log(`Found dead worker ${workerId} (pid ${slot.pid}), checking completion`);

          const card = state.activeCards[seq];
          const retryCount = card?.retryCount ?? 0;

          const judgeInput: JudgeInput = {
            worktree: slot.worktree || '',
            branch: slot.branch || '',
            baseBranch: project.config.GITLAB_MERGE_BRANCH,
            outputFile: slot.outputFile || null,
            exitCode: slot.exitCode ?? 1,
            logsDir: project.logsDir,
          };

          const completion = this.judge.judge(judgeInput);

          const ctx = this.buildPostActionContext(project, slotName, seq, slot);

          if (completion.status === 'completed') {
            await postActions.executeCompletion(ctx, completion, slot.sessionId || null);
            result.completed++;
          } else {
            await postActions.executeFailure(
              ctx, completion, slot.exitCode ?? 1, slot.sessionId || null, retryCount,
              { onExit: this.buildOnExitCallback(project, slotName, slot, seq, postActions) },
            );
            result.failed++;
          }
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
    slot: { branch?: string | null; worktree?: string | null },
  ): PostActionContext {
    const raw = project.config.raw;
    return {
      project: project.name,
      seq,
      slot: slotName,
      branch: slot.branch || '',
      worktree: slot.worktree || '',
      baseBranch: project.config.GITLAB_MERGE_BRANCH,
      stateFile: project.stateFile,
      maxWorkers: project.config.MAX_CONCURRENT_WORKERS,
      mrMode: project.config.MR_MODE,
      gitlabProjectId: resolveGitlabProjectId(project.config),
      gitlabUrl: raw.GITLAB_URL || process.env.GITLAB_URL || '',
      gitlabToken: raw.GITLAB_TOKEN || process.env.GITLAB_TOKEN || '',
      doneStateId: raw.PLANE_STATE_DONE || raw.TRELLO_DONE_LIST_ID || '',
      maxRetries: project.config.WORKER_RESTART_LIMIT,
      logsDir: project.logsDir,
      tool: project.config.WORKER_TOOL as 'claude' | 'codex',
    };
  }

  private buildOnExitCallback(
    project: ProjectInfo,
    slotName: string,
    slot: { branch?: string | null; worktree?: string | null; outputFile?: string | null; sessionId?: string | null; seq?: number | null },
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

      const state = readState(project.stateFile, project.config.MAX_CONCURRENT_WORKERS);
      const card = state.activeCards[seq];
      const retryCount = card?.retryCount ?? 0;

      if (completion.status === 'completed') {
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
}
