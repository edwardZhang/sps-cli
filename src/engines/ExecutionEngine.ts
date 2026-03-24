import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectContext } from '../core/context.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { WorkerProvider } from '../interfaces/WorkerProvider.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { CommandResult, ActionRecord, Card, AuxiliaryState } from '../models/types.js';
import type { LaunchResult } from '../interfaces/WorkerProvider.js';
import { readState, writeState, type WorkerSlotState } from '../core/state.js';
import { resolveWorktreePath } from '../core/paths.js';
import { Logger } from '../core/logger.js';

const SKIP_LABELS: AuxiliaryState[] = ['BLOCKED', 'NEEDS-FIX', 'CONFLICT', 'WAITING-CONFIRMATION', 'STALE-RUNTIME'];

export class ExecutionEngine {
  private log: Logger;

  constructor(
    private ctx: ProjectContext,
    private taskBackend: TaskBackend,
    private workerProvider: WorkerProvider,
    private repoBackend: RepoBackend,
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
      //    Stagger launches to avoid overwhelming tmux/system.
      const todoCards = await this.taskBackend.listByState('Todo');
      let launchedThisTick = 0;
      const failedSlots = new Set<string>(); // track slots that failed launch this tick
      for (const card of todoCards) {
        if (actionsThisTick >= maxActions) break;
        if (this.shouldSkip(card)) {
          actions.push({ action: 'skip', entity: `seq:${card.seq}`, result: 'skip', message: 'Has auxiliary state label' });
          continue;
        }
        // Stagger: wait between worker launches (shorter for print mode)
        if (launchedThisTick > 0) {
          const delay = this.ctx.config.WORKER_MODE === 'print' ? 2_000 : 10_000;
          this.log.info(`Waiting ${delay / 1000}s before next worker launch...`);
          await new Promise((r) => setTimeout(r, delay));
        }
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

  // ─── Inprogress Phase (detect completion → QA) ──────────────────

  /**
   * Check an Inprogress card: detect worker completion status and act.
   * This is the critical Inprogress → QA bridge (01 §10.2).
   *
   * Detection chain (12 §2):
   *   COMPLETED      → move card to QA
   *   AUTO_CONFIRM   → auto-confirm prompt, continue next tick
   *   NEEDS_INPUT    → mark WAITING-CONFIRMATION, notify
   *   BLOCKED        → mark BLOCKED
   *   ALIVE          → no action (worker still working)
   *   DEAD           → mark STALE-RUNTIME (handled by MonitorEngine)
   *   DEAD_EXCEEDED  → mark STALE-RUNTIME, notify
   */
  private async checkInprogressCard(
    card: Card,
    opts: { dryRun?: boolean },
  ): Promise<ActionRecord | null> {
    const seq = card.seq;
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);

    // Find this card's worker slot
    const slotEntry = Object.entries(state.workers).find(
      ([, w]) => w.seq === parseInt(seq, 10) && w.status === 'active',
    );
    if (!slotEntry) {
      // No active slot — MonitorEngine handles orphan detection
      return null;
    }

    const [slotName, slotState] = slotEntry;
    const session = slotState.tmuxSession;
    if (!session) return null;

    // Determine logDir for completion marker detection
    const logDir = this.ctx.paths.logsDir;
    const branch = slotState.branch || this.buildBranchName(card);

    let workerStatus: import('../models/types.js').WorkerStatus;
    try {
      workerStatus = await this.workerProvider.detectCompleted(session, logDir, branch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`detectCompleted failed for seq ${seq}: ${msg}`);
      return null;
    }

    switch (workerStatus) {
      case 'COMPLETED': {
        if (opts.dryRun) {
          this.log.info(`[dry-run] Would move seq ${seq} Inprogress → QA`);
          return { action: 'complete', entity: `seq:${seq}`, result: 'ok', message: 'dry-run: would move to QA' };
        }

        // Check if MR exists before moving to QA — worker may still be creating it
        try {
          const mrStatus = await this.repoBackend.getMrStatus(branch);
          if (!mrStatus.exists) {
            this.log.info(`seq ${seq}: Worker completed but MR not yet created, waiting`);
            return null; // retry next tick
          }
        } catch {
          // Can't check MR — proceed anyway, closeout will handle it
        }

        // Move card to QA
        try {
          await this.taskBackend.move(seq, 'QA');
          this.log.ok(`seq ${seq}: Worker completed, moved Inprogress → QA`);

          // Update state.json
          const freshState = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
          if (freshState.activeCards[seq]) {
            freshState.activeCards[seq].state = 'QA';
            writeState(this.ctx.paths.stateFile, freshState, 'pipeline-complete');
          }

          this.logEvent('complete', seq, 'ok', { worker: slotName });
          if (this.notifier) {
            await this.notifier.sendSuccess(`[${this.ctx.projectName}] seq:${seq} worker completed, moved to QA`).catch(() => {});
          }
          return { action: 'complete', entity: `seq:${seq}`, result: 'ok', message: 'Inprogress → QA (worker completed)' };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.error(`Failed to move seq ${seq} to QA: ${msg}`);
          return { action: 'complete', entity: `seq:${seq}`, result: 'fail', message: `Move to QA failed: ${msg}` };
        }
      }

      case 'AUTO_CONFIRM': {
        // Non-destructive confirmation prompt → auto-confirm
        this.log.info(`seq ${seq}: Worker waiting for non-destructive confirmation, auto-confirming`);
        try {
          await this.workerProvider.sendFix(session, 'y');
          this.logEvent('auto-confirm', seq, 'ok');
          if (this.notifier) {
            await this.notifier.send(`[${this.ctx.projectName}] seq:${seq} auto-confirmed`, 'info').catch(() => {});
          }
        } catch {
          this.log.warn(`seq ${seq}: Auto-confirm failed`);
        }
        return { action: 'auto-confirm', entity: `seq:${seq}`, result: 'ok', message: 'Auto-confirmed non-destructive prompt' };
      }

      case 'NEEDS_INPUT': {
        // Destructive confirmation → mark WAITING-CONFIRMATION, notify Boss
        this.log.warn(`seq ${seq}: Worker waiting for destructive confirmation`);
        try {
          await this.taskBackend.addLabel(seq, 'WAITING-CONFIRMATION');
        } catch { /* best effort */ }
        if (this.notifier) {
          await this.notifier.sendWarning(`[${this.ctx.projectName}] seq:${seq} worker waiting for destructive confirmation`).catch(() => {});
        }
        this.logEvent('waiting-destructive', seq, 'ok');
        return { action: 'mark-waiting', entity: `seq:${seq}`, result: 'ok', message: 'Destructive confirmation — waiting for human' };
      }

      case 'BLOCKED': {
        this.log.warn(`seq ${seq}: Worker appears blocked`);
        try {
          await this.taskBackend.addLabel(seq, 'BLOCKED');
        } catch { /* best effort */ }
        this.logEvent('blocked', seq, 'ok');
        return { action: 'mark-blocked', entity: `seq:${seq}`, result: 'ok', message: 'Worker blocked' };
      }

      case 'EXITED_INCOMPLETE':
      case 'DEAD':
      case 'DEAD_EXCEEDED': {
        // Worker exited without completing. Attempt auto-resume if:
        //   - Print mode (can --resume to continue context)
        //   - Retry limit not exhausted
        // Otherwise mark NEEDS-FIX.
        const isPrintMode = slotState.mode === 'print';
        const reason = workerStatus === 'EXITED_INCOMPLETE'
          ? 'exited without artifacts (token limit / gave up)'
          : `process died (${workerStatus})`;
        this.log.warn(`seq ${seq}: Worker ${reason}`);

        if (isPrintMode && slotState.sessionId) {
          const retryResult = await this.attemptResume(
            seq, slotName, slotState, card, reason,
          );
          if (retryResult) return retryResult;
        }

        // No resume possible or retries exhausted → NEEDS-FIX
        if (workerStatus === 'DEAD' || workerStatus === 'DEAD_EXCEEDED') {
          // Also defer to MonitorEngine for STALE-RUNTIME marking
          return null;
        }
        try {
          await this.taskBackend.addLabel(seq, 'NEEDS-FIX');
          await this.taskBackend.comment(seq, `Worker ${reason}. Resume retries exhausted.`);
        } catch { /* best effort */ }
        if (this.notifier) {
          await this.notifier.sendWarning(
            `[${this.ctx.projectName}] seq:${seq} worker ${reason} — retries exhausted, NEEDS-FIX`,
          ).catch(() => {});
        }
        this.logEvent('exited-incomplete-final', seq, 'ok');
        return { action: 'mark-needs-fix', entity: `seq:${seq}`, result: 'ok', message: `Worker ${reason}, retries exhausted (NEEDS-FIX)` };
      }

      case 'ALIVE':
      default:
        // Worker still running — no action needed
        // Update heartbeat
        try {
          const freshState = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
          if (freshState.workers[slotName]) {
            freshState.workers[slotName].lastHeartbeat = new Date().toISOString();
            writeState(this.ctx.paths.stateFile, freshState, 'pipeline-heartbeat');
          }
        } catch { /* non-fatal */ }
        return null;
    }
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

    // Prefer slot with live session (Claude still running → context reuse)
    let slotEntry = idleSlots[0];
    if (this.ctx.config.WORKER_SESSION_REUSE) {
      for (const entry of idleSlots) {
        const [name] = entry;
        const sessionName = `${this.ctx.projectName}-${name}`;
        try {
          const inspection = await this.workerProvider.inspect(sessionName);
          if (inspection.alive) {
            slotEntry = entry;
            this.log.info(`Preferring slot ${name} with live session`);
            break;
          }
        } catch { /* ignore */ }
      }
    }

    const [slotName] = slotEntry;
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

    // Step 6: Launch worker (unified: launch + waitReady + sendTask in one call)
    try {
      const promptFile = resolve(worktreePath, '.jarvis_task_prompt.txt');
      const launchResult = await this.workerProvider.launch(sessionName, worktreePath, promptFile);

      // Store print-mode process info in state
      if (launchResult.pid > 0) {
        const freshState = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
        if (freshState.workers[slotName]) {
          freshState.workers[slotName].mode = 'print';
          freshState.workers[slotName].pid = launchResult.pid;
          freshState.workers[slotName].outputFile = launchResult.outputFile;
          freshState.workers[slotName].sessionId = launchResult.sessionId || null;
          freshState.workers[slotName].exitCode = null;
          writeState(this.ctx.paths.stateFile, freshState, 'pipeline-launch-print');
        }

        // Async: extract session ID from output once available
        this.extractSessionIdAsync(sessionName, slotName, launchResult);
      }

      this.log.ok(`Step 6: Worker launched in session ${sessionName} for seq ${seq}`);

      if (this.notifier) {
        await this.notifier.sendSuccess(`[${this.ctx.projectName}] seq:${seq} worker started (${slotName})`).catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Step 6 failed (worker launch) for seq ${seq}: ${msg}`);
      failedSlots.add(slotName);
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
      // Rollback: stop worker, release slot
      try { await this.workerProvider.stop(sessionName); } catch { /* best effort */ }
      this.releaseSlot(slotName, seq);
      this.logEvent('launch-move', seq, 'fail', { error: msg });
      return { action: 'launch', entity: `seq:${seq}`, result: 'fail', message: `Move to Inprogress failed: ${msg}` };
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

    // Read project rules from CLAUDE.md (if exists)
    const claudeMdPath = resolve(worktreePath, 'CLAUDE.md');
    let projectRules = '';
    if (existsSync(claudeMdPath)) {
      projectRules = readFileSync(claudeMdPath, 'utf-8').trim();
    } else {
      this.log.warn(`CLAUDE.md not found in worktree — run: sps doctor ${this.ctx.projectName} --fix`);
    }

    // .jarvis_task_prompt.txt — project rules + task-specific prompt
    // Print mode: piped via stdin to `claude -p` / `codex exec`
    // Interactive mode: pasted via tmux buffer
    const sections: string[] = [];

    if (projectRules) {
      sections.push(projectRules);
      sections.push('---');
    }

    // Build requirements based on CI mode
    const ciMode = this.ctx.config.CI_MODE;
    const hasCI = ciMode === 'gitlab' || ciMode === 'local';

    const requirements = [
      '1. Implement the changes described above',
      '2. Self-test your changes (run existing tests if any, ensure no regressions)',
      `3. git add, commit, and push to branch ${branchName}`,
      `4. Create a Merge Request targeting ${this.ctx.mergeBranch}`,
    ];

    if (hasCI) {
      // CI configured — Worker creates MR, pipeline handles CI wait + merge
      requirements.push('5. Say "done" when finished');
      requirements.push('');
      requirements.push('NOTE: CI pipeline will run automatically after you push. Do NOT wait for CI — just create the MR and say "done". The pipeline will handle CI monitoring and auto-merge.');
    } else {
      // No CI — Worker should merge the MR itself after verifying
      requirements.push('5. Verify the MR can be merged (no conflicts)');
      requirements.push('6. Merge the MR via GitLab API or git merge');
      requirements.push('7. Say "done" when finished');
    }

    requirements.push('');
    requirements.push('IMPORTANT: After completing, say "done" and STOP. Do NOT run long-running commands (npm run dev, npm start, yarn dev, python -m http.server, docker compose up, or any dev server / watch mode). These block the pipeline.');

    sections.push(`# Current Task

Task ID: ${card.seq}
Task: ${card.name}
Branch: ${branchName}
Target Branch: ${this.ctx.mergeBranch}
Card Full ID: ${card.id}
GitLab Project ID: ${this.ctx.config.GITLAB_PROJECT_ID}
CI Mode: ${ciMode}

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
   * Release a worker slot, cleanup tmux session, remove card from active cards.
   */
  private releaseSlot(slotName: string, seq: string): void {
    try {
      // Kill tmux session if it exists (cleanup from failed launch)
      const sessionName = `${this.ctx.projectName}-${slotName}`;
      this.workerProvider.stop(sessionName).catch(() => {});

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

  /**
   * Asynchronously extract session ID from print-mode output and update state.
   * Runs in background — does not block the tick.
   */
  private extractSessionIdAsync(
    sessionName: string,
    slotName: string,
    launchResult: LaunchResult,
  ): void {
    if (launchResult.sessionId) return; // already known (resume)

    // Check output file for session ID after a delay
    setTimeout(async () => {
      try {
        const { parseClaudeSessionId, parseCodexSessionId } = await import('../providers/outputParser.js');
        const parser = this.ctx.config.WORKER_TOOL === 'claude'
          ? parseClaudeSessionId
          : parseCodexSessionId;
        const sid = parser(launchResult.outputFile);
        if (sid) {
          const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
          if (state.workers[slotName]?.pid === launchResult.pid) {
            state.workers[slotName].sessionId = sid;
            writeState(this.ctx.paths.stateFile, state, 'pipeline-session-id');
            this.log.info(`Extracted session ID for ${sessionName}: ${sid.slice(0, 8)}...`);
          }
        }
      } catch { /* non-fatal */ }
    }, 5_000);
  }

  /**
   * Attempt to resume a failed/incomplete worker via --resume.
   *
   * Uses metaRead/metaWrite to track resumeAttempts per card.
   * Max retries = WORKER_RESTART_LIMIT (default 2).
   *
   * Returns an ActionRecord if resume was initiated, or null if retries exhausted.
   */
  private async attemptResume(
    seq: string,
    slotName: string,
    slotState: import('../core/state.js').WorkerSlotState,
    card: Card,
    reason: string,
  ): Promise<ActionRecord | null> {
    const maxRetries = this.ctx.config.WORKER_RESTART_LIMIT;

    let meta: Record<string, unknown>;
    try {
      meta = await this.taskBackend.metaRead(seq);
    } catch {
      meta = {};
    }

    const resumeAttempts = typeof meta.resumeAttempts === 'number' ? meta.resumeAttempts : 0;

    if (resumeAttempts >= maxRetries) {
      this.log.warn(`seq ${seq}: Resume retries exhausted (${resumeAttempts}/${maxRetries})`);
      return null; // caller handles NEEDS-FIX
    }

    const session = slotState.tmuxSession;
    const sessionId = slotState.sessionId;
    if (!session || !sessionId) {
      this.log.warn(`seq ${seq}: No session ID for resume`);
      return null;
    }

    try {
      // Build a continuation prompt that tells the worker to pick up where it left off
      const branch = slotState.branch || this.buildBranchName(card);
      const continuePrompt = [
        `Your previous session exited before the task was completed (${reason}).`,
        `This is resume attempt ${resumeAttempts + 1} of ${maxRetries}.`,
        '',
        `Task: ${card.name}`,
        `Branch: ${branch}`,
        `Target: ${this.ctx.mergeBranch}`,
        '',
        'Please check the current state of the code and continue:',
        '1. Review what has been done so far (git log, existing files)',
        '2. Complete any remaining implementation',
        '3. Self-test your changes',
        '4. git add, commit, and push to the branch',
        '5. Create a Merge Request if not already created',
        '6. Say "done" when finished',
        '',
        'IMPORTANT: After creating the MR, say "done" and STOP. Do NOT run dev servers or watch commands.',
      ].join('\n');

      const resumeResult = await this.workerProvider.sendFix(session, continuePrompt, sessionId);

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
          freshState.workers[slotName].lastHeartbeat = new Date().toISOString();
          writeState(this.ctx.paths.stateFile, freshState, 'pipeline-resume');
        }
      }

      // Increment resume counter
      await this.taskBackend.metaWrite(seq, {
        ...meta,
        resumeAttempts: resumeAttempts + 1,
      });

      this.log.info(`seq ${seq}: Resumed worker (attempt ${resumeAttempts + 1}/${maxRetries}), reason: ${reason}`);
      if (this.notifier) {
        await this.notifier.send(
          `[${this.ctx.projectName}] seq:${seq} worker resumed (${resumeAttempts + 1}/${maxRetries}): ${reason}`,
          'info',
        ).catch(() => {});
      }
      this.logEvent('resume', seq, 'ok', { attempt: resumeAttempts + 1, max: maxRetries, reason });
      return {
        action: 'resume',
        entity: `seq:${seq}`,
        result: 'ok',
        message: `Worker resumed (${resumeAttempts + 1}/${maxRetries}): ${reason}`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`seq ${seq}: Resume failed: ${msg}`);
      return null; // caller handles NEEDS-FIX
    }
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
