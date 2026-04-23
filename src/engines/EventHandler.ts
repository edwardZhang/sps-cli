/**
 * @module        EventHandler
 * @description   解耦的事件处理器，处理 WorkerManager 生命周期事件及 PM 操作重试
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-28
 * @updated       2026-04-03
 *
 * @role          engine
 * @layer         engine
 * @boundedContext worker-lifecycle
 *
 * @stateTransition Inprogress → QA | Done (via PM move on worker exit)
 * @workflow       WorkerManager.exit → EventHandler.handle → PM ops → pendingPMActions retry
 */

import type { ProjectPipelineAdapter } from '../core/projectPipelineAdapter.js';
import type { RuntimeStore } from '../core/runtimeStore.js';
import type { PendingPMAction } from '../core/state.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { WorkerEvent, } from '../manager/worker-manager.js';
import type { Card } from '../shared/types.js';

// ─── Dependencies ──────────────────────────────────────────────

export interface EventHandlerDeps {
  taskBackend: TaskBackend;
  notifier?: Notifier;
  runtimeStore: RuntimeStore;
  project: string;
  pipelineAdapter: ProjectPipelineAdapter;
}

// ─── SPSEventHandler ──────────────────────────────────────────

export class SPSEventHandler {
  private readonly taskBackend: TaskBackend;
  private readonly notifier: Notifier | undefined;
  private readonly runtimeStore: RuntimeStore;
  private readonly project: string;
  private readonly pipelineAdapter: ProjectPipelineAdapter;

  constructor(deps: EventHandlerDeps) {
    this.taskBackend = deps.taskBackend;
    this.notifier = deps.notifier;
    this.runtimeStore = deps.runtimeStore;
    this.project = deps.project;
    this.pipelineAdapter = deps.pipelineAdapter;
  }

  /**
   * Main entry point — registered with WorkerManager.onEvent().
   * Dispatches to type-specific handlers. Errors are caught and logged
   * to avoid disrupting the WM event loop.
   */
  handle(event: WorkerEvent): void {
    switch (event.type) {
      case 'run.completed':
        this.onCompleted(event).catch((err) => this.logError('onCompleted', err));
        break;
      case 'run.failed':
        this.onFailed(event).catch((err) => this.logError('onFailed', err));
        break;
      case 'input.required':
        this.onInputRequired(event);
        break;
      case 'status.update':
        this.onStatusUpdate(event);
        break;
    }
  }

  /**
   * Retry any pending PM actions saved from previous failures.
   * Called by tick.ts at the start of each cycle.
   */
  async retryPendingActions(): Promise<{ retried: number; succeeded: number; failed: number }> {
    const state = this.runtimeStore.readState();
    const pending = state.pendingPMActions ?? [];
    if (pending.length === 0) return { retried: 0, succeeded: 0, failed: 0 };

    let succeeded = 0;
    let failed = 0;
    const remaining: PendingPMAction[] = [];

    for (const action of pending) {
      if (action.project !== this.project) {
        remaining.push(action);
        continue;
      }
      try {
        await this.executePMAction(action);
        succeeded++;
      } catch {
        action.retryCount++;
        if (action.retryCount < 5) {
          remaining.push(action);
        }
        failed++;
      }
    }

    this.runtimeStore.updateState('event-handler-retry', (s) => {
      s.pendingPMActions = remaining;
    });

    return { retried: pending.length, succeeded, failed };
  }

  // ─── Event Handlers ────────────────────────────────────────────

  private async onCompleted(event: WorkerEvent): Promise<void> {
    const { taskId, phase, completionResult } = event;
    const isIntegration =
      phase === 'integration' ||
      completionResult?.reason === 'already_merged';

    // Resolve the stage definition for this phase.
    // Try to match active-state stage first (e.g., cards in QA state match integrate stage);
    // fall back to first stage for development and last stage for integration.
    const stage = this.pipelineAdapter.getStage(phase || 'develop')
      || this.pipelineAdapter.stages[isIntegration ? this.pipelineAdapter.stages.length - 1 : 0];
    const targetState = stage?.onCompleteState || this.pipelineAdapter.states.done;

    // Release slot first — worker has exited regardless of downstream decisions.
    this.releaseSlot(event);

    // v0.39.0: Claude declares completion by adding a COMPLETED-<stage> label via Stop hook.
    // If the label is absent here, the ACP run finished but Claude did not declare (hook
    // didn't run, crashed mid-task, etc). Treat as NEEDS-FIX so the user sees the issue
    // instead of silently advancing a half-done card.
    const stageName = stage?.name ?? 'develop';
    const completedLabel = `COMPLETED-${stageName}`;
    let card: Card | null = null;
    try {
      card = await this.taskBackend.getBySeq(taskId);
    } catch (err) {
      this.logError('onCompleted: getBySeq', err);
    }
    const hasCompletedLabel = !!card?.labels.includes(completedLabel);

    if (!hasCompletedLabel) {
      this.log(`seq ${taskId}: ACP completed but ${completedLabel} label missing — marking NEEDS-FIX`);
      await this.safeAction({ type: 'label', taskId, project: this.project, target: 'NEEDS-FIX' });
      await this.safeAction({
        type: 'comment',
        taskId,
        project: this.project,
        message: `Worker finished but ${completedLabel} label was not set. Claude may have exited without declaring completion via the Stop hook.`,
      });
      await this.safeNotify(`⚠️ [${this.project}] seq:${taskId} ACP completed without ${completedLabel} label — NEEDS-FIX`);
      return;
    }

    // Label is present — advance state per YAML.
    await this.safeAction({ type: 'move', taskId, project: this.project, target: targetState });
    await this.safeAction({ type: 'release', taskId, project: this.project });

    const reason = completionResult?.reason ?? 'unknown';
    await this.safeNotify(`✅ [${this.project}] seq:${taskId} completed stage '${stageName}' (${reason})`);
  }

