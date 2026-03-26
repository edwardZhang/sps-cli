import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectContext } from '../core/context.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { CommandResult, ActionRecord, Card, AuxiliaryState } from '../models/types.js';
import { readState, writeState } from '../core/state.js';
import { resolveGitlabProjectId } from '../core/config.js';
import { resolveWorktreePath } from '../core/paths.js';
import { readQueue } from '../core/queue.js';
import { Logger } from '../core/logger.js';
import { ProcessSupervisor } from '../manager/supervisor.js';
import { CompletionJudge } from '../manager/completion-judge.js';
import { PostActions, type PostActionContext } from '../manager/post-actions.js';
import { ResourceLimiter } from '../manager/resource-limiter.js';

const SKIP_LABELS: AuxiliaryState[] = ['BLOCKED', 'NEEDS-FIX', 'CONFLICT', 'WAITING-CONFIRMATION', 'STALE-RUNTIME'];

export class ExecutionEngine {
  private log: Logger;

  constructor(
    private ctx: ProjectContext,
    private taskBackend: TaskBackend,
    private repoBackend: RepoBackend,
    private supervisor: ProcessSupervisor,
    private completionJudge: CompletionJudge,
    private postActions: PostActions,
    private resourceLimiter: ResourceLimiter,
    private notifier?: Notifier,
  ) {
    this.log = new Logger('pipeline', ctx.projectName, ctx.paths.logsDir);
  }

