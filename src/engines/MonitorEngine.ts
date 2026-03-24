import type { ProjectContext } from '../core/context.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { WorkerProvider } from '../interfaces/WorkerProvider.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { CommandResult, ActionRecord, CheckResult, RecommendedAction, WorkerStatus } from '../models/types.js';
import { existsSync, statSync } from 'node:fs';
import { readState, writeState } from '../core/state.js';
import { Logger } from '../core/logger.js';

/**
 * MonitorEngine performs anomaly detection and health checks.
 *
 * Checks (in order):
 *   1. Orphan slot cleanup (doc 12 §6.1)
 *   2. Stale runtime detection (01 §10.2.3)
 *   3. Timeout detection (01 §10.2.4)
 *   4. Waiting confirmation detection (doc 12 §3)
 *   5. BLOCKED condition check (01 §3.6.1)
 *   6. State alignment (07 §2.1)
 */
export class MonitorEngine {
  private log: Logger;

  constructor(
    private ctx: ProjectContext,
    private taskBackend: TaskBackend,
    private workerProvider: WorkerProvider,
    private repoBackend: RepoBackend,
    private notifier?: Notifier,
  ) {
    this.log = new Logger('monitor', ctx.projectName, ctx.paths.logsDir);
  }

  async tick(): Promise<CommandResult> {
    const actions: ActionRecord[] = [];
    const checks: CheckResult[] = [];
    const recommendedActions: RecommendedAction[] = [];
    const result: CommandResult = {
      project: this.ctx.projectName,
      component: 'monitor',
      status: 'ok',
      exitCode: 0,
      actions,
      recommendedActions,
      details: { checks },
    };

    try {
      // 0. Worker health check (print-mode: launch timeout, idle timeout, auto-retry)
      await this.checkWorkerHealth(checks, actions);

      // 1. Orphan slot cleanup
      await this.checkOrphanSlots(checks, actions);

      // 2. Stale runtime detection
      await this.checkStaleRuntimes(checks, actions, recommendedActions);

      // 3. Timeout detection
      await this.checkTimeouts(checks, actions, recommendedActions);

      // 4. Waiting confirmation detection
      await this.checkWaitingConfirmation(checks, actions);

      // 5. BLOCKED condition check
      await this.checkBlockedCards(checks);

      // 6. State alignment
      await this.checkStateAlignment(checks, recommendedActions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Monitor tick failed: ${msg}`);
      result.status = 'fail';
      result.exitCode = 1;
      result.details = { error: msg, checks };
    }

    // Set degraded if any checks failed
    if (checks.some((c) => c.status === 'fail') && result.status === 'ok') {
      result.status = 'degraded';
    }

    return result;
  }

  // ─── Check 1: Orphan Slot Cleanup (doc 12 §6.1) ───────────────

  private async checkOrphanSlots(
    checks: CheckResult[],
    actions: ActionRecord[],
  ): Promise<void> {
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    let orphansFound = 0;

    for (const [slotName, slotState] of Object.entries(state.workers)) {
      if (slotState.status !== 'active' || !slotState.tmuxSession) continue;

      // Print mode: check PID liveness directly instead of inspect()
      if (slotState.mode === 'print' && slotState.pid) {
        try {
          process.kill(slotState.pid, 0); // signal 0 = check alive
          continue; // PID alive → not orphan
        } catch {
          // PID dead — but did the worker actually complete its task?
          const completionStatus = await this.checkPrintWorkerCompletion(slotState);
          if (completionStatus === 'COMPLETED') {
            this.log.ok(
              `Orphan slot ${slotName}: print-mode pid ${slotState.pid} is dead but task COMPLETED, handling as completion`,
            );
            const handled = await this.handleCompletedWorker(slotName, slotState, state, actions);
            if (handled) orphansFound++; // only count if slot was actually released
            continue;
          }
          // Not completed → fall through to orphan cleanup
          this.log.warn(
            `Orphan slot ${slotName}: print-mode pid ${slotState.pid} is dead (status=${completionStatus}), releasing`,
          );
        }
      } else if (slotState.mode === 'print' && !slotState.pid) {
        // Print mode but no PID recorded — skip, launch may still be writing state
        this.log.debug(`Skipping orphan check for ${slotName}: print mode, no PID yet`);
        continue;
      } else {
        // Tmux mode: use inspect()
        try {
          const inspection = await this.workerProvider.inspect(slotState.tmuxSession);
          if (inspection.alive) continue; // alive → not orphan
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.warn(`Failed to inspect session ${slotState.tmuxSession}: ${msg}`);
          continue; // can't determine → skip
        }
        this.log.warn(
          `Orphan slot ${slotName}: session ${slotState.tmuxSession} is dead, releasing`,
        );
      }

      // Orphan cleanup (shared for both modes)
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

      // Remove from active cards if present
      if (slotState.seq != null) {
        delete state.activeCards[String(slotState.seq)];
      }

      orphansFound++;
      actions.push({
        action: 'orphan-cleanup',
        entity: `slot:${slotName}`,
        result: 'ok',
        message: `Released orphan slot (${slotState.mode === 'print' ? `pid ${slotState.pid}` : `session ${slotState.tmuxSession}`} dead)`,
      });
      this.logEvent('orphan-cleanup', slotName, 'ok', {
        session: slotState.tmuxSession,
        seq: slotState.seq,
      });
    }

    if (orphansFound > 0) {
      try {
        writeState(this.ctx.paths.stateFile, state, 'monitor-orphan-cleanup');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`Failed to write state after orphan cleanup: ${msg}`);
      }
    }

    checks.push({
      name: 'orphan-slots',
      status: orphansFound > 0 ? 'warn' : 'pass',
      message: orphansFound > 0
        ? `Released ${orphansFound} orphan slot(s)`
        : 'No orphan slots detected',
    });
  }

  // ─── Check 2: Stale Runtime Detection (01 §10.2.3) ────────────

  private async checkStaleRuntimes(
    checks: CheckResult[],
    actions: ActionRecord[],
    recommendedActions: RecommendedAction[],
  ): Promise<void> {
    const inprogressCards = await this.taskBackend.listByState('Inprogress');
    let staleCount = 0;

    for (const card of inprogressCards) {
      // Skip cards already marked
      if (card.labels.includes('STALE-RUNTIME')) continue;

      const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
      const slotEntry = Object.entries(state.workers).find(
        ([, w]) => w.seq === parseInt(card.seq, 10),
      );

      if (!slotEntry) {
        // No worker slot for this card — it's stale
        this.log.warn(`seq ${card.seq}: Inprogress but no worker slot assigned`);
        await this.handleStaleRuntime(card, actions, recommendedActions);
        staleCount++;
        continue;
      }

      const [slotName, slotState] = slotEntry;
      if (!slotState.tmuxSession) continue;

      // Determine if worker is alive
      let workerAlive: boolean;

      if (slotState.mode === 'print') {
        // Print mode: check PID liveness directly (no tmux session)
        if (slotState.pid) {
          try {
            process.kill(slotState.pid, 0);
            workerAlive = true;
          } catch {
            workerAlive = false;
          }
        } else {
          continue; // No PID yet, skip
        }
      } else {
        // Interactive mode: use inspect()
        try {
          const inspection = await this.workerProvider.inspect(slotState.tmuxSession);
          workerAlive = inspection.alive;
        } catch {
          continue; // Can't determine, skip
        }
      }

      if (!workerAlive) {
        // Worker dead + card still Inprogress
        // For print-mode workers, use full completion detection first
        if (slotState.mode === 'print') {
          const completionStatus = await this.checkPrintWorkerCompletion(slotState);
          if (completionStatus === 'COMPLETED') {
            this.log.ok(`seq ${card.seq}: Worker dead but detectCompleted → COMPLETED`);
            const handled = await this.handleCompletedWorker(slotName, slotState, state, actions);
            if (handled) {
              try { writeState(this.ctx.paths.stateFile, state, 'monitor-stale-completed'); } catch { /* logged */ }
            }
            staleCount++;
            continue;
          }
        }

        // Fall back to MR-only check
        const branchName = slotState.branch || this.buildBranchName(card);
        const mrStatus = await this.repoBackend.getMrStatus(branchName);

        if (mrStatus.exists) {
          this.log.warn(
            `seq ${card.seq}: Worker dead but MR exists — stale runtime`,
          );
          await this.handleStaleRuntime(card, actions, recommendedActions);
          staleCount++;
        } else {
          this.log.warn(`seq ${card.seq}: Worker dead, no MR found`);
          await this.addLabelSafe(card.seq, 'STALE-RUNTIME');
          actions.push({
            action: 'mark-stale',
            entity: `seq:${card.seq}`,
            result: 'ok',
            message: 'Worker dead, no MR — needs manual review',
          });
          recommendedActions.push({
            action: `Review seq:${card.seq} — worker died without creating MR`,
            reason: 'Worker dead with no MR',
            severity: 'warning',
            autoExecutable: false,
            requiresConfirmation: true,
            safeToRetry: false,
          });
          staleCount++;
        }
      }
    }

    checks.push({
      name: 'stale-runtimes',
      status: staleCount > 0 ? 'warn' : 'pass',
      message: staleCount > 0
        ? `Detected ${staleCount} stale runtime(s)`
        : 'No stale runtimes detected',
    });
  }

  private async handleStaleRuntime(
    card: { seq: string; labels: string[] },
    actions: ActionRecord[],
    recommendedActions: RecommendedAction[],
  ): Promise<void> {
    const seq = card.seq;
    await this.addLabelSafe(seq, 'STALE-RUNTIME');

    if (this.ctx.config.MONITOR_AUTO_QA) {
      // Auto-move to QA
      try {
        await this.taskBackend.move(seq, 'QA');
        this.log.ok(`seq ${seq}: Auto-moved to QA (MONITOR_AUTO_QA=true)`);
        actions.push({
          action: 'auto-qa',
          entity: `seq:${seq}`,
          result: 'ok',
          message: 'Stale runtime — auto-moved to QA',
        });
        this.logEvent('auto-qa', seq, 'ok');
        await this.notifySafe(`seq:${seq} auto-moved to QA (stale runtime)`, 'warning');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`seq ${seq}: Failed to auto-move to QA: ${msg}`);
        actions.push({
          action: 'auto-qa',
          entity: `seq:${seq}`,
          result: 'fail',
          message: `Auto-QA failed: ${msg}`,
        });
      }
    } else {
      // Notify, wait for human
      await this.notifySafe(
        `seq:${seq} has a stale runtime — worker session dead but MR may exist`,
        'warning',
      );
      recommendedActions.push({
        action: `Move seq:${seq} to QA or investigate stale runtime`,
        reason: 'Worker session dead, MONITOR_AUTO_QA is disabled',
        severity: 'warning',
        autoExecutable: true,
        requiresConfirmation: true,
        safeToRetry: true,
      });
      actions.push({
        action: 'mark-stale',
        entity: `seq:${seq}`,
        result: 'ok',
        message: 'Stale runtime detected, awaiting manual review',
      });
    }
  }

  // ─── Check 3: Timeout Detection (01 §10.2.4) ──────────────────

  private async checkTimeouts(
    checks: CheckResult[],
    actions: ActionRecord[],
    recommendedActions: RecommendedAction[],
  ): Promise<void> {
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    const timeoutHours = this.ctx.config.INPROGRESS_TIMEOUT_HOURS;
    const now = Date.now();
    let timeoutCount = 0;

    for (const [seq, activeCard] of Object.entries(state.activeCards)) {
      if (activeCard.state !== 'Inprogress') continue;

      const startTime = new Date(activeCard.startedAt).getTime();
      const elapsedHours = (now - startTime) / (1000 * 60 * 60);

      if (elapsedHours <= timeoutHours) continue;

      // Check for recent heartbeat
      const slotEntry = Object.entries(state.workers).find(
        ([, w]) => w.seq === parseInt(seq, 10),
      );
      if (slotEntry) {
        const [, slotState] = slotEntry;
        if (slotState.lastHeartbeat) {
          const hbTime = new Date(slotState.lastHeartbeat).getTime();
          const hbAge = (now - hbTime) / (1000 * 60 * 60);
          // If heartbeat is recent (within timeout window), skip
          if (hbAge < timeoutHours) continue;
        }
      }

      // Timed out
      this.log.warn(
        `seq ${seq}: Timed out (${elapsedHours.toFixed(1)}h > ${timeoutHours}h threshold)`,
      );
      await this.addLabelSafe(seq, 'STALE-RUNTIME');
      await this.notifySafe(
        `seq:${seq} has exceeded timeout (${elapsedHours.toFixed(1)}h)`,
        'warning',
      );

      timeoutCount++;
      actions.push({
        action: 'mark-timeout',
        entity: `seq:${seq}`,
        result: 'ok',
        message: `Timed out after ${elapsedHours.toFixed(1)}h (limit: ${timeoutHours}h)`,
      });
      recommendedActions.push({
        action: `Investigate timeout for seq:${seq}`,
        reason: `Exceeded INPROGRESS_TIMEOUT_HOURS (${elapsedHours.toFixed(1)}h > ${timeoutHours}h)`,
        severity: 'warning',
        autoExecutable: false,
        requiresConfirmation: true,
        safeToRetry: true,
      });
      this.logEvent('timeout', seq, 'ok', {
        elapsedHours: parseFloat(elapsedHours.toFixed(1)),
        threshold: timeoutHours,
      });
    }

    checks.push({
      name: 'timeouts',
      status: timeoutCount > 0 ? 'warn' : 'pass',
      message: timeoutCount > 0
        ? `${timeoutCount} card(s) exceeded timeout`
        : 'No timeouts detected',
    });
  }

  // ─── Check 4: Waiting Confirmation Detection (doc 12 §3) ──────

  private async checkWaitingConfirmation(
    checks: CheckResult[],
    actions: ActionRecord[],
  ): Promise<void> {
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    let waitingCount = 0;

    for (const [slotName, slotState] of Object.entries(state.workers)) {
      if (slotState.status !== 'active' || !slotState.tmuxSession) continue;
      // Print mode workers use --dangerously-skip-permissions, never wait for input
      if (slotState.mode === 'print') continue;

      try {
        const waitResult = await this.workerProvider.detectWaiting(slotState.tmuxSession);
        if (!waitResult.waiting) continue;

        const seq = slotState.seq != null ? String(slotState.seq) : slotName;

        if (!waitResult.destructive) {
          // Non-destructive prompt → auto-confirm
          this.log.info(
            `seq ${seq}: Worker waiting for non-destructive confirmation, auto-confirming`,
          );
          try {
            // Send Enter/y to confirm
            await this.workerProvider.sendFix(slotState.tmuxSession, 'y');
            actions.push({
              action: 'auto-confirm',
              entity: `seq:${seq}`,
              result: 'ok',
              message: `Auto-confirmed: ${waitResult.prompt}`,
            });
            this.logEvent('auto-confirm', seq, 'ok', { prompt: waitResult.prompt });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.warn(`Failed to auto-confirm for seq ${seq}: ${msg}`);
            actions.push({
              action: 'auto-confirm',
              entity: `seq:${seq}`,
              result: 'fail',
              message: `Auto-confirm failed: ${msg}`,
            });
          }
        } else {
          // Destructive prompt → label + notify
          this.log.warn(
            `seq ${seq}: Worker waiting for destructive confirmation: ${waitResult.prompt}`,
          );
          if (slotState.seq != null) {
            await this.addLabelSafe(String(slotState.seq), 'WAITING-CONFIRMATION');
          }
          await this.notifySafe(
            `seq:${seq} waiting for destructive confirmation: ${waitResult.prompt}`,
            'warning',
          );
          actions.push({
            action: 'mark-waiting',
            entity: `seq:${seq}`,
            result: 'ok',
            message: `Waiting for destructive confirmation: ${waitResult.prompt}`,
          });
          this.logEvent('waiting-confirmation', seq, 'ok', {
            destructive: true,
            prompt: waitResult.prompt,
          });
        }

        waitingCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.debug(`Failed to detect waiting for ${slotName}: ${msg}`);
      }
    }

    checks.push({
      name: 'waiting-confirmation',
      status: waitingCount > 0 ? 'warn' : 'pass',
      message: waitingCount > 0
        ? `${waitingCount} worker(s) waiting for confirmation`
        : 'No workers waiting for confirmation',
    });
  }

  // ─── Check 5: BLOCKED Condition Check (01 §3.6.1) ─────────────

  private async checkBlockedCards(checks: CheckResult[]): Promise<void> {
    // Collect cards from all active states that might have BLOCKED label
    const states = ['Backlog', 'Todo', 'Inprogress', 'QA'] as const;
    let blockedCount = 0;

    for (const cardState of states) {
      try {
        const cards = await this.taskBackend.listByState(cardState);
        for (const card of cards) {
          if (card.labels.includes('BLOCKED')) {
            this.log.info(`seq ${card.seq}: BLOCKED in ${cardState}`);
            blockedCount++;
          }
        }
      } catch {
        // Non-fatal: skip this state
      }
    }

    checks.push({
      name: 'blocked-cards',
      status: blockedCount > 0 ? 'warn' : 'pass',
      message: blockedCount > 0
        ? `${blockedCount} card(s) are BLOCKED`
        : 'No blocked cards',
    });
  }

  // ─── Check 6: State Alignment (07 §2.1) ───────────────────────

  private async checkStateAlignment(
    checks: CheckResult[],
    recommendedActions: RecommendedAction[],
  ): Promise<void> {
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    const discrepancies: string[] = [];

    for (const [slotName, slotState] of Object.entries(state.workers)) {
      if (slotState.status !== 'active' || !slotState.tmuxSession) continue;

      let alive: boolean;
      if (slotState.mode === 'print') {
        // Print mode: check PID directly
        if (!slotState.pid) continue; // No PID yet, skip
        try {
          process.kill(slotState.pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      } else {
        // Interactive mode: check tmux session
        try {
          const inspection = await this.workerProvider.inspect(slotState.tmuxSession);
          alive = inspection.alive;
        } catch {
          discrepancies.push(
            `${slotName}: could not inspect session ${slotState.tmuxSession}`,
          );
          continue;
        }
      }

      if (!alive) {
        const desc = slotState.mode === 'print'
          ? `pid ${slotState.pid} is dead`
          : `session ${slotState.tmuxSession} is dead`;
        discrepancies.push(`${slotName}: state says active but ${desc}`);
      }
    }

    if (discrepancies.length > 0) {
      for (const d of discrepancies) {
        this.log.warn(`State alignment: ${d}`);
      }
      recommendedActions.push({
        action: 'Investigate state alignment discrepancies',
        reason: discrepancies.join('; '),
        severity: 'warning',
        autoExecutable: false,
        requiresConfirmation: true,
        safeToRetry: true,
      });
    }

    checks.push({
      name: 'state-alignment',
      status: discrepancies.length > 0 ? 'warn' : 'pass',
      message: discrepancies.length > 0
        ? `${discrepancies.length} state alignment discrepancy(ies)`
        : 'State aligned with runtime',
    });
  }

  // ─── Check 0: Worker Health (print-mode auto-recovery) ────────

  private async checkWorkerHealth(
    checks: CheckResult[],
    actions: ActionRecord[],
  ): Promise<void> {
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    let issues = 0;

    for (const [slotName, slotState] of Object.entries(state.workers)) {
      if (slotState.status !== 'active' || slotState.mode !== 'print') continue;
      if (!slotState.pid || !slotState.outputFile || !slotState.claimedAt) continue;

      // Check if PID is alive
      let pidAlive: boolean;
      try {
        process.kill(slotState.pid, 0);
        pidAlive = true;
      } catch {
        pidAlive = false;
      }

      if (!pidAlive) {
        // PID dead — but check if the worker actually completed its task first
        const completionStatus = await this.checkPrintWorkerCompletion(slotState);
        if (completionStatus === 'COMPLETED') {
          this.log.ok(
            `Worker health: ${slotName} pid ${slotState.pid} is dead but task COMPLETED`,
          );
          const handled = await this.handleCompletedWorker(slotName, slotState, state, actions);
          if (handled) {
            try { writeState(this.ctx.paths.stateFile, state, 'monitor-health-completed'); } catch { /* logged */ }
            continue; // worker finished successfully
          }
          // Move-to-Done failed — fall through to auto-retry
          this.log.warn(`Worker health: ${slotName} completed but move-to-Done failed, will auto-retry`);
        }

        // Not completed → auto-retry
        const seq = slotState.seq != null ? String(slotState.seq) : null;
        if (seq) {
          this.log.warn(`Worker health: ${slotName} pid ${slotState.pid} is dead (status=${completionStatus}), auto-retrying seq ${seq}`);
          await this.autoRetry(seq, slotName, state, actions, 'Worker process died');
          issues++;
        }
        continue;
      }

      // PID alive — check output health
      const nowMs = Date.now();
      const claimedMs = new Date(slotState.claimedAt).getTime();
      const elapsedS = (nowMs - claimedMs) / 1000;

      let outputSize = 0;
      let outputMtimeMs = 0;
      if (existsSync(slotState.outputFile)) {
        try {
          const st = statSync(slotState.outputFile);
          outputSize = st.size;
          outputMtimeMs = st.mtimeMs;
        } catch { /* ignore */ }
      }

      const launchTimeout = this.ctx.config.WORKER_LAUNCH_TIMEOUT_S;
      const idleTimeout = this.ctx.config.WORKER_IDLE_TIMEOUT_M * 60 * 1000;

      // Launch timeout: process alive but no output after N seconds
      if (outputSize === 0 && elapsedS > launchTimeout) {
        const seq = slotState.seq != null ? String(slotState.seq) : null;
        if (seq) {
          this.log.warn(
            `Worker health: ${slotName} has no output after ${Math.round(elapsedS)}s, killing and retrying seq ${seq}`,
          );
          this.killWorker(slotState.pid);
          await this.autoRetry(seq, slotName, state, actions, `No output after ${Math.round(elapsedS)}s`);
          issues++;
        }
        continue;
      }

      // Idle timeout: process alive but no new output for N minutes
      if (outputSize > 0 && outputMtimeMs > 0) {
        const idleSinceMs = nowMs - outputMtimeMs;
        if (idleSinceMs > idleTimeout) {
          const seq = slotState.seq != null ? String(slotState.seq) : null;
          if (seq) {
            const idleMin = Math.round(idleSinceMs / 60000);
            this.log.warn(
              `Worker health: ${slotName} no output for ${idleMin}min, killing and retrying seq ${seq}`,
            );
            this.killWorker(slotState.pid);
            await this.autoRetry(seq, slotName, state, actions, `No output for ${idleMin}min`);
            issues++;
          }
        }
      }
    }

    checks.push({
      name: 'worker-health',
      status: issues > 0 ? 'warn' : 'pass',
      message: issues > 0
        ? `${issues} worker health issue(s) resolved via auto-retry`
        : 'All active workers healthy',
    });
  }

  private killWorker(pid: number): void {
    try {
      process.kill(pid, 'SIGTERM');
    } catch { /* already dead */ }
    // Give it a moment, then force kill
    try {
      process.kill(pid, 0); // check alive
      process.kill(pid, 'SIGKILL');
    } catch { /* dead */ }
  }

  private async autoRetry(
    seq: string,
    slotName: string,
    state: import('../core/state.js').RuntimeState,
    actions: ActionRecord[],
    reason: string,
  ): Promise<void> {
    const restartLimit = this.ctx.config.WORKER_RESTART_LIMIT;

    // Get retry count from activeCards
    const activeCard = state.activeCards[seq];
    const retryCount = activeCard?.retryCount ?? 0;

    // Release the slot
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
    delete state.activeCards[seq];

    if (retryCount < restartLimit) {
      // Move back to Todo for re-launch on next tick
      try {
        await this.taskBackend.move(seq, 'Todo');
        await this.removeLabelSafe(seq, 'CLAIMED');
        await this.removeLabelSafe(seq, 'STALE-RUNTIME');

        // Track retry count — store in a fresh activeCards entry
        state.activeCards[seq] = {
          seq: parseInt(seq, 10),
          state: 'Todo',
          worker: null,
          mrUrl: null,
          conflictDomains: activeCard?.conflictDomains ?? [],
          startedAt: activeCard?.startedAt ?? new Date().toISOString(),
          retryCount: retryCount + 1,
        };

        writeState(this.ctx.paths.stateFile, state, 'monitor-auto-retry');

        const attempt = retryCount + 1;
        this.log.ok(`seq ${seq}: Auto-retry ${attempt}/${restartLimit} — moved back to Todo (${reason})`);
        await this.notifySafe(
          `seq:${seq} auto-retry ${attempt}/${restartLimit} — ${reason}`,
          'warning',
        );
        actions.push({
          action: 'auto-retry',
          entity: `seq:${seq}`,
          result: 'ok',
          message: `Auto-retry ${attempt}/${restartLimit}: ${reason}`,
        });
        this.logEvent('auto-retry', seq, 'ok', { attempt, reason });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`seq ${seq}: Auto-retry failed: ${msg}`);
        writeState(this.ctx.paths.stateFile, state, 'monitor-auto-retry-fail');
        actions.push({
          action: 'auto-retry',
          entity: `seq:${seq}`,
          result: 'fail',
          message: `Auto-retry failed: ${msg}`,
        });
      }
    } else {
      // Retry limit reached — mark as BLOCKED
      writeState(this.ctx.paths.stateFile, state, 'monitor-retry-exhausted');
      try {
        await this.addLabelSafe(seq, 'BLOCKED');
        await this.taskBackend.move(seq, 'Todo');
        await this.taskBackend.comment(
          seq,
          `Auto-retry limit reached (${restartLimit}). Last failure: ${reason}. Needs manual intervention.`,
        );
      } catch { /* best effort */ }

      this.log.error(`seq ${seq}: Retry limit reached (${restartLimit}), marked BLOCKED`);
      await this.notifySafe(
        `seq:${seq} retry limit reached (${restartLimit}x) — marked BLOCKED, needs manual review`,
        'error',
      );
      actions.push({
        action: 'retry-exhausted',
        entity: `seq:${seq}`,
        result: 'ok',
        message: `Retry limit ${restartLimit} reached: ${reason}`,
      });
      this.logEvent('retry-exhausted', seq, 'ok', { retryCount, reason });
    }
  }

  private async removeLabelSafe(seq: string, label: string): Promise<void> {
    try {
      await this.taskBackend.removeLabel(seq, label);
    } catch { /* best effort */ }
  }

  // ─── Completion-aware helpers for dead print-mode workers ─────

  /**
   * Check if a dead print-mode worker actually completed its task.
   * Uses workerProvider.detectCompleted() with the slot's session/branch info.
   */
  private async checkPrintWorkerCompletion(
    slotState: import('../core/state.js').WorkerSlotState,
  ): Promise<WorkerStatus> {
    if (!slotState.tmuxSession) return 'DEAD';
    const branch = slotState.branch || '';
    const logDir = this.ctx.paths.logsDir;
    try {
      return await this.workerProvider.detectCompleted(
        slotState.tmuxSession,
        logDir,
        branch,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.debug(`detectCompleted failed for ${slotState.tmuxSession}: ${msg}`);
      return 'DEAD';
    }
  }

  /**
   * Handle a dead print-mode worker that has been confirmed as COMPLETED.
   * Mutates state in-place (releases slot, updates activeCards).
   * Does NOT call writeState — caller is responsible for flushing state.
   */
  /**
   * Handle a dead print-mode worker confirmed as COMPLETED.
   * Returns true if card moved to Done + slot released (state mutated).
   * Returns false if move failed (state NOT mutated, caller should not count as handled).
   */
  private async handleCompletedWorker(
    slotName: string,
    slotState: import('../core/state.js').WorkerSlotState,
    state: import('../core/state.js').RuntimeState,
    actions: ActionRecord[],
  ): Promise<boolean> {
    const seq = slotState.seq != null ? String(slotState.seq) : null;
    if (!seq) return false;

    // 1. Move card to Done FIRST — if this fails, don't touch state
    const targetState = 'Done' as const;
    try {
      await this.taskBackend.move(seq, targetState);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`seq ${seq}: Failed to move to ${targetState}: ${msg}. Slot NOT released.`);
      actions.push({
        action: 'complete',
        entity: `seq:${seq}`,
        result: 'fail',
        message: `Move to ${targetState} failed: ${msg}`,
      });
      return false;
    }

    // 2. Done confirmed — now release slot + cleanup (mutate state)
    state.workers[slotName] = {
      status: 'idle', seq: null, branch: null, worktree: null,
      tmuxSession: null, claimedAt: null, lastHeartbeat: null,
      mode: null, sessionId: null, pid: null, outputFile: null, exitCode: null,
    };
    delete state.activeCards[seq];
    try { await this.taskBackend.releaseClaim(seq); } catch { /* best effort */ }

    // 3. Mark worktree for cleanup
    const branch = slotState.branch || '';
    const worktreePath = slotState.worktree || '';
    if (branch && worktreePath) {
      const cleanup = state.worktreeCleanup ?? [];
      if (!cleanup.some((e: { branch: string }) => e.branch === branch)) {
        cleanup.push({ branch, worktreePath, markedAt: new Date().toISOString() });
        state.worktreeCleanup = cleanup;
      }
    }

    this.log.ok(`seq ${seq}: Worker completed (detected by monitor), moved to ${targetState}`);
    await this.notifySafe(`seq:${seq} worker completed, moved to ${targetState}`, 'success');
    actions.push({
      action: 'complete',
      entity: `seq:${seq}`,
      result: 'ok',
      message: `Worker completed (PID dead, artifacts verified) → ${targetState}`,
    });
    this.logEvent('complete', seq, 'ok', { detectedBy: 'monitor' });
    return true;
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private buildBranchName(card: { seq: string; name: string }): string {
    const slug = card.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    return `feature/${card.seq}-${slug}`;
  }

  private async addLabelSafe(seq: string, label: string): Promise<void> {
    try {
      await this.taskBackend.addLabel(seq, label);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Failed to add label ${label} to seq ${seq}: ${msg}`);
    }
  }

  private async notifySafe(
    message: string,
    level: 'info' | 'success' | 'warning' | 'error',
  ): Promise<void> {
    if (!this.notifier) return;
    try {
      await this.notifier.send(`[${this.ctx.projectName}] ${message}`, level);
    } catch {
      // Notification failures are never fatal
    }
  }

  private logEvent(
    action: string,
    entity: string,
    result: 'ok' | 'fail',
    meta?: Record<string, unknown>,
  ): void {
    this.log.event({
      component: 'monitor',
      action,
      entity: entity.includes(':') ? entity : `seq:${entity}`,
      result,
      meta,
    });
  }
}
