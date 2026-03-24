import type { ProjectContext } from '../core/context.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { WorkerProvider } from '../interfaces/WorkerProvider.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { CommandResult, ActionRecord, CheckResult, RecommendedAction } from '../models/types.js';
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
          // PID dead → fall through to orphan cleanup
          this.log.warn(
            `Orphan slot ${slotName}: print-mode pid ${slotState.pid} is dead, releasing`,
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

      const [, slotState] = slotEntry;
      if (!slotState.tmuxSession) continue;

      try {
        const inspection = await this.workerProvider.inspect(slotState.tmuxSession);
        if (!inspection.alive) {
          // Session dead + card still Inprogress
          const branchName = slotState.branch || this.buildBranchName(card);
          const mrStatus = await this.repoBackend.getMrStatus(branchName);

          if (mrStatus.exists) {
            // Dead session + MR exists → stale runtime
            this.log.warn(
              `seq ${card.seq}: Worker session dead but MR exists — stale runtime`,
            );
            await this.handleStaleRuntime(card, actions, recommendedActions);
            staleCount++;
          } else {
            // Dead session + no MR → worker died before completing
            this.log.warn(`seq ${card.seq}: Worker session dead, no MR found`);
            await this.addLabelSafe(card.seq, 'STALE-RUNTIME');
            actions.push({
              action: 'mark-stale',
              entity: `seq:${card.seq}`,
              result: 'ok',
              message: 'Worker dead, no MR — needs manual review',
            });
            recommendedActions.push({
              action: `Review seq:${card.seq} — worker died without creating MR`,
              reason: 'Worker session dead with no MR',
              severity: 'warning',
              autoExecutable: false,
              requiresConfirmation: true,
              safeToRetry: false,
            });
            staleCount++;
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn(`Failed to inspect session for seq ${card.seq}: ${msg}`);
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

      try {
        const inspection = await this.workerProvider.inspect(slotState.tmuxSession);
        if (!inspection.alive) {
          discrepancies.push(
            `${slotName}: state says active but session ${slotState.tmuxSession} is dead`,
          );
        }
      } catch {
        discrepancies.push(
          `${slotName}: could not inspect session ${slotState.tmuxSession}`,
        );
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
