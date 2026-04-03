/**
 * @module        MonitorEngine
 * @description   异常检测与健康检查引擎，监控孤儿插槽、超时任务及 Worker 状态
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-19
 * @updated       2026-04-03
 *
 * @role          engine
 * @layer         engine
 * @boundedContext pipeline-health
 *
 * @workflow       tick → orphan cleanup → stale detection → timeout check → BLOCKED check → state alignment
 */

import { existsSync, statSync } from 'node:fs';
import type { ProjectContext } from '../core/context.js';
import { Logger } from '../core/logger.js';
import type { ProjectPipelineAdapter } from '../core/projectPipelineAdapter.js';
import { RuntimeStore } from '../core/runtimeStore.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { ProcessSupervisor } from '../manager/supervisor.js';
import type { ActionRecord, CheckResult, CommandResult, RecommendedAction } from '../models/types.js';

/**
 * MonitorEngine performs anomaly detection and health checks.
 *
 * With ProcessSupervisor, completion detection and post-actions are handled
 * by exit callbacks (CompletionJudge + PostActions). MonitorEngine focuses on:
 *   1. Orphan slot cleanup (stale entries not tracked by Supervisor)
 *   2. Stale runtime detection (Inprogress cards with no worker)
 *   3. Timeout detection (INPROGRESS_TIMEOUT_HOURS)
 *   4. BLOCKED condition check
 *   5. State alignment (Supervisor vs state.json sync)
 *   6. Worker health (launch/idle timeouts for Supervisor-tracked workers)
 */
export class MonitorEngine {
  private log: Logger;
  private runtimeStore: RuntimeStore;

  constructor(
    private ctx: ProjectContext,
    private taskBackend: TaskBackend,
    private repoBackend: RepoBackend,
    private notifier: Notifier | undefined,
    private supervisor: ProcessSupervisor,
    private pipelineAdapter: ProjectPipelineAdapter,
  ) {
    this.log = new Logger('monitor', ctx.projectName, ctx.paths.logsDir);
    this.runtimeStore = new RuntimeStore(ctx);
  }