  async tick(opts: { dryRun?: boolean } = {}): Promise<CommandResult> {
    const actions: ActionRecord[] = [];
    const result: CommandResult = {
      project: this.ctx.projectName,
      component: 'pipeline',
      status: 'ok',
      exitCode: 0,
      actions,
      recommendedActions: [],
      details: {},
    };

    let actionsThisTick = 0;
    const maxActions = this.ctx.config.MAX_ACTIONS_PER_TICK;

    try {
      // 1. Process Inprogress cards (detect completion → move to QA)
      //    This runs first to free slots before launching new workers.
      //    Completion detection does NOT consume action quota — it's a
      //    prerequisite for freeing slots, not a new forward action.
      const inprogressCards = await this.taskBackend.listByState('Inprogress');
      for (const card of inprogressCards) {
        if (this.shouldSkip(card)) continue;
        const checkResult = await this.checkInprogressCard(card, opts);
        if (checkResult) {
          actions.push(checkResult);
          // NOTE: intentionally not incrementing actionsThisTick here.
          // Completion detection frees slots for new launches and should
          // never block subsequent prepare/launch steps in the same tick.
        }
      }

      // 2. Process Backlog cards (prepare: branch + worktree + move to Todo)
      //    Prepare does NOT consume launch quota — it only sets up the
      //    environment. This allows prepare + launch to happen in a single tick.
      const backlogCards = await this.taskBackend.listByState('Backlog');
      for (const card of backlogCards) {
        if (this.shouldSkip(card)) {
          actions.push({ action: 'skip', entity: `seq:${card.seq}`, result: 'skip', message: 'Has auxiliary state label' });
          continue;
        }
        const prepareResult = await this.prepareCard(card, opts);
        actions.push(prepareResult);
        // NOTE: prepare does not count toward actionsThisTick.
        // It only creates branch + worktree + moves to Todo.
        // The real throttle point is worker launch (step 3).
      }

      // 3. Process Todo cards (launch: claim + context + worker + move to Inprogress)
      //    This is the only step that consumes action quota — it starts
      //    resource-intensive AI workers that need system capacity.
      //    Sort by pipeline_order to respect card priority (#5 skip bug fix).
      let todoCards = await this.taskBackend.listByState('Todo');
      const pipelineOrder = readQueue(this.ctx.paths.pipelineOrderFile);
      if (pipelineOrder.length > 0) {
        todoCards = todoCards.sort((a, b) => {
          const aIdx = pipelineOrder.indexOf(parseInt(a.seq, 10));
          const bIdx = pipelineOrder.indexOf(parseInt(b.seq, 10));
          // Cards in pipeline_order come first, in order; others after
          if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
          if (aIdx >= 0) return -1;
          if (bIdx >= 0) return 1;
          return parseInt(a.seq, 10) - parseInt(b.seq, 10);
        });
      }
      let launchedThisTick = 0;
      const failedSlots = new Set<string>(); // track slots that failed launch this tick
      for (const card of todoCards) {
        if (actionsThisTick >= maxActions) break;
        if (this.shouldSkip(card)) {
          actions.push({ action: 'skip', entity: `seq:${card.seq}`, result: 'skip', message: 'Has auxiliary state label' });
          continue;
        }
        // Stagger is handled by ResourceLimiter.enforceStagger() inside launchCard
        const launchResult = await this.launchCard(card, opts, failedSlots);
        actions.push(launchResult);
        if (launchResult.result === 'ok') {
          actionsThisTick++;
          launchedThisTick++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Pipeline tick failed: ${msg}`);
      result.status = 'fail';
      result.exitCode = 1;
      result.details = { error: msg };
    }

    // Check for any failures
    if (actions.some((a) => a.result === 'fail') && result.status === 'ok') {
      result.status = 'fail';
      result.exitCode = 1;
    }

    return result;
  }

  /**
   * Launch a single card (for `sps worker launch <project> <seq>`).
   * Assumes card is in Todo state with branch/worktree already prepared.
   */
  async launchSingle(seq: string, opts: { dryRun?: boolean } = {}): Promise<CommandResult> {
    const result: CommandResult = {
      project: this.ctx.projectName,
      component: 'worker-launch',
      status: 'ok',
      exitCode: 0,
      actions: [],
      recommendedActions: [],
      details: {},
    };

    const card = await this.taskBackend.getBySeq(seq);
    if (!card) {
      result.status = 'fail';
      result.exitCode = 1;
      result.details = { error: `Card seq:${seq} not found` };
      return result;
    }

    // If card is in Backlog, do prepare first
    if (card.state === 'Backlog') {
      const prepareAction = await this.prepareCard(card, opts);
      result.actions.push(prepareAction);
      if (prepareAction.result === 'fail') {
        result.status = 'fail';
        result.exitCode = 1;
        return result;
      }
      // Reload card after prepare
      const updated = await this.taskBackend.getBySeq(seq);
      if (!updated || updated.state !== 'Todo') {
        result.status = 'fail';
        result.exitCode = 1;
        result.details = { error: 'Card not in Todo after prepare' };
        return result;
      }
    }

    if (card.state !== 'Todo' && card.state !== 'Backlog') {
      result.status = 'fail';
      result.exitCode = 2;
      result.details = { error: `Card seq:${seq} is in ${card.state}, expected Backlog or Todo` };
      return result;
    }

    const launchAction = await this.launchCard(card, opts);
    result.actions.push(launchAction);
    if (launchAction.result === 'fail') {
      result.status = 'fail';
      result.exitCode = 1;
    }

    return result;
  }

  private shouldSkip(card: Card): boolean {
    return SKIP_LABELS.some((label) => card.labels.includes(label));
  }

  // ─── Inprogress Phase (detect completion → Done) ────────────────

  /**
   * Check an Inprogress card: verify worker is still running or handled by exit callback.
   *
   * The Supervisor exit callback triggers CompletionJudge → PostActions automatically,
   * so this method only needs to:
   * - Update heartbeat if worker is still running
   * - Confirm completion if PostActions already processed it
   */
  private async checkInprogressCard(
    card: Card,
    opts: { dryRun?: boolean },
  ): Promise<ActionRecord | null> {
    const seq = card.seq;
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);

    const slotEntry = Object.entries(state.workers).find(
      ([, w]) => w.seq === parseInt(seq, 10) && w.status === 'active',
    );

    if (!slotEntry) {
      // Slot already released (PostActions handled it via exit callback)
      return null;
    }

    const [slotName] = slotEntry;
    const workerId = `${this.ctx.projectName}:${slotName}:${seq}`;
    const handle = this.supervisor.get(workerId);

    if (handle && handle.exitCode === null) {
      // Worker still running — update heartbeat
      try {
        const freshState = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
        if (freshState.workers[slotName]) {
          freshState.workers[slotName].lastHeartbeat = new Date().toISOString();
          writeState(this.ctx.paths.stateFile, freshState, 'pipeline-heartbeat');
        }
      } catch { /* non-fatal */ }
      return null;
    }

    if (handle && handle.exitCode !== null) {
      // Worker exited but PostActions hasn't finished yet (or just finished)
      // Check if slot is now idle
      const freshState = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
      if (!freshState.workers[slotName] || freshState.workers[slotName].status === 'idle') {
        this.log.ok(`seq ${seq}: Completed (handled by exit callback)`);
        return { action: 'complete', entity: `seq:${seq}`, result: 'ok', message: 'Completed via exit callback' };
      }
      // PostActions still processing, wait for next tick
      return null;
    }

    // Handle not found in Supervisor — PostActions already removed it, or after tick restart
    // Re-read state to check if PostActions already completed
    const freshState = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    if (!freshState.workers[slotName] || freshState.workers[slotName].status === 'idle') {
      this.log.ok(`seq ${seq}: Completed (PostActions already processed)`);
      return { action: 'complete', entity: `seq:${seq}`, result: 'ok', message: 'Completed (PostActions processed)' };
    }
    // Still active in state but not in Supervisor — MonitorEngine/Recovery handles
    return null;
  }

  // ─── Prepare Phase (Backlog → Todo) ─────────────────────────────

  /**
   * Prepare a Backlog card: create branch, create worktree, move to Todo.
   * Steps 1-3 per 01 §4.3.
   */
  private async prepareCard(card: Card, opts: { dryRun?: boolean }): Promise<ActionRecord> {
    const seq = card.seq;
    const branchName = this.buildBranchName(card);
    const worktreePath = resolveWorktreePath(this.ctx.projectName, seq, this.ctx.config.WORKTREE_DIR);

    if (opts.dryRun) {
      this.log.info(`[dry-run] Would prepare seq ${seq}: branch=${branchName} worktree=${worktreePath}`);
      return { action: 'prepare', entity: `seq:${seq}`, result: 'ok', message: 'dry-run' };
    }

    // Step 1: Create branch
    try {
      await this.repoBackend.ensureBranch(
        this.ctx.paths.repoDir,
        branchName,
        this.ctx.mergeBranch,
      );
      this.log.ok(`Step 1: Branch ${branchName} created for seq ${seq}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Step 1 failed (branch) for seq ${seq}: ${msg}`);
      this.logEvent('prepare-branch', seq, 'fail', { error: msg });
      return { action: 'prepare', entity: `seq:${seq}`, result: 'fail', message: `Branch creation failed: ${msg}` };
    }

    // Step 2: Create worktree
    try {
      await this.repoBackend.ensureWorktree(
        this.ctx.paths.repoDir,
        branchName,
        worktreePath,
      );
      this.log.ok(`Step 2: Worktree created for seq ${seq} at ${worktreePath}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Step 2 failed (worktree) for seq ${seq}: ${msg}`);
      this.logEvent('prepare-worktree', seq, 'fail', { error: msg });
      // Rollback: cleanup branch (best effort, branch may have existed before)
      return { action: 'prepare', entity: `seq:${seq}`, result: 'fail', message: `Worktree creation failed: ${msg}` };
    }

    // Step 3: Move card to Todo
    try {
      await this.taskBackend.move(seq, 'Todo');
      this.log.ok(`Step 3: Moved seq ${seq} Backlog → Todo`);
      this.logEvent('prepare', seq, 'ok');
      if (this.notifier) {
        await this.notifier.send(`[${this.ctx.projectName}] seq:${seq} environment ready (Backlog → Todo)`, 'info').catch(() => {});
      }
      return { action: 'prepare', entity: `seq:${seq}`, result: 'ok', message: 'Backlog → Todo' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Step 3 failed (move) for seq ${seq}: ${msg}`);
      this.logEvent('prepare-move', seq, 'fail', { error: msg });
      // Rollback: cleanup branch + worktree would be ideal but risky; log for manual cleanup
      return { action: 'prepare', entity: `seq:${seq}`, result: 'fail', message: `Move to Todo failed: ${msg}` };
    }
  }

  // ─── Launch Phase (Todo → Inprogress) ────────────────────────────

  /**
   * Launch a Todo card: claim slot, build context, start worker, move to Inprogress.
   * Steps 4-7 per 01 §4.3.
   */
  private async launchCard(
    card: Card,
    opts: { dryRun?: boolean },
    failedSlots: Set<string> = new Set(),
  ): Promise<ActionRecord> {
    const seq = card.seq;
    const branchName = this.buildBranchName(card);
    const worktreePath = resolveWorktreePath(this.ctx.projectName, seq, this.ctx.config.WORKTREE_DIR);

    if (opts.dryRun) {
      this.log.info(`[dry-run] Would launch seq ${seq}`);
      return { action: 'launch', entity: `seq:${seq}`, result: 'ok', message: 'dry-run' };
    }

    // Step 4: Claim worker slot
    // Exclude slots that failed launch this tick to prevent repeated failures
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    const idleSlots = Object.entries(state.workers)
      .filter(([name, w]) => w.status === 'idle' && !failedSlots.has(name));
    if (idleSlots.length === 0) {
      this.log.warn(`No idle worker slot available for seq ${seq}`);
      return { action: 'launch', entity: `seq:${seq}`, result: 'skip', message: 'No idle worker slot' };
    }

    const [slotName] = idleSlots[0];
    const sessionName = `${this.ctx.projectName}-${slotName}`;

    // Claim slot in state.json
    state.workers[slotName] = {
      status: 'active',
      seq: parseInt(seq, 10),
      branch: branchName,
      worktree: worktreePath,
      tmuxSession: sessionName,
      claimedAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      mode: this.ctx.config.WORKER_MODE,
      sessionId: null,
      pid: null,
      outputFile: null,
      exitCode: null,
    };

    // Add to active cards
    const conflictDomains = card.labels
      .filter((l) => l.startsWith('conflict:'))
      .map((l) => l.slice('conflict:'.length));

    state.activeCards[seq] = {
      seq: parseInt(seq, 10),
      state: 'Todo',
      worker: slotName,
      mrUrl: null,
      conflictDomains,
      startedAt: new Date().toISOString(),
    };

    try {
      writeState(this.ctx.paths.stateFile, state, 'pipeline-launch');
      this.log.ok(`Step 4: Claimed slot ${slotName} for seq ${seq}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Step 4 failed (claim) for seq ${seq}: ${msg}`);
      return { action: 'launch', entity: `seq:${seq}`, result: 'fail', message: `Claim slot failed: ${msg}` };
    }

    // Also claim in PM backend
    try {
      await this.taskBackend.claim(seq, slotName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`PM claim for seq ${seq} failed (non-fatal): ${msg}`);
    }

    // Step 5: Build task context (CLAUDE.md + .jarvis_task_prompt.txt)
    try {
      this.buildTaskContext(card, worktreePath);
      this.log.ok(`Step 5: Task context built for seq ${seq}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Step 5 failed (context) for seq ${seq}: ${msg}`);
      this.releaseSlot(slotName, seq);
      this.logEvent('launch-context', seq, 'fail', { error: msg });
      return { action: 'launch', entity: `seq:${seq}`, result: 'fail', message: `Context build failed: ${msg}` };
    }

    // Step 6: Launch worker via Supervisor
    try {
      const promptFile = resolve(worktreePath, '.jarvis_task_prompt.txt');

      // Check global resource limit
      if (!this.resourceLimiter.tryAcquire()) {
        this.log.warn(`Global worker limit reached, skipping seq ${seq}`);
        // Rollback: release slot
        this.releaseSlot(slotName, seq);
        return { action: 'launch', entity: `seq:${seq}`, result: 'skip', message: 'Global worker limit reached' };
      }

      await this.resourceLimiter.enforceStagger();

      const prompt = readFileSync(promptFile, 'utf-8').trim();
      const outputFile = resolve(
        this.ctx.config.raw.LOGS_DIR || `/tmp/sps-${this.ctx.projectName}`,
        `${sessionName}-${Date.now()}.jsonl`,
      );
      const workerId = `${this.ctx.projectName}:${slotName}:${card.seq}`;

      const workerHandle = this.supervisor.spawn({
        id: workerId,
        project: this.ctx.projectName,
        seq: card.seq,
        slot: slotName,
        worktree: worktreePath,
        branch: branchName,
        prompt,
        outputFile,
        tool: this.ctx.config.WORKER_TOOL,
        onExit: (exitCode: number) => {
          this.onWorkerExit(workerId, card, slotName, worktreePath, branchName, exitCode);
        },
      });

      // Store process info in state
      const freshState = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
      if (freshState.workers[slotName]) {
        freshState.workers[slotName].mode = 'print';
        freshState.workers[slotName].pid = workerHandle.pid;
        freshState.workers[slotName].outputFile = workerHandle.outputFile;
        freshState.workers[slotName].sessionId = workerHandle.sessionId || null;
        freshState.workers[slotName].exitCode = null;
        writeState(this.ctx.paths.stateFile, freshState, 'pipeline-launch-print');
      }

      this.log.ok(`Step 6: Worker launched for seq ${seq} (pid=${workerHandle.pid})`);

      if (this.notifier) {
        await this.notifier.sendSuccess(`[${this.ctx.projectName}] seq:${seq} worker started (${slotName})`).catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Step 6 failed (worker launch) for seq ${seq}: ${msg}`);
      failedSlots.add(slotName);
      this.resourceLimiter.release();
      this.releaseSlot(slotName, seq);
      this.logEvent('launch-worker', seq, 'fail', { error: msg });
      return { action: 'launch', entity: `seq:${seq}`, result: 'fail', message: `Worker launch failed: ${msg}` };
    }

    // Step 7: Move card to Inprogress
    try {
      await this.taskBackend.move(seq, 'Inprogress');
      // Update active card state
      const freshState = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
      if (freshState.activeCards[seq]) {
        freshState.activeCards[seq].state = 'Inprogress';
        writeState(this.ctx.paths.stateFile, freshState, 'pipeline-launch');
      }
      this.log.ok(`Step 7: Moved seq ${seq} Todo → Inprogress`);
      this.logEvent('launch', seq, 'ok', { worker: slotName, session: sessionName });
      return { action: 'launch', entity: `seq:${seq}`, result: 'ok', message: `Todo → Inprogress (${slotName})` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Step 7 failed (move) for seq ${seq}: ${msg}`);
      // Rollback: kill worker, release slot
      const workerId = `${this.ctx.projectName}:${slotName}:${card.seq}`;
      try { await this.supervisor.kill(workerId); } catch { /* best effort */ }
      this.resourceLimiter.release();
      this.releaseSlot(slotName, seq);
      this.logEvent('launch-move', seq, 'fail', { error: msg });
      return { action: 'launch', entity: `seq:${seq}`, result: 'fail', message: `Move to Inprogress failed: ${msg}` };
    }
  }

  // ─── Worker Exit Callback ───────────────────────────────────────

  /**
   * Called by Supervisor when a worker process exits.
   * Wires CompletionJudge → PostActions to handle completion or failure.
   */
  private async onWorkerExit(
    workerId: string,
    card: Card,
    slotName: string,
    worktree: string,
    branch: string,
    exitCode: number,
  ): Promise<void> {
    const handle = this.supervisor.get(workerId);
    const completion = this.completionJudge.judge({
      worktree,
      branch,
      baseBranch: this.ctx.mergeBranch,
      outputFile: handle?.outputFile || null,
      exitCode,
      logsDir: this.ctx.paths.logsDir,
    });

    const ctx: PostActionContext = {
      project: this.ctx.projectName,
      seq: card.seq,
      slot: slotName,
      branch,
      worktree,
      baseBranch: this.ctx.mergeBranch,
      stateFile: this.ctx.paths.stateFile,
      maxWorkers: this.ctx.maxWorkers,
      mrMode: this.ctx.mrMode,
      gitlabProjectId: resolveGitlabProjectId(this.ctx.config),
      gitlabUrl: this.ctx.config.raw.GITLAB_URL || process.env.GITLAB_URL || '',
      gitlabToken: this.ctx.config.raw.GITLAB_TOKEN || process.env.GITLAB_TOKEN || '',
      doneStateId: this.ctx.config.raw.PLANE_STATE_DONE || this.ctx.config.raw.TRELLO_DONE_LIST_ID || '',
      maxRetries: this.ctx.config.WORKER_RESTART_LIMIT,
      logsDir: this.ctx.paths.logsDir,
      tool: this.ctx.config.WORKER_TOOL,
    };

    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    const activeCard = state.activeCards[card.seq];
    const retryCount = activeCard?.retryCount ?? 0;

    try {
      if (completion.status === 'completed') {
        const results = await this.postActions.executeCompletion(ctx, completion, handle?.sessionId || null);
        const allOk = results.every(r => r.ok);
        this.log.ok(`seq ${card.seq}: PostActions completed (${allOk ? 'all ok' : 'some failures'})`);
      } else {
        await this.postActions.executeFailure(ctx, completion, exitCode, handle?.sessionId || null, retryCount, {
          onExit: (code: number) => this.onWorkerExit(workerId, card, slotName, worktree, branch, code),
        });
        this.log.info(`seq ${card.seq}: Failure handling done`);
      }
    } catch (err) {
      this.log.error(`seq ${card.seq}: PostActions error: ${err}`);
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────

  /**
   * Build branch name from card: feature/<seq>-<slug>
   */
  private buildBranchName(card: Card): string {
    const slug = card.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    return `feature/${card.seq}-${slug}`;
  }

  /**
   * Write task-specific prompt to worktree.
   *
   * CLAUDE.md and AGENTS.md are managed by `sps doctor --fix` and committed
   * to the repo — worktrees inherit them automatically via git.
   *
   * The prompt file includes the project rules (from CLAUDE.md) followed by
   * the task-specific details. This ensures that when a session is reused
   * (WORKER_SESSION_REUSE=true), the worker always receives the latest
   * project rules via tmux paste — even though /clear + cd does not
   * trigger Claude/Codex to re-read CLAUDE.md from disk.
   */
  private buildTaskContext(card: Card, worktreePath: string): void {
    if (!existsSync(worktreePath)) {
      mkdirSync(worktreePath, { recursive: true });
    }

    const branchName = this.buildBranchName(card);

    // ── 1. Skill Profiles (label-driven) ──
    const skillContent = this.loadSkillProfiles(card);

    // ── 2. Project Rules (CLAUDE.md + AGENTS.md) ──
    const claudeMdPath = resolve(worktreePath, 'CLAUDE.md');
    const agentsMdPath = resolve(worktreePath, 'AGENTS.md');
    let projectRules = '';
    if (existsSync(claudeMdPath)) {
      projectRules = readFileSync(claudeMdPath, 'utf-8').trim();
    } else {
      this.log.warn(`CLAUDE.md not found in worktree — run: sps doctor ${this.ctx.projectName} --fix`);
    }
    if (existsSync(agentsMdPath)) {
      const agentsRules = readFileSync(agentsMdPath, 'utf-8').trim();
      projectRules = projectRules ? `${projectRules}\n\n${agentsRules}` : agentsRules;
    }

    // ── 3. Project Knowledge (truncated) ──
    const knowledge = this.loadProjectKnowledge(worktreePath);

    // ── Assemble prompt ──
    const sections: string[] = [];

    if (skillContent) {
      sections.push(skillContent);
      sections.push('---');
    }

    if (projectRules) {
      sections.push(projectRules);
      sections.push('---');
    }

    if (knowledge) {
      sections.push(knowledge);
      sections.push('---');
    }

    // Build requirements based on MR mode
    const mrMode = this.ctx.mrMode;   // 'none' | 'create'
    const createMR = mrMode === 'create';

    // Generate .jarvis/merge.sh
    this.writeMergeScript(worktreePath, branchName, card, createMR);

    const mergeStepDesc = createMR
      ? 'Create the Merge Request'
      : `Merge your changes into ${this.ctx.mergeBranch}`;

    const requirements = [
      '1. Implement the changes described above',
      '2. Self-test your changes (run existing tests if any, ensure no regressions)',
      '3. Update project knowledge (create docs/ dir if needed):',
      '   - If you made architecture/design choices, append to docs/DECISIONS.md:',
      `     ## [${card.seq}-${card.name}] ${new Date().toISOString().slice(0, 10)}`,
      '     - Decision: ...',
      '     - Reason: ...',
      '   - Append a summary of your changes to docs/CHANGELOG.md:',
      `     ## [${card.seq}-${card.name}] ${new Date().toISOString().slice(0, 10)}`,
      '     - What changed and why',
      `4. git add, commit, and push to branch ${branchName}`,
      `5. ${mergeStepDesc} by running:`,
      '   ```bash',
      '   bash .jarvis/merge.sh',
      '   ```',
      '6. Verify the script output shows success, then say "done"',
    ];

    requirements.push('');
    requirements.push('IMPORTANT: You MUST complete ALL steps above. Step 5 (bash .jarvis/merge.sh) is MANDATORY — just pushing code is NOT enough. After completing, say "done" and STOP. Do NOT run long-running commands (npm run dev, npm start, yarn dev, docker compose up, or any dev server / watch mode).');

    sections.push(`# Current Task

Task ID: ${card.seq}
Task: ${card.name}
Branch: ${branchName}
Target Branch: ${this.ctx.mergeBranch}
Card Full ID: ${card.id}
GitLab Project ID: ${resolveGitlabProjectId(this.ctx.config)}
MR Mode: ${mrMode}

Description:
${card.desc || '(no description)'}

Requirements:
${requirements.join('\n')}`);

    writeFileSync(
      resolve(worktreePath, '.jarvis_task_prompt.txt'),
      sections.join('\n\n') + '\n',
    );
  }

  /**
   * Write .jarvis/merge.sh into the worktree.
   * A self-contained script that creates MR and (if no CI) merges it.
   * Worker just runs: bash .jarvis/merge.sh
   */
  private writeMergeScript(
    worktreePath: string,
    branchName: string,
    card: Card,
    createMR: boolean,
  ): void {
    const jarvisDir = resolve(worktreePath, '.jarvis');
    if (!existsSync(jarvisDir)) {
      mkdirSync(jarvisDir, { recursive: true });
    }

    const gitlabProjectId = resolveGitlabProjectId(this.ctx.config);
    const gitlabUrl = this.ctx.config.raw.GITLAB_URL || process.env.GITLAB_URL || '';
    const gitlabToken = this.ctx.config.raw.GITLAB_TOKEN || process.env.GITLAB_TOKEN || '';
    const targetBranch = this.ctx.mergeBranch;
    const title = `${card.seq}: ${card.name}`.replace(/"/g, '\\"');

    let lines: string[];

    if (!createMR) {
      // ── MR_MODE=none: direct git merge to target branch ──
      lines = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        '',
        '# Auto-generated by sps pipeline. Merges feature branch directly into target.',
        '',
        `SOURCE_BRANCH="${branchName}"`,
        `TARGET_BRANCH="${targetBranch}"`,
        '',
        'echo "Merging $SOURCE_BRANCH → $TARGET_BRANCH"',
        '',
        '# Ensure we have latest target',
        'git fetch origin "$TARGET_BRANCH"',
        '',
        '# Rebase feature onto latest target to avoid conflicts',
        'git rebase "origin/$TARGET_BRANCH" || {',
        '  echo "Rebase conflict — attempting to resolve..."',
        '  git rebase --abort 2>/dev/null || true',
        '  echo "ERROR: Rebase failed. Please resolve conflicts manually."',
        '  exit 1',
        '}',
        '',
        '# Switch to target, merge, push',
        'git checkout "$TARGET_BRANCH"',
        'git pull origin "$TARGET_BRANCH"',
        `git merge --no-ff "$SOURCE_BRANCH" -m "Merge ${branchName} into ${targetBranch}"`,
        'git push origin "$TARGET_BRANCH"',
        '',
        'echo "Successfully merged $SOURCE_BRANCH into $TARGET_BRANCH"',
        'echo "done"',
      ];
    } else {
      // ── MR_MODE=create: create MR via GitLab API ──
      lines = [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        '',
        '# Auto-generated by sps pipeline. Creates MR for CI.',
        '',
        `GITLAB_URL="${gitlabUrl}"`,
        `GITLAB_TOKEN="${gitlabToken}"`,
        `PROJECT_ID="${gitlabProjectId}"`,
        `SOURCE_BRANCH="${branchName}"`,
        `TARGET_BRANCH="${targetBranch}"`,
        `TITLE="${title}"`,
        '',
        'API="$GITLAB_URL/api/v4/projects/$PROJECT_ID"',
        '',
        'echo "Creating MR: $SOURCE_BRANCH → $TARGET_BRANCH"',
        'MR_RESPONSE=$(curl -sf -X POST \\',
        '  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \\',
        '  -H "Content-Type: application/json" \\',
        '  -d "{',
        '    \\"source_branch\\": \\"$SOURCE_BRANCH\\",',
        '    \\"target_branch\\": \\"$TARGET_BRANCH\\",',
        '    \\"title\\": \\"$TITLE\\"',
        '  }" \\',
        '  "$API/merge_requests" 2>&1) || {',
        '  echo "Create failed, looking for existing MR..."',
        '  MR_RESPONSE=$(curl -sf \\',
        '    -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \\',
        '    "$API/merge_requests?source_branch=$SOURCE_BRANCH&target_branch=$TARGET_BRANCH&state=opened" \\',
        '    | sed "s/^\\[//;s/\\]$//")',
        '}',
        '',
        'MR_IID=$(echo "$MR_RESPONSE" | grep -o \'"iid":[0-9]*\' | head -1 | grep -o \'[0-9]*\')',
        '',
        'if [ -z "$MR_IID" ]; then',
        '  echo "ERROR: Failed to create or find MR"',
        '  exit 1',
        'fi',
        '',
        'echo "MR created (iid=$MR_IID)"',
        'echo "done"',
      ];
    }

    writeFileSync(resolve(jarvisDir, 'merge.sh'), lines.join('\n') + '\n', { mode: 0o755 });
  }

  /**
   * Release a worker slot and remove card from active cards.
   * Used for launch failure rollback.
   */
  private releaseSlot(slotName: string, seq: string): void {
    try {
      const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
      if (state.workers[slotName]) {
        state.workers[slotName] = {
          status: 'idle',
          seq: null,
          branch: null,
          worktree: null,
          tmuxSession: null,
          claimedAt: null,
          lastHeartbeat: null,
          mode: null,
          sessionId: null,
          pid: null,
          outputFile: null,
          exitCode: null,
        };
      }
      delete state.activeCards[seq];
      writeState(this.ctx.paths.stateFile, state, 'pipeline-release');
      this.taskBackend.releaseClaim(seq).catch(() => {});
    } catch {
      this.log.warn(`Failed to release slot ${slotName} for seq ${seq}`);
    }
  }

  // ─── Skill Profile Loading (label-driven) ─────────────────────

  /**
   * Load skill profiles based on card labels (skill:xxx) or project default.
   * Returns combined profile content for prompt injection.
   */
  private loadSkillProfiles(card: Card): string {
    // 1. Extract skill:xxx labels from card
    let skills = card.labels
      .filter(l => l.startsWith('skill:'))
      .map(l => l.slice('skill:'.length));

    // 2. Fallback to project default
    if (skills.length === 0) {
      const defaultSkills = this.ctx.config.raw.DEFAULT_WORKER_SKILLS;
      if (defaultSkills) {
        skills = defaultSkills.split(',').map(s => s.trim()).filter(Boolean);
      }
    }

    if (skills.length === 0) return '';

    // 3. Load profile files
    const frameworkDir = this.ctx.config.raw.FRAMEWORK_DIR
      || resolve(process.env.HOME || '~', 'jarvis-skills');
    const profilesDir = resolve(frameworkDir, 'skills', 'worker-profiles');
    const sections: string[] = ['# Skill Profiles'];

    for (const skill of skills) {
      const filePath = resolve(profilesDir, `${skill}.md`);
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, 'utf-8').trim();
        // Strip YAML frontmatter
        const body = content.replace(/^---[\s\S]*?---\s*/, '');
        sections.push(body);
        this.log.ok(`Loaded skill profile: ${skill}`);
      } else {
        this.log.warn(`Skill profile not found: ${filePath}`);
      }
    }

    return sections.length > 1 ? sections.join('\n\n') : '';
  }

  // ─── Project Knowledge Loading (truncated) ────────────────────

  /**
   * Load recent project knowledge from docs/DECISIONS.md and docs/CHANGELOG.md.
   * Truncates to recent entries to keep prompt size manageable.
   */
  private loadProjectKnowledge(worktreePath: string): string {
    const sections: string[] = ['# Project Knowledge (from previous tasks)'];
    let hasContent = false;

    // Recent decisions (last 10 sections)
    const decisionsPath = resolve(worktreePath, 'docs', 'DECISIONS.md');
    if (existsSync(decisionsPath)) {
      const content = readFileSync(decisionsPath, 'utf-8');
      const recent = this.extractRecentSections(content, 10);
      if (recent) {
        sections.push('## Recent Decisions\n' + recent);
        hasContent = true;
      }
    }

    // Recent changelog (last 5 sections)
    const changelogPath = resolve(worktreePath, 'docs', 'CHANGELOG.md');
    if (existsSync(changelogPath)) {
      const content = readFileSync(changelogPath, 'utf-8');
      const recent = this.extractRecentSections(content, 5);
      if (recent) {
        sections.push('## Recent Changes\n' + recent);
        hasContent = true;
      }
    }

    return hasContent ? sections.join('\n\n') : '';
  }

  /**
   * Extract the last N ## sections from a markdown file.
   */
  private extractRecentSections(content: string, maxSections: number): string {
    const lines = content.split('\n');
    const sectionStarts: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) {
        sectionStarts.push(i);
      }
    }
    if (sectionStarts.length === 0) return content.trim();
    const start = sectionStarts[Math.max(0, sectionStarts.length - maxSections)];
    return lines.slice(start).join('\n').trim();
  }

  private logEvent(action: string, seq: string, result: 'ok' | 'fail', meta?: Record<string, unknown>): void {
    this.log.event({
      component: 'pipeline',
      action,
      entity: `seq:${seq}`,
      result,
      meta,
    });
  }
}
