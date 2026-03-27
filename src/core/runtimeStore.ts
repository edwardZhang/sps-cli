import type { ProjectContext } from './context.js';
import { readACPState, writeACPState } from './acpState.js';
import {
  createIdleWorkerSlot,
  readState,
  writeState,
  type ActiveCardState,
  type RuntimeState,
  type TaskLease,
  type WorkerSlotState,
  type WorktreeEvidence,
} from './state.js';
import type { ACPState, ACPSessionRecord } from '../models/acp.js';

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

export class RuntimeStore {
  constructor(private readonly ctx: RuntimePaths) {}

  readState(): RuntimeState {
    return readState(this.ctx.paths.stateFile, this.ctx.maxWorkers);
  }

  readACPState(): ACPState {
    if (!this.ctx.paths.acpStateFile) {
      return {
        version: 1,
        updatedAt: new Date(0).toISOString(),
        updatedBy: 'runtime-store-empty',
        sessions: {},
      };
    }
    return readACPState(this.ctx.paths.acpStateFile);
  }

  read(): { state: RuntimeState; acpState: ACPState } {
    return {
      state: this.readState(),
      acpState: this.readACPState(),
    };
  }

  updateState(updatedBy: string, mutator: (state: RuntimeState) => void): RuntimeState {
    const state = this.readState();
    mutator(state);
    writeState(this.ctx.paths.stateFile, state, updatedBy);
    return state;
  }

  updateACPState(updatedBy: string, mutator: (acpState: ACPState) => void): ACPState {
    if (!this.ctx.paths.acpStateFile) {
      throw new Error('acpStateFile is not configured for this RuntimeStore');
    }
    const acpState = this.readACPState();
    mutator(acpState);
    writeACPState(this.ctx.paths.acpStateFile, acpState, updatedBy);
    return acpState;
  }

  updateRuntime(
    updatedBy: string,
    mutator: (state: RuntimeState, acpState: ACPState) => void,
  ): { state: RuntimeState; acpState: ACPState } {
    if (!this.ctx.paths.acpStateFile) {
      throw new Error('acpStateFile is not configured for this RuntimeStore');
    }
    const state = this.readState();
    const acpState = this.readACPState();
    mutator(state, acpState);
    writeState(this.ctx.paths.stateFile, state, updatedBy);
    writeACPState(this.ctx.paths.acpStateFile, acpState, updatedBy);
    return { state, acpState };
  }

  getTask(seq: string, state?: RuntimeState, acpState?: ACPState): TaskRuntimeView {
    const runtimeState = state ?? this.readState();
    const runtimeACP = acpState ?? this.readACPState();
    const key = String(seq);
    const lease = runtimeState.leases[key] || null;
    const slotName =
      lease?.slot ||
      Object.entries(runtimeState.workers).find(([, worker]) => worker.seq === parseInt(key, 10))?.[0] ||
      null;
    const slot = slotName ? runtimeState.workers[slotName] || null : null;
    const session = slotName ? runtimeACP.sessions[slotName] || null : null;

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
}
