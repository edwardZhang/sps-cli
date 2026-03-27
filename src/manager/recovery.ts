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
import type { TaskLease, WorkerSlotState } from '../core/state.js';

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
      const reservedSlots = new Set<string>();
      // Create per-project PostActions (C3 fix: use correct PM config per project)
      const postActions = this.postActionsFactory(project.config);
      for (const [seq, lease] of this.listRecoverableLeases(state)) {
        const slotName = this.resolveRecoverySlotName(state, seq, lease, reservedSlots);
        const slot = slotName ? state.workers[slotName] || null : null;
        const workerRef = {
          branch: lease.branch || slot?.branch || null,
          worktree: lease.worktree || slot?.worktree || null,
          outputFile: slot?.outputFile || null,
          sessionId: lease.sessionId || slot?.sessionId || null,
          mode: slot?.mode || (project.config.WORKER_TRANSPORT === 'pty' ? 'pty' : project.config.WORKER_TRANSPORT === 'acp' ? 'acp' : project.config.WORKER_MODE) || null,
          transport: slot?.transport || project.config.WORKER_TRANSPORT || null,
          agent: slot?.agent || (project.config.ACP_AGENT || project.config.WORKER_TOOL) as 'claude' | 'codex',
          pid: slot?.pid ?? null,
          exitCode: slot?.exitCode ?? null,
          sessionState: slot?.sessionState ?? null,
          remoteStatus: slot?.remoteStatus ?? null,
          lastEventAt: slot?.lastEventAt ?? null,
          claimedAt: lease.claimedAt || slot?.claimedAt || null,
          seq: lease.seq,
        };

        result.found++;

        const isAcpTransport = workerRef.transport === 'acp' || workerRef.transport === 'pty' || workerRef.mode === 'acp' || workerRef.mode === 'pty';
        if (isAcpTransport && slotName) {
          const recovered = await this.recoverAcpSlot(project, slotName, seq, workerRef, postActions, lease.retryCount);
          if (recovered === 'alive') result.alive++;
          if (recovered === 'completed') result.completed++;
          if (recovered === 'failed') result.failed++;
          continue;
        }

        if (workerRef.pid && isProcessAlive(workerRef.pid)) {
          result.alive++;
          this.resourceLimiter.tryAcquire();

          const buildOnExit = this.buildOnExitCallback(project, slotName || 'worker-1', workerRef, seq, postActions);
          const workerId = `${project.name}:${slotName || 'worker-1'}:${seq}`;
          this.supervisor.monitorOrphanPid(
            workerId,
            workerRef.pid,
            {
              id: workerId,
              transport: 'proc',
              pid: workerRef.pid,
              outputFile: workerRef.outputFile || '',
              project: project.name,
              seq,
              slot: slotName || 'worker-1',
              branch: workerRef.branch || '',
              worktree: workerRef.worktree || '',
              tool: workerRef.agent || (project.config.WORKER_TOOL || 'claude') as 'claude' | 'codex',
              exitCode: null,
              sessionId: workerRef.sessionId,
              runId: null,
              sessionState: workerRef.sessionState,
              remoteStatus: workerRef.remoteStatus,
              lastEventAt: workerRef.lastEventAt,
              startedAt: workerRef.claimedAt || new Date().toISOString(),
              exitedAt: null,
            },
            buildOnExit,
          );

          this.log(`Recovered active worker ${workerId} (pid ${workerRef.pid})`);
          continue;
        }

        const exitCode = workerRef.exitCode ?? 1;
        const completion = this.judge.judge({
          worktree: workerRef.worktree || '',
          branch: workerRef.branch || '',
          baseBranch: project.config.GITLAB_MERGE_BRANCH,
          outputFile: workerRef.outputFile,
          exitCode,
          logsDir: project.logsDir,
        });

        const ctx = this.buildPostActionContext(project, slotName || 'worker-1', seq, workerRef);

        if (completion.status === 'completed') {
          await postActions.executeCompletion(ctx, completion, workerRef.sessionId);
          result.completed++;
        } else {
          await postActions.executeFailure(
            ctx,
            completion,
            exitCode,
            workerRef.sessionId,
            lease.retryCount,
            { onExit: this.buildOnExitCallback(project, slotName || 'worker-1', workerRef, seq, postActions) },
          );
          result.failed++;
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
      transport?: 'proc' | 'acp' | 'pty' | null;
      mode?: string | null;
      agent?: 'claude' | 'codex' | null;
    },
  ): PostActionContext {
    const raw = project.config.raw;
    return {
      project: project.name,
      seq,
      slot: slotName,
      transport: slot.transport === 'pty' || slot.mode === 'pty'
        ? 'pty'
        : (slot.transport === 'acp' || slot.mode === 'acp' ? 'acp' : 'proc'),
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
      const retryCount = this.getRetryCount(state, seq);

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
    retryCount: number,
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

  private listRecoverableLeases(state: ReturnType<typeof readState>): Array<[string, TaskLease]> {
    return Object.entries(state.leases)
      .filter(([, lease]) => !['suspended', 'released'].includes(lease.phase))
      .sort(([, a], [, b]) => {
        const aTime = Date.parse(a.lastTransitionAt || a.claimedAt || '') || 0;
        const bTime = Date.parse(b.lastTransitionAt || b.claimedAt || '') || 0;
        return aTime - bTime;
      });
  }

  private resolveRecoverySlotName(
    state: ReturnType<typeof readState>,
    seq: string,
    lease: TaskLease,
    reservedSlots: Set<string>,
  ): string | null {
    if (lease.slot && state.workers[lease.slot]) {
      reservedSlots.add(lease.slot);
      return lease.slot;
    }

    const existing = Object.entries(state.workers).find(
      ([name, worker]) => worker.seq === parseInt(seq, 10) && !reservedSlots.has(name),
    )?.[0];
    if (existing) {
      reservedSlots.add(existing);
      return existing;
    }

    const idle = Object.entries(state.workers).find(
      ([name, worker]) => worker.status === 'idle' && !reservedSlots.has(name),
    )?.[0];
    if (idle) {
      reservedSlots.add(idle);
      return idle;
    }

    return null;
  }

  private getRetryCount(state: ReturnType<typeof readState>, seq: string): number {
    return state.leases[seq]?.retryCount ?? state.activeCards[seq]?.retryCount ?? 0;
  }

  private syncAcpSlot(project: ProjectInfo, slotName: string, session: ACPSessionRecord): void {
    const state = readState(project.stateFile, project.config.MAX_CONCURRENT_WORKERS);
    const slot = state.workers[slotName];
    if (!slot) return;
    const transport = project.config.WORKER_TRANSPORT === 'pty' ? 'pty' : 'acp';
    slot.mode = transport;
    slot.transport = transport;
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
