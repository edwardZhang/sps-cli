/**
 * @module        runtime-coordinator
 * @description   运行时协调器，管理 Worker 生命周期调度与状态恢复
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-27
 * @updated       2026-04-03
 *
 * @role          manager
 * @layer         manager
 * @boundedContext worker-lifecycle
 */

import type { ProjectContext } from '../core/context.js';
import { RuntimeStore } from '../core/runtimeStore.js';
import {
  isPersistedSessionAlive,
} from '../core/sessionLiveness.js';
import {
  createIdleWorkerSlot,
  type RuntimeState,
  type WorkerSlotState,
} from '../core/state.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { ACPRunStatus, ACPSessionRecord } from '../models/acp.js';

const TERMINAL_RUN_STATUSES = new Set<ACPRunStatus>(['completed', 'failed', 'cancelled', 'lost']);

export interface RuntimeRebuildResult {
  state: RuntimeState;
  updated: boolean;
}

/**
 * RuntimeCoordinator — simplified for single-worker model.
 *
 * No worktree scanning, no branch evidence inspection. The coordinator
 * normalizes ACP sessions and rebuilds worker slot state from persisted
 * leases and PM card states.
 */
export class RuntimeCoordinator {
  constructor(private readonly ctx: ProjectContext, private readonly taskBackend: TaskBackend) {}

  async buildRuntimeProjection(): Promise<RuntimeRebuildResult> {
    return this.computeRuntimeProjection(false, 'runtime-coordinator');
  }

  async rebuildRuntimeProjection(updatedBy = 'runtime-coordinator'): Promise<RuntimeRebuildResult> {
    return this.computeRuntimeProjection(true, updatedBy);
  }

  /**
   * Single-worker model: no worktree/branch scanning.
   * Just normalize sessions and ensure worker slots are consistent.
   */
  private async computeRuntimeProjection(persist: boolean, updatedBy: string): Promise<RuntimeRebuildResult> {
    const store = new RuntimeStore(this.ctx);
    const state = store.readState();

    const normalizedSessions = this.normalizeSessions(state);

    // Ensure correct number of worker slots
    const nextWorkers: Record<string, WorkerSlotState> = {};
    for (let i = 1; i <= this.ctx.maxWorkers; i++) {
      const slotName = `worker-${i}`;
      nextWorkers[slotName] = state.workers[slotName] ?? createIdleWorkerSlot();
    }

    const changed =
      JSON.stringify(state.workers) !== JSON.stringify(nextWorkers) ||
      JSON.stringify(state.sessions) !== JSON.stringify(normalizedSessions);

    if (persist && changed) {
      store.updateState(updatedBy, (runtimeState) => {
        runtimeState.workers = nextWorkers;
        runtimeState.sessions = normalizedSessions;
      });
    }

    const nextState = structuredClone(state) as RuntimeState;
    nextState.workers = nextWorkers;
    nextState.sessions = normalizedSessions;

    return { state: nextState, updated: changed };
  }

  private normalizeSessions(state: RuntimeState): Record<string, ACPSessionRecord> {
    const nextSessions: Record<string, ACPSessionRecord> = { ...state.sessions };

    for (const [slotName, session] of Object.entries(state.sessions)) {
      const slot = state.workers[slotName];
      if (!slot) continue;
      if (isPersistedSessionAlive(slot, session)) continue;

      const nextRun =
        session.currentRun && !TERMINAL_RUN_STATUSES.has(session.currentRun.status)
          ? {
              ...session.currentRun,
              status: 'lost' as const,
              updatedAt: new Date().toISOString(),
              completedAt: session.currentRun.completedAt || new Date().toISOString(),
            }
          : session.currentRun;

      nextSessions[slotName] = {
        ...session,
        status: 'offline',
        sessionState: 'offline',
        currentRun: nextRun,
        pendingInput: null,
        updatedAt: new Date().toISOString(),
      };
    }

    return nextSessions;
  }
}
