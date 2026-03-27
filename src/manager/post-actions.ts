/**
 * PostActions — executes the full post-completion/failure chain.
 *
 * Called immediately from Supervisor exit callback → CompletionJudge → here.
 *
 * v0.23.19+: post-actions no longer owns merge/conflict resolution.
 * Development completion hands the task off to QA. Integration work is
 * owned by the QA worker and CloseoutEngine only finalizes outcomes.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RuntimeStore } from '../core/runtimeStore.js';
import type { CompletionResult } from './completion-judge.js';
import type { PMClient } from './pm-client.js';
import type { ProcessSupervisor, SpawnOpts } from './supervisor.js';
import type { ResourceLimiter } from './resource-limiter.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';
import type { ACPSessionRecord } from '../models/acp.js';
import {
  buildResumePrompt,
  LEGACY_TASK_PROMPT_FILE,
  promptFileForPhase,
  selectWorkerPhase,
} from '../core/taskPrompts.js';

// ─── Types ──────────────────────────────────────────────────────

export interface PostActionContext {
  project: string;
  seq: string;
  slot: string;
  transport: 'proc' | 'acp' | 'pty';
  branch: string;
  worktree: string;
  baseBranch: string;
  stateFile: string;
  maxWorkers: number;
  mrMode: 'none' | 'create';
  gitlabProjectId: string;
  gitlabUrl: string;
  gitlabToken: string;
  /** Plane/Trello target for QA handoff */
  qaStateId: string;
  /** Plane state UUID for Done (or Trello list ID) */
  doneStateId: string;
  maxRetries: number;
  logsDir: string;
  tool: 'claude' | 'codex';
  pmStateObserved?: 'Planning' | 'Backlog' | 'Todo' | 'Inprogress' | 'QA' | 'Done' | null;
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
    private readonly agentRuntime: AgentRuntime | null = null,
  ) {}

  private stateStore(ctx: PostActionContext): RuntimeStore {
    return new RuntimeStore({
      paths: { stateFile: ctx.stateFile },
      maxWorkers: ctx.maxWorkers,
    });
  }

  /**
   * Handle worker completion.
   *
   * Main path:
   *   development complete -> move card to QA and release the execution slot
   *
   * Exception path:
   *   if the branch is already merged into the target branch, absorb the result
   *   and finish directly as Done.
   */
  async executeCompletion(
    ctx: PostActionContext,
    completion: CompletionResult,
    _sessionId: string | null,
  ): Promise<StepResult[]> {
    if (completion.reason === 'already_merged' || ctx.pmStateObserved === 'QA') {
      return this.executeIntegratedCompletion(ctx, completion);
    }
    return this.executeDevelopmentCompletion(ctx, completion);
  }

  private async executeDevelopmentCompletion(
    ctx: PostActionContext,
    completion: CompletionResult,
  ): Promise<StepResult[]> {
    const results: StepResult[] = [];
    results.push(await this.pmMoveQa(ctx));
    const qaMoveOk = results[results.length - 1].ok;
    results.push(await this.releaseSlotToQa(ctx, qaMoveOk));
    results.push(await this.pmReleaseClaim(ctx));
    results.push(await this.notify(
      ctx,
      `seq:${ctx.seq} completed development (${completion.reason}), moved to QA`,
      'success',
    ));

    this.resourceLimiter.release();
    const workerId = `${ctx.project}:${ctx.slot}:${ctx.seq}`;
    this.supervisor.remove(workerId);

    return results;
  }

  private async executeIntegratedCompletion(
    ctx: PostActionContext,
    completion: CompletionResult,
  ): Promise<StepResult[]> {
    const results: StepResult[] = [];

    results.push(await this.pmMoveDone(ctx));
    results.push(await this.releaseSlot(ctx));
    results.push(await this.pmReleaseClaim(ctx));
    results.push(await this.markWorktreeCleanup(ctx));
    results.push(await this.archiveKnowledge(ctx));
    results.push(await this.notify(
      ctx,
      `seq:${ctx.seq} completed (${completion.reason}), integrated to ${ctx.baseBranch}`,
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
      if (ctx.transport !== 'proc' && this.agentRuntime) {
        results.push(await this.pmComment(
          ctx,
          `Worker ${completion.reason} (exit ${exitCode}). Retry #${retryCount + 1} on the same ${ctx.transport.toUpperCase()} session...`,
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

  // ─── Individual Steps ──────────────────────────────────────────

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

  private async pmMoveQa(ctx: PostActionContext): Promise<StepResult> {
    try {
      await this.pmClient.move(ctx.seq, ctx.qaStateId);
      return { step: 'pm-move-qa', ok: true };
    } catch (err) {
      return { step: 'pm-move-qa', ok: false, error: String(err) };
    }
  }

  private async pmMoveDone(ctx: PostActionContext): Promise<StepResult> {
    try {
      await this.pmClient.move(ctx.seq, ctx.doneStateId);
      return { step: 'pm-move-done', ok: true };
    } catch (err) {
      return { step: 'pm-move-done', ok: false, error: String(err) };
    }
  }

  private async releaseSlotToQa(ctx: PostActionContext, qaMoveOk: boolean): Promise<StepResult> {
    try {
      this.stateStore(ctx).updateState('post-actions-release-to-qa', (state) => {
        this.stateStore(ctx).releaseTaskProjection(state, ctx.seq, {
          dropLease: false,
          phase: 'merging',
          keepWorktree: true,
          pmStateObserved: qaMoveOk ? 'QA' : (ctx.pmStateObserved ?? 'Inprogress'),
        });
      });
      return { step: 'release-slot-to-qa', ok: true };
    } catch (err) {
      return { step: 'release-slot-to-qa', ok: false, error: String(err) };
    }
  }

  private async releaseSlot(ctx: PostActionContext): Promise<StepResult> {
    try {
      this.stateStore(ctx).updateState('post-actions-release', (state) => {
        this.stateStore(ctx).releaseTaskProjection(state, ctx.seq, { dropLease: true });
      });
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
      this.stateStore(ctx).updateState('post-actions-cleanup', (state) => {
        const cleanup = state.worktreeCleanup ?? [];
        if (!cleanup.some(e => e.branch === ctx.branch)) {
          cleanup.push({
            branch: ctx.branch,
            worktreePath: ctx.worktree,
            markedAt: new Date().toISOString(),
          });
          state.worktreeCleanup = cleanup;
        }
      });
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
      const resumePrompt = this.loadPhaseResumePrompt(ctx);

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

      this.stateStore(ctx).updateState('post-actions-retry', (state) => {
        if (state.leases[ctx.seq]) {
          state.leases[ctx.seq].retryCount = retryCount + 1;
          state.leases[ctx.seq].lastTransitionAt = new Date().toISOString();
        }
        if (state.activeCards[ctx.seq]) {
          state.activeCards[ctx.seq].retryCount = retryCount + 1;
        }
      });

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
      const resumePrompt = this.loadPhaseResumePrompt(ctx);

      const session = await this.resumeOrStartAgentRun(
        ctx,
        resumePrompt,
        'active',
        'post-actions-retry-acp',
        {
          retryCount: retryCount + 1,
        },
      );

      this.log(
        `Respawned ${ctx.project}:${ctx.slot}:${ctx.seq} on ${ctx.transport.toUpperCase()} session ${session.sessionId} ` +
        `(retry #${retryCount + 1})`,
      );
      return { step: 'respawn-acp', ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`ACP respawn failed: ${msg}`);
      return { step: 'respawn-acp', ok: false, error: msg };
    }
  }

  private async resumeOrStartAgentRun(
    ctx: PostActionContext,
    prompt: string,
    slotStatus: 'active' | 'resolving' | 'merging',
    updatedBy: string,
    options?: { retryCount?: number },
  ): Promise<ACPSessionRecord> {
    if (!this.agentRuntime) {
      throw new Error('ACP runtime is not configured');
    }

    try {
      const session = await this.agentRuntime.resumeRun(ctx.slot, prompt);
      this.syncAcpRuntimeState(ctx, session, slotStatus, updatedBy, options);
      return session;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(
        `${ctx.transport.toUpperCase()} resume unavailable for ${ctx.project}:${ctx.slot}:${ctx.seq}: ${msg}; ` +
        `creating a fresh session`,
      );
      await this.agentRuntime.ensureSession(ctx.slot, ctx.tool, ctx.worktree);
      const session = await this.agentRuntime.startRun(ctx.slot, prompt, ctx.tool, ctx.worktree);
      this.syncAcpRuntimeState(ctx, session, slotStatus, updatedBy, options);
      return session;
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

  private loadPhaseResumePrompt(ctx: PostActionContext): string {
    const phase = selectWorkerPhase(ctx.pmStateObserved ?? null, null);
    const phasePromptPath = resolve(ctx.worktree, '.sps', promptFileForPhase(phase));
    const legacyPromptPath = resolve(ctx.worktree, '.sps', LEGACY_TASK_PROMPT_FILE);
    const originalPrompt = existsSync(phasePromptPath)
      ? readFileSync(phasePromptPath, 'utf-8')
      : (existsSync(legacyPromptPath) ? readFileSync(legacyPromptPath, 'utf-8') : null);
    return buildResumePrompt(phase, ctx.worktree, ctx.branch, originalPrompt);
  }

  private syncAcpRuntimeState(
    ctx: PostActionContext,
    session: ACPSessionRecord,
    slotStatus: 'active' | 'resolving' | 'merging',
    updatedBy: string,
    options?: { retryCount?: number },
  ): void {
    const workerId = `${ctx.project}:${ctx.slot}:${ctx.seq}`;
    const nowIso = new Date().toISOString();
    let claimedAt = nowIso;
    this.stateStore(ctx).updateState(updatedBy, (state) => {
      const slot = state.workers[ctx.slot];
      if (slot) {
        const agentMode = ctx.transport === 'pty' ? 'pty' : 'acp';
        slot.status = slotStatus;
        slot.mode = agentMode;
        slot.transport = ctx.transport;
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
        claimedAt = slot.claimedAt || nowIso;
      }

      if (state.leases[ctx.seq]) {
        state.leases[ctx.seq].slot = ctx.slot;
        state.leases[ctx.seq].branch = ctx.branch;
        state.leases[ctx.seq].worktree = ctx.worktree;
        state.leases[ctx.seq].sessionId = session.sessionId;
        state.leases[ctx.seq].runId = session.currentRun?.runId || null;
        if (options?.retryCount != null) {
          state.leases[ctx.seq].retryCount = options.retryCount;
        }
        state.leases[ctx.seq].phase = slotStatus === 'merging'
          ? 'merging'
          : session.pendingInput || session.currentRun?.status === 'waiting_input'
            ? 'waiting_confirmation'
            : slotStatus === 'resolving'
              ? 'resolving_conflict'
              : 'coding';
        state.leases[ctx.seq].lastTransitionAt = nowIso;
      }
      if (state.activeCards[ctx.seq] && options?.retryCount != null) {
        state.activeCards[ctx.seq].retryCount = options.retryCount;
      }
    });

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
      startedAt: claimedAt,
      exitedAt: null,
    });
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
