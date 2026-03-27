import type { ProjectContext } from '../core/context.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { WorkerProvider } from '../interfaces/WorkerProvider.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { CommandResult, ActionRecord, CheckResult, RecommendedAction } from '../models/types.js';
import type { ProcessSupervisor } from '../manager/supervisor.js';
import { existsSync, statSync } from 'node:fs';
import { readState, writeState } from '../core/state.js';
import { readACPState } from '../core/acpState.js';
import { Logger } from '../core/logger.js';

/**
 * MonitorEngine performs anomaly detection and health checks.
 *
 * With ProcessSupervisor, completion detection and post-actions are handled
 * by exit callbacks (CompletionJudge + PostActions). MonitorEngine focuses on:
 *   1. Orphan slot cleanup (stale entries not tracked by Supervisor)
 *   2. Stale runtime detection (Inprogress cards with no worker)
 *   3. Timeout detection (INPROGRESS_TIMEOUT_HOURS)
 *   4. Waiting confirmation detection (interactive mode only)
 *   5. BLOCKED condition check
 *   6. State alignment (Supervisor vs state.json sync)
 *   7. Worker health (launch/idle timeouts for Supervisor-tracked workers)
 */
export class MonitorEngine {
  private log: Logger;

  constructor(
    private ctx: ProjectContext,
    private taskBackend: TaskBackend,
    private workerProvider: WorkerProvider,
    private repoBackend: RepoBackend,
    private notifier: Notifier | undefined,
    private supervisor: ProcessSupervisor,
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
      await this.checkWorkerHealth(checks, actions);
      await this.checkOrphanSlots(checks, actions);
      await this.checkStaleRuntimes(checks, actions, recommendedActions);
      await this.checkTimeouts(checks, actions, recommendedActions);
      await this.checkWaitingConfirmation(checks, actions);
      await this.checkBlockedCards(checks);
      await this.checkStateAlignment(checks, recommendedActions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error(`Monitor tick failed: ${msg}`);
      result.status = 'fail';
      result.exitCode = 1;
      result.details = { error: msg, checks };
    }

    if (checks.some((c) => c.status === 'fail') && result.status === 'ok') {
      result.status = 'degraded';
    }

    return result;
  }

  // ─── Check 1: Orphan Slot Cleanup ─────────────────────────────

