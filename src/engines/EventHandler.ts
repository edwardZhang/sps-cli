/**
 * SPSEventHandler — decoupled event handler for WorkerManager lifecycle events.
 *
 * Replaces the direct PostActions coupling in WorkerManagerImpl.handleExit().
 * PM operations (move, comment, label, release) are executed here and
 * failures are saved to pendingPMActions for retry on the next tick cycle.
 *
 * Phase 3 of the Worker Manager refactor (T60-T64).
 */
import type { WorkerEvent, WorkerEventHandler } from '../manager/worker-manager.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { RuntimeStore } from '../core/runtimeStore.js';
import type { PendingPMAction } from '../core/state.js';

// ─── Dependencies ──────────────────────────────────────────────

export interface EventHandlerDeps {
  taskBackend: TaskBackend;
  notifier?: Notifier;
  runtimeStore: RuntimeStore;
  project: string;
}

// ─── SPSEventHandler ──────────────────────────────────────────

export class SPSEventHandler {
  private readonly taskBackend: TaskBackend;
  private readonly notifier: Notifier | undefined;
  private readonly runtimeStore: RuntimeStore;
  private readonly project: string;

  constructor(deps: EventHandlerDeps) {
    this.taskBackend = deps.taskBackend;
    this.notifier = deps.notifier;
    this.runtimeStore = deps.runtimeStore;
    this.project = deps.project;
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

    // Release slot in runtime state first (never blocks on PM)
    this.releaseSlot(event);

    if (isIntegration) {
      await this.safeAction({ type: 'move', taskId, project: this.project, target: 'Done' });
    } else {
      await this.safeAction({ type: 'move', taskId, project: this.project, target: 'QA' });
    }

    await this.safeAction({ type: 'release', taskId, project: this.project });

    const reason = completionResult?.reason ?? 'unknown';
    const phaseLabel = isIntegration ? 'integration' : 'development';
    await this.safeNotify(`✅ seq:${taskId} completed ${phaseLabel} (${reason})`);
  }

  private async onFailed(event: WorkerEvent): Promise<void> {
    const { taskId, exitCode, completionResult } = event;
    const reason = completionResult?.reason ?? 'unknown';

    // Release slot in runtime state first
    this.releaseSlot(event);

    // Add NEEDS-FIX label and comment
    await this.safeAction({ type: 'label', taskId, project: this.project, target: 'NEEDS-FIX' });
    await this.safeAction({
      type: 'comment',
      taskId,
      project: this.project,
      message: `Worker ${reason} (exit ${exitCode ?? 1}). Marked as NEEDS-FIX.`,
    });

    await this.safeNotify(`⚠️ seq:${taskId} FAILED — ${reason}`);
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
            pmStateObserved: 'QA',
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
      const fullMsg = `[${this.project}] ${message}`;
      await this.notifier.send(fullMsg);
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