  private async onFailed(event: WorkerEvent): Promise<void> {
    const { taskId, exitCode, completionResult, phase } = event;
    const reason = completionResult?.reason ?? 'unknown';
    const isIntegration =
      phase === 'integration' ||
      completionResult?.reason === 'already_merged';

    // Resolve the stage definition for this phase
    const stage = this.pipelineAdapter.getStage(phase || 'develop')
      || this.pipelineAdapter.stages[isIntegration ? this.pipelineAdapter.stages.length - 1 : 0];
    const failLabel = stage?.onFailLabel ?? 'NEEDS-FIX';
    const failComment = stage?.onFailComment
      ?? `Worker ${reason} (exit ${exitCode ?? 1}). Marked as ${failLabel}.`;

    // Release slot in runtime state.
    this.releaseSlot(event);

    // Apply on_fail actions from stage config
    if (failLabel) {
      await this.safeAction({ type: 'label', taskId, project: this.project, target: failLabel });
    }
    await this.safeAction({
      type: 'comment',
      taskId,
      project: this.project,
      message: failComment,
    });

    await this.safeNotify(`⚠️ [${this.project}] seq:${taskId} FAILED — ${reason}`);
  }

  private onInputRequired(event: WorkerEvent): void {
    this.log(`Input required for task ${event.taskId}: ${event.pendingInput?.prompt ?? 'unknown'}`);
  }

  private onStatusUpdate(event: WorkerEvent): void {
    this.log(`Status update for task ${event.taskId}: ${event.state}`);
  }

  // ─── Slot Release ──────────────────────────────────────────────

  private releaseSlot(event: WorkerEvent): void {
    const { taskId, phase, completionResult } = event;
    const isIntegration =
      phase === 'integration' ||
      completionResult?.reason === 'already_merged';

    try {
      if (isIntegration) {
        this.runtimeStore.updateState('event-handler-release', (state) => {
          this.runtimeStore.releaseTaskProjection(state, taskId, { dropLease: true });
        });
      } else {
        this.runtimeStore.updateState('event-handler-release-to-qa', (state) => {
          this.runtimeStore.releaseTaskProjection(state, taskId, {
            dropLease: false,
            phase: 'merging',
            keepWorktree: true,
            pmStateObserved: this.pipelineAdapter.states.review,
          });
        });
      }
    } catch (err) {
      this.logError('releaseSlot', err);
    }
  }

  // ─── Safe PM Operations (with pending fallback) ────────────────

  private async safeAction(action: Omit<PendingPMAction, 'createdAt' | 'retryCount'>): Promise<void> {
    try {
      await this.executePMAction({ ...action, createdAt: new Date().toISOString(), retryCount: 0 });
    } catch {
      this.savePendingAction(action);
    }
  }

  private async executePMAction(action: PendingPMAction): Promise<void> {
    switch (action.type) {
      case 'move':
        if (action.target) {
          await this.taskBackend.move(action.taskId, action.target as Parameters<TaskBackend['move']>[1]);
        }
        break;
      case 'comment':
        if (action.message) {
          await this.taskBackend.comment(action.taskId, action.message);
        }
        break;
      case 'label':
        if (action.target) {
          await this.taskBackend.addLabel(action.taskId, action.target);
        }
        break;
      case 'release':
        await this.taskBackend.releaseClaim(action.taskId);
        break;
    }
  }

  private savePendingAction(action: Omit<PendingPMAction, 'createdAt' | 'retryCount'>): void {
    try {
      this.runtimeStore.updateState('event-handler-pending', (state) => {
        const pending = state.pendingPMActions ?? [];
        pending.push({
          ...action,
          createdAt: new Date().toISOString(),
          retryCount: 0,
        });
        state.pendingPMActions = pending;
      });
    } catch (err) {
      this.logError('savePendingAction', err);
    }
  }

  // ─── Notification ──────────────────────────────────────────────

  private async safeNotify(message: string): Promise<void> {
    if (!this.notifier) return;
    try {
      await this.notifier.send(message);
    } catch (err) {
      this.logError('notify', err);
    }
  }

  // ─── Logging ───────────────────────────────────────────────────

  private log(msg: string): void {
    process.stderr.write(`[event-handler] ${msg}\n`);
  }

  private logError(context: string, err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[event-handler] ${context} error: ${msg}\n`);
  }
}