  private async checkOrphanSlots(
    checks: CheckResult[],
    actions: ActionRecord[],
  ): Promise<void> {
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    const acpState = readACPState(this.ctx.paths.acpStateFile);
    let orphansFound = 0;

    for (const [slotName, slotState] of Object.entries(state.workers)) {
      if (!['active', 'resolving', 'merging'].includes(slotState.status)) continue;

      // Build the workerId that Supervisor would track
      const seq = slotState.seq != null ? String(slotState.seq) : '';
      const workerId = `${this.ctx.projectName}:${slotName}:${seq}`;

      // If Supervisor is tracking this worker, it handles lifecycle — skip
      if (this.supervisor.get(workerId)) continue;

      if (
        (slotState.transport === 'acp' || slotState.transport === 'pty' || slotState.mode === 'acp' || slotState.mode === 'pty') &&
        this.isAcpSessionAlive(acpState.sessions[slotName])
      ) {
        continue;
      }

      // Supervisor doesn't know about this worker.
      // PostActions exit callback may have already cleaned up state.
      // Re-read state to check for race with exit callback.
      const freshState = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
      const freshSlot = freshState.workers[slotName];
      if (!freshSlot || !['active', 'resolving', 'merging'].includes(freshSlot.status)) continue;

      // Still active with no Supervisor handle — truly orphaned / stale
      this.log.warn(
        `Orphan slot ${slotName}: not tracked by Supervisor, marking STALE-RUNTIME and releasing`,
      );

      if (slotState.seq != null) {
        await this.addLabelSafe(String(slotState.seq), 'STALE-RUNTIME');
      }

      state.workers[slotName] = {
        status: 'idle',
        seq: null,
        branch: null,
        worktree: null,
        tmuxSession: null,
        claimedAt: null,
        lastHeartbeat: null,
        mode: null,
        transport: null,
        agent: null,
        sessionId: null,
        runId: null,
        sessionState: null,
        remoteStatus: null,
        lastEventAt: null,
        pid: null,
        outputFile: null,
        exitCode: null,
      };

      if (slotState.seq != null) {
        delete state.activeCards[String(slotState.seq)];
      }

      orphansFound++;
      actions.push({
        action: 'orphan-cleanup',
        entity: `slot:${slotName}`,
        result: 'ok',
        message: `Released orphan slot (not tracked by Supervisor)`,
      });
      this.logEvent('orphan-cleanup', slotName, 'ok', {
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

  // ─── Check 2: Stale Runtime Detection ─────────────────────────

  private async checkStaleRuntimes(
    checks: CheckResult[],
    actions: ActionRecord[],
    recommendedActions: RecommendedAction[],
  ): Promise<void> {
    const inprogressCards = await this.taskBackend.listByState('Inprogress');
    const acpState = readACPState(this.ctx.paths.acpStateFile);
    let staleCount = 0;

    for (const card of inprogressCards) {
      if (card.labels.includes('STALE-RUNTIME') || card.labels.includes('CONFLICT') || card.labels.includes('NEEDS-FIX')) continue;

      const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
      const slotEntry = Object.entries(state.workers).find(
        ([, w]) => w.seq === parseInt(card.seq, 10),
      );
      const trackedCard = state.activeCards[card.seq];
      const branchName = this.buildBranchName(card);

      if (!slotEntry) {
        if (!trackedCard) {
          const mrStatus = await this.repoBackend.getMrStatus(branchName);
          if (mrStatus.state === 'merged') {
            this.log.info(`seq ${card.seq}: Card already merged while closeout was releasing resources, skipping stale check`);
            continue;
          }
        }
        // No worker slot for this card — it's stale
        this.log.warn(`seq ${card.seq}: Inprogress but no worker slot assigned`);
        await this.handleStaleRuntime(card, actions, recommendedActions);
        staleCount++;
        continue;
      }

      const [, slotState] = slotEntry;

      if (slotState.transport === 'acp' || slotState.transport === 'pty' || slotState.mode === 'acp' || slotState.mode === 'pty') {
        const session = acpState.sessions[slotEntry[0]];
        if (this.isAcpSessionAlive(session)) {
          continue;
        }
      }

      // Check if Supervisor is tracking this worker
      const seq = slotState.seq != null ? String(slotState.seq) : '';
      const workerId = `${this.ctx.projectName}:${slotEntry[0]}:${seq}`;
      const handle = this.supervisor.get(workerId);

      if (handle && handle.exitCode === null) {
        // Supervisor tracking and worker still running — not stale
        continue;
      }

      if (!handle) {
        // Not tracked by Supervisor and no slot → stale
        // Check for MR as a last resort
        const mrStatus = await this.repoBackend.getMrStatus(slotState.branch || branchName);

        if (mrStatus.exists) {
          this.log.warn(`seq ${card.seq}: Worker not tracked, but MR exists — stale runtime`);
          await this.handleStaleRuntime(card, actions, recommendedActions);
        } else {
          this.log.warn(`seq ${card.seq}: Worker not tracked, no MR found`);
          await this.addLabelSafe(card.seq, 'STALE-RUNTIME');
          actions.push({
            action: 'mark-stale',
            entity: `seq:${card.seq}`,
            result: 'ok',
            message: 'Worker not tracked by Supervisor, no MR — needs manual review',
          });
          recommendedActions.push({
            action: `Review seq:${card.seq} — worker not tracked, no MR`,
            reason: 'Worker not tracked by Supervisor with no MR',
            severity: 'warning',
            autoExecutable: false,
            requiresConfirmation: true,
            safeToRetry: false,
          });
        }
        staleCount++;
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

  // ─── Check 3: Timeout Detection ───────────────────────────────

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
          if (hbAge < timeoutHours) continue;
        }
      }

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

  // ─── Check 4: Waiting Confirmation Detection (interactive mode) ─

  private async checkWaitingConfirmation(
    checks: CheckResult[],
    actions: ActionRecord[],
  ): Promise<void> {
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    const acpState = readACPState(this.ctx.paths.acpStateFile);
    let waitingCount = 0;

    for (const [slotName, slotState] of Object.entries(state.workers)) {
      if (!['active', 'resolving', 'merging'].includes(slotState.status)) continue;
      const isAgentTransport =
        slotState.transport === 'acp' ||
        slotState.transport === 'pty' ||
        slotState.mode === 'acp' ||
        slotState.mode === 'pty';

      if (isAgentTransport) {
        const session = acpState.sessions[slotName];
        const pending = session?.pendingInput;
        if (!session || session.currentRun?.status !== 'waiting_input' || !pending) continue;

        const seq = slotState.seq != null ? String(slotState.seq) : slotName;
        await this.addLabelSafe(seq, 'WAITING-CONFIRMATION');
        await this.notifySafe(
          `seq:${seq} waiting for confirmation (${pending.type}): ${pending.prompt}`,
          pending.dangerous ? 'warning' : 'info',
        );
        actions.push({
          action: 'mark-waiting',
          entity: `seq:${seq}`,
          result: 'ok',
          message: `Waiting for ${pending.type}: ${pending.prompt}`,
        });
        this.logEvent('waiting-confirmation', seq, 'ok', {
          destructive: !!pending.dangerous,
          prompt: pending.prompt,
        });
        waitingCount++;
        continue;
      }

      if (!slotState.tmuxSession) continue;
      // Print mode workers use --dangerously-skip-permissions, never wait for input
      if (slotState.mode === 'print') continue;

      try {
        const waitResult = await this.workerProvider.detectWaiting(slotState.tmuxSession);
        if (!waitResult.waiting) continue;

        const seq = slotState.seq != null ? String(slotState.seq) : slotName;

        if (!waitResult.destructive) {
          this.log.info(
            `seq ${seq}: Worker waiting for non-destructive confirmation, auto-confirming`,
          );
          try {
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

  // ─── Check 5: BLOCKED Condition Check ─────────────────────────

  private async checkBlockedCards(checks: CheckResult[]): Promise<void> {
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

  // ─── Check 6: State Alignment (Supervisor vs state.json) ──────

  private async checkStateAlignment(
    checks: CheckResult[],
    recommendedActions: RecommendedAction[],
  ): Promise<void> {
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    const discrepancies: string[] = [];

    for (const [slotName, slotState] of Object.entries(state.workers)) {
      if (slotState.status !== 'active') continue;

      if (slotState.transport === 'acp' || slotState.transport === 'pty' || slotState.mode === 'acp' || slotState.mode === 'pty') {
        const session = readACPState(this.ctx.paths.acpStateFile).sessions[slotName];
        if (this.isAcpSessionAlive(session)) continue;
      }

      const seq = slotState.seq != null ? String(slotState.seq) : '';
      const workerId = `${this.ctx.projectName}:${slotName}:${seq}`;
      const handle = this.supervisor.get(workerId);

      if (!handle) {
        discrepancies.push(
          `${slotName}: state says active but Supervisor has no handle`,
        );
      } else if (handle.exitCode !== null) {
        discrepancies.push(
          `${slotName}: state says active but Supervisor reports exited (code=${handle.exitCode})`,
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
        : 'State aligned with Supervisor',
    });
  }

  // ─── Check 7: Worker Health (launch/idle timeouts) ────────────

  private async checkWorkerHealth(
    checks: CheckResult[],
    actions: ActionRecord[],
  ): Promise<void> {
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    let issues = 0;

    for (const [slotName, slotState] of Object.entries(state.workers)) {
      if (slotState.status !== 'active' || slotState.mode !== 'print') continue;
      if (!slotState.outputFile || !slotState.claimedAt) continue;

      const seq = slotState.seq != null ? String(slotState.seq) : '';
      const workerId = `${this.ctx.projectName}:${slotName}:${seq}`;
      const handle = this.supervisor.get(workerId);

      // If Supervisor doesn't track it, orphan check handles it
      if (!handle) continue;

      // If worker already exited, Supervisor exit callback handles it
      if (handle.exitCode !== null) continue;

      // Worker is alive — check output health
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
      if (outputSize === 0 && elapsedS > launchTimeout && seq) {
        this.log.warn(
          `Worker health: ${slotName} has no output after ${Math.round(elapsedS)}s, killing and retrying seq ${seq}`,
        );
        await this.supervisor.kill(workerId);
        await this.autoRetry(seq, slotName, state, actions, `No output after ${Math.round(elapsedS)}s`);
        issues++;
        continue;
      }

      // Idle timeout: process alive but no new output for N minutes
      if (outputSize > 0 && outputMtimeMs > 0 && seq) {
        const idleSinceMs = nowMs - outputMtimeMs;
        if (idleSinceMs > idleTimeout) {
          const idleMin = Math.round(idleSinceMs / 60000);
          this.log.warn(
            `Worker health: ${slotName} no output for ${idleMin}min, killing and retrying seq ${seq}`,
          );
          await this.supervisor.kill(workerId);
          await this.autoRetry(seq, slotName, state, actions, `No output for ${idleMin}min`);
          issues++;
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

  // ─── Auto-retry ───────────────────────────────────────────────

  private async autoRetry(
    seq: string,
    slotName: string,
    state: import('../core/state.js').RuntimeState,
    actions: ActionRecord[],
    reason: string,
  ): Promise<void> {
    const restartLimit = this.ctx.config.WORKER_RESTART_LIMIT;
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
      transport: null,
      agent: null,
      sessionId: null,
      runId: null,
      sessionState: null,
      remoteStatus: null,
      lastEventAt: null,
      pid: null,
      outputFile: null,
      exitCode: null,
    };
    delete state.activeCards[seq];

    if (retryCount < restartLimit) {
      try {
        await this.taskBackend.move(seq, 'Todo');
        await this.removeLabelSafe(seq, 'CLAIMED');
        await this.removeLabelSafe(seq, 'STALE-RUNTIME');

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

  private isAcpSessionAlive(
    session: import('../models/acp.js').ACPSessionRecord | undefined,
  ): boolean {
    if (!session || session.sessionState === 'offline' || !session.currentRun) return false;
    return ['submitted', 'running', 'waiting_input'].includes(session.currentRun.status);
  }

  // ─── Helpers ──────────────────────────────────────────────────

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

  private async removeLabelSafe(seq: string, label: string): Promise<void> {
    try {
      await this.taskBackend.removeLabel(seq, label);
    } catch { /* best effort */ }
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
