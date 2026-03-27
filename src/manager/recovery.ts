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
import { ProjectContext } from '../core/context.js';
import { isProcessAlive } from '../providers/outputParser.js';
import { CompletionJudge, type JudgeInput } from './completion-judge.js';
import { PostActions, type PostActionContext } from './post-actions.js';
import { ProcessSupervisor } from './supervisor.js';
import { ResourceLimiter } from './resource-limiter.js';
import type { ProjectConfig } from '../core/config.js';
import { ACPWorkerRuntime } from '../providers/ACPWorkerRuntime.js';
import type { ACPSessionRecord, ACPRunStatus } from '../models/acp.js';

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

        if (slot.transport === 'acp' || slot.mode === 'acp') {
          result.found++;
          const recovered = await this.recoverAcpSlot(project, slotName, seqString(slot.seq), slot, postActions);
          if (recovered === 'alive') result.alive++;
          if (recovered === 'completed') result.completed++;
          if (recovered === 'failed') result.failed++;
          continue;
        }

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
              transport: 'proc',
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
              runId: slot.runId || null,
              sessionState: slot.sessionState || null,
              remoteStatus: slot.remoteStatus || null,
              lastEventAt: slot.lastEventAt || null,
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
    slot: {
      branch?: string | null;
      worktree?: string | null;
      transport?: 'proc' | 'acp' | null;
      mode?: string | null;
      agent?: 'claude' | 'codex' | null;
    },
  ): PostActionContext {
    const raw = project.config.raw;
    return {
      project: project.name,
      seq,
      slot: slotName,
      transport: slot.transport === 'acp' || slot.mode === 'acp' ? 'acp' : 'proc',
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
      tool: slot.agent || (project.config.ACP_AGENT || project.config.WORKER_TOOL) as 'claude' | 'codex',
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

  private async recoverAcpSlot(
    project: ProjectInfo,
    slotName: string,
    seq: string,
    slot: {
      branch?: string | null;
      worktree?: string | null;
      outputFile?: string | null;
      sessionId?: string | null;
      seq?: number | null;
    },
    postActions: PostActions,
  ): Promise<'alive' | 'completed' | 'failed'> {
    const ctx = ProjectContext.load(project.name);
    const runtime = new ACPWorkerRuntime(ctx);
    const inspected = await runtime.inspect(slotName);
    const session = inspected.sessions[slotName];
    const workerId = `${project.name}:${slotName}:${seq}`;

    if (session && session.currentRun && this.isActiveRun(session.currentRun.status)) {
      this.resourceLimiter.tryAcquire();
      this.supervisor.registerAcpHandle({
        id: workerId,
        pid: null,
        outputFile: null,
        project: project.name,
        seq,
        slot: slotName,
        branch: slot.branch || '',
        worktree: slot.worktree || '',
        tool: session.tool,
        exitCode: null,
        sessionId: session.sessionId,
        runId: session.currentRun.runId,
        sessionState: session.sessionState,
        remoteStatus: session.currentRun.status,
        lastEventAt: session.lastSeenAt,
        startedAt: (slot as { claimedAt?: string | null }).claimedAt || new Date().toISOString(),
        exitedAt: null,
      });
      this.syncAcpSlot(project, slotName, session);
      this.log(`Recovered active ACP worker ${workerId} (session ${session.sessionId}, run ${session.currentRun.runId})`);
      return 'alive';
    }

    const exitCode = this.acpExitCode(session?.currentRun?.status);
    const judgeInput: JudgeInput = {
      worktree: slot.worktree || '',
      branch: slot.branch || '',
      baseBranch: project.config.GITLAB_MERGE_BRANCH,
      outputFile: null,
      exitCode,
      logsDir: project.logsDir,
    };

    if (session) {
      this.syncAcpSlot(project, slotName, session);
      this.supervisor.registerAcpHandle({
        id: workerId,
        pid: null,
        outputFile: null,
        project: project.name,
        seq,
        slot: slotName,
        branch: slot.branch || '',
        worktree: slot.worktree || '',
        tool: session.tool,
        exitCode,
        sessionId: session.sessionId,
        runId: session.currentRun?.runId || null,
        sessionState: session.sessionState,
        remoteStatus: session.currentRun?.status || 'lost',
        lastEventAt: session.lastSeenAt,
        startedAt: (slot as { claimedAt?: string | null }).claimedAt || new Date().toISOString(),
        exitedAt: new Date().toISOString(),
      });
    }

    const completion = this.judge.judge(judgeInput);
    const postActionCtx = this.buildPostActionContext(project, slotName, seq, slot);
    const state = readState(project.stateFile, project.config.MAX_CONCURRENT_WORKERS);
    const card = state.activeCards[seq];
    const retryCount = card?.retryCount ?? 0;

    if (completion.status === 'completed') {
      await postActions.executeCompletion(postActionCtx, completion, session?.sessionId || null);
      return 'completed';
    }

    await postActions.executeFailure(
      postActionCtx,
      completion,
      exitCode,
      null,
      retryCount,
      { onExit: this.buildOnExitCallback(project, slotName, slot, seq, postActions) },
    );
    return 'failed';
  }

  private syncAcpSlot(project: ProjectInfo, slotName: string, session: ACPSessionRecord): void {
    const state = readState(project.stateFile, project.config.MAX_CONCURRENT_WORKERS);
    const slot = state.workers[slotName];
    if (!slot) return;
    slot.mode = 'acp';
    slot.transport = 'acp';
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
    slot.lastHeartbeat = new Date().toISOString();
    writeState(project.stateFile, state, 'recovery-acp-sync');
  }

  private isActiveRun(status: ACPRunStatus): boolean {
    return ['submitted', 'running', 'waiting_input'].includes(status);
  }

  private acpExitCode(status: ACPRunStatus | undefined): number {
    return status === 'completed' ? 0 : 1;
  }
}

function seqString(seq: number | null | undefined): string {
  return seq == null ? '' : String(seq);
}
