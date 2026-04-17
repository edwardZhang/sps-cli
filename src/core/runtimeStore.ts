/**
 * @module        runtimeStore
 * @description   运行时状态存储与任务视图查询
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-27
 * @updated       2026-04-03
 *
 * @role          state
 * @layer         core
 * @boundedContext runtime
 */
import { existsSync, readFileSync } from 'node:fs';
import type { ACPSessionRecord, ACPState } from '../models/acp.js';
import {
  type ActiveCardState,
  createIdleWorkerSlot,
  type RuntimeState,
  readState,
  type TaskLease,
  type WorkerSlotState,
  type WorktreeEvidence,
  writeState,
} from './state.js';

export interface TaskRuntimeView {
  seq: string;
  lease: TaskLease | null;
  evidence: WorktreeEvidence | null;
  activeCard: ActiveCardState | null;
  slotName: string | null;
  slot: WorkerSlotState | null;
  session: ACPSessionRecord | null;
}

type RuntimePaths = {
  paths: {
    stateFile: string;
    acpStateFile?: string;
  };
  maxWorkers: number;
};

/**
 * Create a thin ACPState view backed by the same sessions reference in RuntimeState.
 * Mutations to the view's sessions propagate to the underlying state.
 */
function acpView(state: RuntimeState): ACPState {
  return {
    version: state.version,
    updatedAt: state.updatedAt,
    updatedBy: state.updatedBy,
    sessions: state.sessions,
  };
}

export class RuntimeStore {
  private migrated = false;

  constructor(private readonly ctx: RuntimePaths) {}

  readState(): RuntimeState {
    const state = readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
    this.migrateACPStateOnce(state);
    return state;
  }

  /**
   * @deprecated Use readState().sessions instead.
   * Compat shim — returns a thin view backed by RuntimeState.sessions.
   */
  readACPState(): ACPState {
    return acpView(this.readState());
  }

  /**
   * @deprecated Use readState() instead.
   * Compat shim — both state and acpState reference the same underlying data.
   */
  read(): { state: RuntimeState; acpState: ACPState } {
    const state = this.readState();
    return { state, acpState: acpView(state) };
  }

  updateState(updatedBy: string, mutator: (state: RuntimeState) => void): RuntimeState {
    const state = this.readState();
    mutator(state);
    writeState(this.ctx.paths.stateFile, state, updatedBy);
    return state;
  }

  /**
   * @deprecated Use updateState() and mutate state.sessions instead.
   * Compat shim — mutates state.sessions through a thin ACPState view, then writes state.json.
   */
  updateACPState(updatedBy: string, mutator: (acpState: ACPState) => void): ACPState {
    const state = this.readState();
    const view = acpView(state);
    mutator(view);
    // Sessions are shared by reference — mutations to view.sessions are already in state.sessions
    writeState(this.ctx.paths.stateFile, state, updatedBy);
    return view;
  }

  /**
   * @deprecated Use updateState() instead.
   * Compat shim — applies mutator to both state and a thin acpState view, writes single file.
   */
  updateRuntime(
    updatedBy: string,
    mutator: (state: RuntimeState, acpState: ACPState) => void,
  ): { state: RuntimeState; acpState: ACPState } {
    const state = this.readState();
    const view = acpView(state);
    mutator(state, view);
    writeState(this.ctx.paths.stateFile, state, updatedBy);
    return { state, acpState: view };
  }

  getTask(seq: string, state?: RuntimeState): TaskRuntimeView {
    const runtimeState = state ?? this.readState();
    const key = String(seq);
    const lease = runtimeState.leases[key] || null;
    const slotName =
      lease?.slot ||
      Object.entries(runtimeState.workers).find(([, worker]) => worker.seq === parseInt(key, 10))?.[0] ||
      null;
    const slot = slotName ? runtimeState.workers[slotName] || null : null;
    const session = slotName ? runtimeState.sessions[slotName] || null : null;

    return {
      seq: key,
      lease,
      evidence: runtimeState.worktreeEvidence[key] || null,
      activeCard: runtimeState.activeCards[key] || null,
      slotName,
      slot,
      session,
    };
  }

  findSlotForTask(seq: string, state: RuntimeState): string | null {
    const key = String(seq);
    return (
      state.leases[key]?.slot ||
      Object.entries(state.workers).find(([, worker]) => worker.seq === parseInt(key, 10))?.[0] ||
      null
    );
  }

  findAvailableSlot(
    state: RuntimeState,
    options: { preferred?: string | null; exclude?: Set<string> } = {},
  ): string | null {
    const exclude = options.exclude ?? new Set<string>();
    if (options.preferred) {
      const preferred = state.workers[options.preferred];
      if (preferred && preferred.status === 'idle' && !exclude.has(options.preferred)) {
        return options.preferred;
      }
    }

    return (
      Object.entries(state.workers).find(
        ([slotName, worker]) => worker.status === 'idle' && !exclude.has(slotName),
      )?.[0] || null
    );
  }

  clearWorkerSlot(state: RuntimeState, slotName: string): void {
    state.workers[slotName] = createIdleWorkerSlot();
  }

  releaseTaskProjection(
    state: RuntimeState,
    seq: string,
    options: {
      dropLease?: boolean;
      phase?: TaskLease['phase'];
      keepWorktree?: boolean;
      pmStateObserved?: TaskLease['pmStateObserved'];
    } = {},
  ): void {
    const slotName = this.findSlotForTask(seq, state);
    if (slotName) {
      this.clearWorkerSlot(state, slotName);
    }

    delete state.activeCards[seq];

    if (options.dropLease) {
      delete state.leases[seq];
      return;
    }

    const lease = state.leases[seq];
    if (!lease) return;

    lease.slot = null;
    lease.sessionId = null;
    lease.runId = null;
    lease.phase = options.phase ?? 'suspended';
    lease.pmStateObserved = options.pmStateObserved ?? lease.pmStateObserved;
    if (!options.keepWorktree) {
      lease.worktree = null;
      lease.branch = null;
    }
    lease.lastTransitionAt = new Date().toISOString();
  }

  /**
   * One-time migration: if state.sessions is empty and the legacy acp-state.json exists,
   * merge its sessions into state and persist.
   */
  private migrateACPStateOnce(state: RuntimeState): void {
    if (this.migrated) return;
    this.migrated = true;

    if (Object.keys(state.sessions).length > 0) return;

    const legacyFile = this.ctx.paths.acpStateFile;
    if (!legacyFile || !existsSync(legacyFile)) return;

    try {
      const raw = JSON.parse(readFileSync(legacyFile, 'utf-8')) as ACPState;
      if (raw.sessions && Object.keys(raw.sessions).length > 0) {
        Object.assign(state.sessions, raw.sessions);
        writeState(this.ctx.paths.stateFile, state, 'acp-state-migration');
      }
    } catch {
      // Legacy file is corrupt or unreadable — ignore
    }
  }
}