  /**
   * Safe MR status check — returns { exists: false, state: 'unknown' } if GitLab API
   * fails (project not found, MR_MODE=none, network error). Prevents monitor from
   * crashing on projects without GitLab integration.
   */
  private async safeMrStatus(branch: string): Promise<{ exists: boolean; state: string }> {
    try {
      return await this.safeMrStatus(branch);
    } catch {
      return { exists: false, state: 'unknown' };
    }
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
    const state = this.runtimeStore.readState();
    const orphanedTasks: Array<{ seq: string; slotName: string }> = [];
    const orphanedSlots: string[] = [];
    let orphansFound = 0;

    for (const [slotName, slotState] of Object.entries(state.workers)) {
      if (!['active', 'resolving', 'merging'].includes(slotState.status)) continue;

      // Build the workerId that Supervisor would track
      const seq = slotState.seq != null ? String(slotState.seq) : '';
      const workerId = `${this.ctx.projectName}:${slotName}:${seq}`;

      // If Supervisor is tracking this worker, it handles lifecycle — skip
      if (this.supervisor.get(workerId)) continue;

      if (
        (slotState.transport === 'acp-sdk' || slotState.mode === 'acp' || slotState.mode === 'acp-sdk') &&
        this.isAcpSessionAlive(state.sessions[slotName])
      ) {
        continue;
      }

      // Supervisor doesn't know about this worker.
      // PostActions exit callback may have already cleaned up state.
      // Re-read state to check for race with exit callback.
      const freshState = this.runtimeStore.readState();
      const freshSlot = freshState.workers[slotName];
      if (!freshSlot || !['active', 'resolving', 'merging'].includes(freshSlot.status)) continue;

      // Still active with no Supervisor handle — truly orphaned / stale
      this.log.warn(
        `Orphan slot ${slotName}: not tracked by Supervisor, marking STALE-RUNTIME and releasing`,
      );

      if (slotState.seq != null) {
        await this.addLabelSafe(String(slotState.seq), 'STALE-RUNTIME');
      }

      if (slotState.seq != null) {
        orphanedTasks.push({ seq: String(slotState.seq), slotName });
      } else {
        orphanedSlots.push(slotName);
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
        this.runtimeStore.updateState('monitor-orphan-cleanup', (draft) => {
          for (const slotName of orphanedSlots) {
            this.runtimeStore.clearWorkerSlot(draft, slotName);
          }
          for (const { seq } of orphanedTasks) {
            this.runtimeStore.releaseTaskProjection(draft, seq, {
              phase: 'suspended',
              keepWorktree: true,
            });
          }
        });
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
    const inprogressCards = await this.listRuntimeAwareInprogressCards();
    let staleCount = 0;

    for (const card of inprogressCards) {
      if (card.labels.includes('STALE-RUNTIME') || card.labels.includes('CONFLICT') || card.labels.includes('NEEDS-FIX')) continue;

      const state = this.runtimeStore.readState();
      const runtime = this.runtimeStore.getTask(card.seq, state);
      const branchName = this.buildBranchName(card);

      if (!runtime.slotName || !runtime.slot) {
        // Grace period: when a worker just completed, EventHandler releases
        // the slot (sync) but PM move to QA is async. During this window
        // the lease exists with phase=merging/slot=null while PM is still
        // Inprogress. Allow 90 seconds for the PM operation to complete
        // before treating it as stale.
        if (runtime.lease) {
          const transitionAge = Date.now() - new Date(runtime.lease.lastTransitionAt).getTime();
          if (transitionAge < 90_000) {
            this.log.debug(`seq ${card.seq}: in transition (lease.phase=${runtime.lease.phase}, ${Math.round(transitionAge / 1000)}s ago) — skipping stale check`);
            continue;
          }
          const mrStatus = await this.safeMrStatus(branchName);
          if (mrStatus.state === 'merged') {
            this.log.info(`seq ${card.seq}: Card already merged, skipping stale check`);
            continue;
          }
        } else {
          const mrStatus = await this.safeMrStatus(branchName);
          if (mrStatus.state === 'merged') {
            this.log.info(`seq ${card.seq}: Card already merged while closeout was releasing resources, skipping stale check`);
            continue;
          }
        }
        this.log.warn(`seq ${card.seq}: Inprogress but no live lease-owned slot assigned`);
        await this.handleStaleRuntime(card, actions, recommendedActions);
        staleCount++;
        continue;
      }

      const slotState = runtime.slot;

      if (slotState.transport === 'acp-sdk' || slotState.mode === 'acp' || slotState.mode === 'acp-sdk') {
        const session = runtime.slotName ? state.sessions[runtime.slotName] : undefined;
        if (this.isAcpSessionAlive(session)) {
          continue;
        }
      }

      // Check if Supervisor is tracking this worker
      const seq = slotState.seq != null ? String(slotState.seq) : '';
      const workerId = `${this.ctx.projectName}:${runtime.slotName}:${seq}`;
      const handle = this.supervisor.get(workerId);

      if (handle && handle.exitCode === null) {
        // Supervisor tracking and worker still running — not stale
        continue;
      }

      if (!handle) {
        // Not tracked by Supervisor and no slot → stale
        // Check for MR as a last resort
        const mrStatus = await this.safeMrStatus(slotState.branch || runtime.lease?.branch || branchName);

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

  private async listRuntimeAwareInprogressCards(): Promise<{ seq: string; name: string; labels: string[] }[]> {
    // Collect cards from all stage activeStates (not just the first stage)
    const bySeq = new Map<string, import('../models/types.js').Card>();
    for (const stage of this.pipelineAdapter.stages) {
      const cards = await this.taskBackend.listByState(stage.activeState);
      for (const card of cards) bySeq.set(card.seq, card);
    }
    const state = this.runtimeStore.readState();

    for (const [seq, lease] of Object.entries(state.leases)) {
      if (bySeq.has(seq)) continue;
      if (!['coding', 'merging', 'resolving_conflict', 'waiting_confirmation', 'closing'].includes(lease.phase)) continue;
      const card = await this.taskBackend.getBySeq(seq);
      if (card) bySeq.set(seq, card);
    }

    return Array.from(bySeq.values())
      .sort((a, b) => parseInt(a.seq, 10) - parseInt(b.seq, 10))
      .map(card => ({ seq: card.seq, name: card.name, labels: card.labels }));
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
        await this.taskBackend.move(seq, this.pipelineAdapter.states.review);
        this.log.ok(`seq ${seq}: Auto-moved to ${this.pipelineAdapter.states.review} (MONITOR_AUTO_QA=true)`);
        actions.push({
          action: 'auto-qa',
          entity: `seq:${seq}`,
          result: 'ok',
          message: `Stale runtime — auto-moved to ${this.pipelineAdapter.states.review}`,
        });
        this.logEvent('auto-qa', seq, 'ok');
        await this.notifySafe(`⚠️ [${this.ctx.projectName}] seq:${seq} auto-moved to ${this.pipelineAdapter.states.review} (stale runtime)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error(`seq ${seq}: Failed to auto-move to ${this.pipelineAdapter.states.review}: ${msg}`);
        actions.push({
          action: 'auto-qa',
          entity: `seq:${seq}`,
          result: 'fail',
          message: `Auto-QA failed: ${msg}`,
        });
      }
    } else {
      await this.notifySafe(`⚠️ [${this.ctx.projectName}] seq:${seq} has a stale runtime — worker session dead but MR may exist`);
      recommendedActions.push({
        action: `Move seq:${seq} to ${this.pipelineAdapter.states.review} or investigate stale runtime`,
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
    const state = this.runtimeStore.readState();
    const timeoutHours = this.ctx.config.INPROGRESS_TIMEOUT_HOURS;
    const now = Date.now();
    let timeoutCount = 0;

    for (const [seq, lease] of Object.entries(state.leases)) {
      if (!['coding', 'merging', 'resolving_conflict', 'waiting_confirmation', 'closing'].includes(lease.phase)) continue;

      const startTime = new Date(lease.claimedAt || lease.lastTransitionAt).getTime();
      const elapsedHours = (now - startTime) / (1000 * 60 * 60);

      if (elapsedHours <= timeoutHours) continue;

      // Check for recent heartbeat
      const slotState = lease.slot ? state.workers[lease.slot] || null : null;
      if (slotState) {
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
      await this.notifySafe(`⚠️ [${this.ctx.projectName}] seq:${seq} has exceeded timeout (${elapsedHours.toFixed(1)}h)`);

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
    const state = this.runtimeStore.readState();
    let waitingCount = 0;

    for (const [seq, lease] of Object.entries(state.leases)) {
      if (lease.phase !== 'waiting_confirmation' || !lease.slot) continue;
      const slotName = lease.slot;
      const slotState = state.workers[slotName];
      if (!slotState) continue;
      const isAgentTransport =
        slotState.transport === 'acp-sdk' ||
        slotState.mode === 'acp' ||
        slotState.mode === 'acp-sdk';

      if (isAgentTransport) {
        const session = state.sessions[slotName];
        const pending = session?.pendingInput;
        if (!session || !['waiting_input', 'needs_confirmation'].includes(session.currentRun?.status || '') || !pending) continue;

        await this.addLabelSafe(seq, 'WAITING-CONFIRMATION');
        await this.notifySafe(`👆 [${this.ctx.projectName}] seq:${seq} waiting for confirmation (${pending.type}): ${pending.prompt}`);
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
      }

      // ACP SDK handles permission requests via requestPermission callback in AcpSdkAdapter.
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
    const s = this.pipelineAdapter.states;
    const states = [s.backlog, s.ready, s.active, s.review];
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
    const state = this.runtimeStore.readState();
    const discrepancies: string[] = [];

    for (const [seq, lease] of Object.entries(state.leases)) {
      if (!['coding', 'merging', 'resolving_conflict', 'waiting_confirmation', 'closing'].includes(lease.phase)) continue;
      if (!lease.slot) {
        // Grace period: after development completes, lease transitions to
        // phase=merging with slot=null while EventHandler processes PM move.
        // This is a normal transient state, not a real discrepancy.
        const transitionAge = Date.now() - new Date(lease.lastTransitionAt).getTime();
        if (transitionAge < 90_000) continue;
        discrepancies.push(`seq:${seq}: lease phase=${lease.phase} but no slot is assigned`);
        continue;
      }
      const slotName = lease.slot;
      const slotState = state.workers[slotName];
      if (!slotState) {
        discrepancies.push(`seq:${seq}: lease references missing slot ${slotName}`);
        continue;
      }

      if (slotState.transport === 'acp-sdk' || slotState.mode === 'acp' || slotState.mode === 'acp-sdk') {
        const session = state.sessions[slotName];
        if (this.isAcpSessionAlive(session)) continue;
      }

      const slotSeq = slotState.seq != null ? String(slotState.seq) : '';
      const workerId = `${this.ctx.projectName}:${slotName}:${slotSeq}`;
      const handle = this.supervisor.get(workerId);

      if (!handle) {
        discrepancies.push(
          `seq:${seq}: lease says active via ${slotName} but Supervisor has no handle`,
        );
      } else if (handle.exitCode !== null) {
        discrepancies.push(
          `seq:${seq}: lease says active via ${slotName} but Supervisor reports exited (code=${handle.exitCode})`,
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
    const state = this.runtimeStore.readState();
    let issues = 0;

    for (const [seq, lease] of Object.entries(state.leases)) {
      if (!['coding', 'merging', 'resolving_conflict', 'waiting_confirmation', 'closing'].includes(lease.phase)) continue;
      if (!lease.slot) continue;
      const slotName = lease.slot;
      const slotState = state.workers[slotName];
      if (!slotState || slotState.status !== 'active' || slotState.mode !== 'print') continue;
      if (!slotState.outputFile || !slotState.claimedAt) continue;

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
        await this.autoRetry(seq, slotName, actions, `No output after ${Math.round(elapsedS)}s`);
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
          await this.autoRetry(seq, slotName, actions, `No output for ${idleMin}min`);
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
    actions: ActionRecord[],
    reason: string,
  ): Promise<void> {
    const state = this.runtimeStore.readState();
    const restartLimit = this.ctx.config.WORKER_RESTART_LIMIT;
    const runtime = this.runtimeStore.getTask(seq, state);
    const retryCount = runtime.lease?.retryCount ?? runtime.activeCard?.retryCount ?? 0;

    if (retryCount < restartLimit) {
      try {
        await this.taskBackend.move(seq, this.pipelineAdapter.states.ready);
        await this.removeLabelSafe(seq, 'CLAIMED');
        await this.removeLabelSafe(seq, 'STALE-RUNTIME');
        this.runtimeStore.updateState('monitor-auto-retry', (draft) => {
          this.runtimeStore.clearWorkerSlot(draft, slotName);
          delete draft.activeCards[seq];
          if (draft.leases[seq]) {
            draft.leases[seq].retryCount = retryCount + 1;
            draft.leases[seq].phase = 'queued';
            draft.leases[seq].slot = null;
            draft.leases[seq].sessionId = null;
            draft.leases[seq].runId = null;
            draft.leases[seq].pmStateObserved = this.pipelineAdapter.states.ready;
            draft.leases[seq].lastTransitionAt = new Date().toISOString();
          }
        });

        const attempt = retryCount + 1;
        this.log.ok(`seq ${seq}: Auto-retry ${attempt}/${restartLimit} — moved back to ${this.pipelineAdapter.states.ready} (${reason})`);
        await this.notifySafe(`⚠️ [${this.ctx.projectName}] seq:${seq} auto-retry ${attempt}/${restartLimit} — ${reason}`);
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
        this.runtimeStore.updateState('monitor-auto-retry-fail', (draft) => {
          this.runtimeStore.clearWorkerSlot(draft, slotName);
          delete draft.activeCards[seq];
          if (draft.leases[seq]) {
            draft.leases[seq].slot = null;
            draft.leases[seq].sessionId = null;
            draft.leases[seq].runId = null;
            draft.leases[seq].lastTransitionAt = new Date().toISOString();
          }
        });
        actions.push({
          action: 'auto-retry',
          entity: `seq:${seq}`,
          result: 'fail',
          message: `Auto-retry failed: ${msg}`,
        });
      }
    } else {
      // Retry limit reached — mark as BLOCKED
      this.runtimeStore.updateState('monitor-retry-exhausted', (draft) => {
        this.runtimeStore.clearWorkerSlot(draft, slotName);
        delete draft.activeCards[seq];
        if (draft.leases[seq]) {
          draft.leases[seq].retryCount = retryCount;
          draft.leases[seq].phase = 'suspended';
          draft.leases[seq].slot = null;
          draft.leases[seq].sessionId = null;
          draft.leases[seq].runId = null;
          draft.leases[seq].lastTransitionAt = new Date().toISOString();
        }
      });
      try {
        await this.addLabelSafe(seq, 'BLOCKED');
        await this.taskBackend.move(seq, this.pipelineAdapter.states.ready);
        await this.taskBackend.comment(
          seq,
          `Auto-retry limit reached (${restartLimit}). Last failure: ${reason}. Needs manual intervention.`,
        );
      } catch { /* best effort */ }

      this.log.error(`seq ${seq}: Retry limit reached (${restartLimit}), marked BLOCKED`);
      await this.notifySafe(`❌ [${this.ctx.projectName}] seq:${seq} retry limit reached (${restartLimit}x) — marked BLOCKED, needs manual review`);
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
    return ['submitted', 'running', 'waiting_input', 'needs_confirmation', 'stalled_submit'].includes(session.currentRun.status);
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

  private async notifySafe(message: string): Promise<void> {
    if (!this.notifier) return;
    try {
      await this.notifier.send(message);
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
