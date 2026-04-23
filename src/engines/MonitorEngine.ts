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
import type { WorkerManager } from '../manager/worker-manager.js';
import type { ActionRecord, CheckResult, CommandResult, RecommendedAction } from '../shared/types.js';
import { isProcessAlive } from '../providers/outputParser.js';

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
    private workerManager: WorkerManager,
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
      return await this.repoBackend.getMrStatus(branch);
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
      // v0.50.12：优先自愈 Stop-hook race 留下的 false-positive NEEDS-FIX（同时
      // 带 COMPLETED-<stage>）。放最前面，这样后续 check 看到的是已清理的卡。
      await this.checkRaceRecovery(checks, actions);
      await this.checkWorkerHealth(checks, actions);
      await this.checkAcpShimHealth(checks, actions);
      await this.checkOrphanSlots(checks, actions);
      await this.checkAckTimeout(checks, actions);
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

  /**
   * v0.50.18：tick 起步统一入口——race-recovery + halt detection 合在一起。
   * 封装了 "race-recovery 必须在 halt-check 之前" 的语义，tick.ts 只需调这一个。
   *
   * 返回：
   *   - halted=false → tick 继续
   *   - halted=true + needsFixCards → tick 应该提前 return halt result
   */
  async preFlightCheck(): Promise<{
    healed: number;
    halted: boolean;
    needsFixCards: string[];
  }> {
    const healed = await this.healRaceConditions();

    const needsFixCards: string[] = [];
    for (const cardState of this.pipelineAdapter.activeStates) {
      try {
        const cards = await this.taskBackend.listByState(cardState);
        for (const card of cards) {
          if (card.labels.includes('NEEDS-FIX')) {
            needsFixCards.push(`seq:${card.seq} (${card.title})`);
          }
        }
      } catch (err) {
        this.log.warn(`preFlightCheck scan ${cardState} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { healed, halted: needsFixCards.length > 0, needsFixCards };
  }

  /**
   * v0.50.16：供 tick.ts 在 halt-check 前显式跑一次 race-recovery 的兜底 API。
   * v0.50.18：推荐用 preFlightCheck 统一入口；这个保留做细粒度控制。
   *
   * 返回被自愈的卡片数；失败不抛（best-effort）。
   */
  async healRaceConditions(): Promise<number> {
    const checks: CheckResult[] = [];
    const actions: ActionRecord[] = [];
    try {
      await this.checkRaceRecovery(checks, actions);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.warn(`healRaceConditions failed (non-fatal): ${msg}`);
      return 0;
    }
    return actions.filter((a) => a.action === 'race-recovery' && a.result === 'ok').length;
  }

  // ─── Check 0: Race-recovery (v0.50.12) ────────────────────────────
  //
  // 场景：Stop hook 是 Claude 异步写的文件操作，ACP session_completed 可能比它
  // 早到达 SPS。`EventHandler.onCompleted` 读卡时 label 还没写 → 误标 NEEDS-FIX
  // → 稍后 hook 写上 COMPLETED-<stage> → 卡片两个 label 同时在，永远卡在 Inprogress。
  //
  // 这里识别这种"race 留下的假阳性 NEEDS-FIX"：卡片同时带 NEEDS-FIX + COMPLETED-<stage>
  // 时，按成功语义处理：清 NEEDS-FIX/CLAIMED/STARTED-<stage> + 移到 onCompleteState
  // + 释放 slot/lease。
  //
  // EventHandler 侧已加 5s 轮询预防大部分 race；这里作为兜底处理已卡住的卡 +
  // 更慢的 hook 情况。

  private async checkRaceRecovery(
    checks: CheckResult[],
    actions: ActionRecord[],
  ): Promise<void> {
    const recovered: string[] = [];

    for (const stage of this.pipelineAdapter.stages) {
      const cards = await this.taskBackend.listByState(stage.activeState);
      const completedLabel = `COMPLETED-${stage.name}`;
      for (const card of cards) {
        if (!card.labels.includes('NEEDS-FIX')) continue;
        if (!card.labels.includes(completedLabel)) continue;
        // v0.50.17：多一条判定——只有 EventHandler.onCompleted 打 RACE-CANDIDATE 的卡
        // 才是真正的 race。onFailed 打的 NEEDS-FIX（真失败）不会有这个标记，不会被误
        // 自愈。避免 #17 那种"先 race 后真失败"的组合被错误推进 Done。
        if (!card.labels.includes('RACE-CANDIDATE')) continue;

        // race-recovery：按 onCompleted 成功路径处理
        try {
          // 清瞬态 label —— NEEDS-FIX / RACE-CANDIDATE 是误判，CLAIMED/STARTED-<stage> 是运行时残留
          await this.removeLabelSafe(card.seq, 'NEEDS-FIX');
          await this.removeLabelSafe(card.seq, 'RACE-CANDIDATE');
          await this.removeLabelSafe(card.seq, 'CLAIMED');
          await this.removeLabelSafe(card.seq, `STARTED-${stage.name}`);

          // 移到下一阶段
          const targetState = stage.onCompleteState || this.pipelineAdapter.states.done;
          if (card.state !== targetState) {
            await this.taskBackend.move(card.seq, targetState);
          }

          // 清 state.json 里的 slot + lease
          this.runtimeStore.updateState('monitor-race-recovery', (draft) => {
            this.runtimeStore.releaseTaskProjection(draft, card.seq, { dropLease: true });
          });

          recovered.push(card.seq);
          this.log.ok(`seq ${card.seq}: race-recovery — cleared NEEDS-FIX (has ${completedLabel}), advanced to ${targetState}`);
          actions.push({
            action: 'race-recovery',
            entity: `seq:${card.seq}`,
            result: 'ok',
            message: `Stop-hook race healed: NEEDS-FIX cleared, advanced to ${targetState}`,
          });
          this.logEvent('race-recovery', card.seq, 'ok', { stage: stage.name, targetState });
          await this.notifySafe(
            `✅ [${this.ctx.projectName}] seq:${card.seq} race-recovery — NEEDS-FIX cleared, advanced to ${targetState}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.log.error(`seq ${card.seq}: race-recovery failed: ${msg}`);
          actions.push({
            action: 'race-recovery',
            entity: `seq:${card.seq}`,
            result: 'fail',
            message: `race-recovery failed: ${msg}`,
          });
        }
      }
    }

    checks.push({
      name: 'race-recovery',
      status: 'pass',
      message: recovered.length > 0
        ? `Healed ${recovered.length} Stop-hook race card(s): ${recovered.join(', ')}`
        : 'no race-condition cards',
    });
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

  // ─── Check 1b: ACK Timeout Detection ──────────────────────────
  //
  // Detects resumeRun failures — when SPS dispatched a card but Claude never
  // started processing (no UserPromptSubmit hook → no STARTED-<stage> label).
  // Fires on a short time-scale (WORKER_ACK_TIMEOUT_S, default 60s) before the
  // longer-scale stale/timeout checks. Labels the card with ACK-TIMEOUT;
  // StageEngine responds in the next tick by killing the worker and retrying
  // (or escalating to NEEDS-FIX if already retried once).

  private async checkAckTimeout(
    checks: CheckResult[],
    actions: ActionRecord[],
  ): Promise<void> {
    const timeoutS = this.ctx.config.WORKER_ACK_TIMEOUT_S;
    const now = Date.now();
    let ackTimeoutCount = 0;

    // Per-stage scan: each stage's activeState cards need their own STARTED-<stageName>
    // to count as "acknowledged". A card that finished develop and entered review
    // still has STARTED-develop, but needs STARTED-review to prove review started.
    for (const stage of this.pipelineAdapter.stages) {
      if (!stage.activeState) continue;
      let cards: Array<{ seq: string; labels: string[] }> = [];
      try {
        cards = await this.taskBackend.listByState(stage.activeState as any) as any;
      } catch { continue; }

      const expectedLabel = `STARTED-${stage.name}`;

      for (const card of cards) {
        if (card.labels.includes(expectedLabel)) continue;           // acknowledged
        if (card.labels.includes('NEEDS-FIX')) continue;              // already failed
        if (card.labels.includes('ACK-TIMEOUT')) continue;            // already flagged, StageEngine handles
        if (card.labels.includes('STALE-RUNTIME')) continue;          // different failure path
        if (card.labels.includes('CONFLICT')) continue;               // different failure path

        const state = this.runtimeStore.readState();
        const lease = state.leases[card.seq];
        if (!lease || !lease.claimedAt) continue;                     // no dispatch timestamp to compare against

        const elapsedS = (now - new Date(lease.claimedAt).getTime()) / 1000;
        if (elapsedS <= timeoutS) continue;                           // within ack window

        this.log.warn(
          `seq ${card.seq}: ACK timeout — dispatched ${Math.round(elapsedS)}s ago, no ${expectedLabel} label`,
        );
        await this.addLabelSafe(card.seq, 'ACK-TIMEOUT');
        actions.push({
          action: 'mark-ack-timeout',
          entity: `seq:${card.seq}`,
          result: 'ok',
          message: `dispatched ${Math.round(elapsedS)}s ago, no ${expectedLabel}`,
        });
        ackTimeoutCount++;
      }
    }

    checks.push({
      name: 'ack-timeout',
      status: ackTimeoutCount > 0 ? 'warn' : 'pass',
      message: ackTimeoutCount > 0
        ? `Found ${ackTimeoutCount} card(s) past ACK timeout`
        : 'No ACK timeouts',
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

  private async listRuntimeAwareInprogressCards(): Promise<{ seq: string; title: string; labels: string[] }[]> {
    // Collect cards from all stage activeStates (not just the first stage)
    const bySeq = new Map<string, import('../shared/types.js').Card>();
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
      .map(card => ({ seq: card.seq, title: card.title, labels: card.labels }));
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

  // ─── Check 8: ACP Shim Liveness ───────────────────────────────
  //
  // When shim (claude-agent-acp) dies mid-run — OOM kill, parent crash,
  // manual pkill — clearAcpSessionRun never fires and the active card's
  // lease stays in 'coding'/'merging'/etc. This check detects a dead shim
  // pid for an in-use pipeline slot, clears the stale session record so
  // the next ensureSession rebuilds fresh, and auto-retries the card.

  private async checkAcpShimHealth(
    checks: CheckResult[],
    actions: ActionRecord[],
  ): Promise<void> {
    const state = this.runtimeStore.readState();
    let issues = 0;

    for (const [slotName, session] of Object.entries(state.sessions ?? {})) {
      if (!slotName.startsWith('worker-')) continue;
      if (!session.pid) continue;
      if (session.sessionState === 'offline') continue;

      const worker = state.workers[slotName];
      // Only care about slots with an in-flight run — idle slots with a
      // leftover session record aren't broken (session-reuse design).
      if (!worker || worker.status === 'idle') continue;

      if (isProcessAlive(session.pid)) continue;

      const seq = worker.seq != null ? String(worker.seq) : null;
      this.log.error(
        `ACP shim dead: slot=${slotName} pid=${session.pid} session=${session.sessionId} (worker.status=${worker.status})`,
      );

      // Mark session offline so next ensureSession triggers resetExisting
      this.runtimeStore.updateState('monitor-acp-shim-dead', (draft) => {
        const s = draft.sessions[slotName];
        if (s) {
          s.sessionState = 'offline';
          s.status = 'offline';
          s.currentRun = null;
          s.lastSeenAt = new Date().toISOString();
        }
      });

      // Kill any remaining supervisor handle so subsequent state is clean
      if (seq) {
        const workerId = `${this.ctx.projectName}:${slotName}:${seq}`;
        try {
          await this.supervisor.kill(workerId);
        } catch (err) {
          // v0.50.18：supervisor.kill 失败通常是 pid 已死——benign，但留痕便于诊断
          this.log.warn(`supervisor.kill(${workerId}) failed (likely dead): ${err instanceof Error ? err.message : String(err)}`);
        }
        await this.autoRetry(seq, slotName, actions, `ACP shim died (pid ${session.pid})`);
      } else {
        // No active seq on this slot — just release it
        this.runtimeStore.updateState('monitor-acp-shim-dead-release', (draft) => {
          this.runtimeStore.clearWorkerSlot(draft, slotName);
        });
      }
      issues++;
    }

    checks.push({
      name: 'acp-shim-health',
      status: issues > 0 ? 'warn' : 'pass',
      message: issues > 0
        ? `${issues} dead ACP shim(s) detected and recovered`
        : 'All ACP shims healthy',
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
        // v0.41.1: Tell WorkerManager to release its taskSlotMap entry + kill
        // the shim process. Without this, the next launchWorker will hit
        // `duplicate_task` and this card will be permanently skipped while
        // newer cards get dispatched past it.
        try {
          await this.workerManager.cancel({
            taskId: seq, project: this.ctx.projectName, reason: 'anomaly',
          });
        } catch (err) {
          this.log.warn(`WorkerManager.cancel failed for seq ${seq} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
        }

        await this.taskBackend.move(seq, this.pipelineAdapter.states.ready);
        await this.removeLabelSafe(seq, 'CLAIMED');
        await this.removeLabelSafe(seq, 'STALE-RUNTIME');
        await this.removeLabelSafe(seq, 'ACK-TIMEOUT');

        // v0.41.1: Clear every STARTED-<stage> label. If left, MonitorEngine's
        // ACK-timeout check sees the stale label and skips the card — ACK
        // probe silently disabled after the first retry. We don't know the
        // stage here, so clear for every defined stage.
        for (const stage of this.pipelineAdapter.stages) {
          await this.removeLabelSafe(seq, `STARTED-${stage.name}`);
        }

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
      } catch (err) {
        // v0.50.18：move / comment 失败记日志，不然 retry 上限到了但卡片看起来没变化
        this.log.warn(`seq ${seq}: final BLOCKED move/comment failed: ${err instanceof Error ? err.message : String(err)}`);
      }

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

  private buildBranchName(card: { seq: string; title: string }): string {
    const slug = card.title
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
    } catch (err) {
      // v0.50.18：removeLabel 失败记日志（此前是静默吞）
      this.log.warn(`removeLabel(${seq}, ${label}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
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
