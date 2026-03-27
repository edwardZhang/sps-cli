import type { ACPState } from '../models/acp.js';
import { hasPersistedActiveRun, isACPBackedSlot, isProcessAlive } from './sessionLiveness.js';
import type { RuntimeState, WorkerSlotState } from './state.js';

export interface WorkerRuntimeSummary {
  total: number;
  idle: number;
  active: number;
  merging: number;
  stale: number;
  working: number;
}

function isLiveProcWorker(slot: WorkerSlotState): boolean {
  const pid = slot.pid ?? null;
  return !!(pid && isProcessAlive(pid));
}

export function summarizeWorkerRuntime(state: RuntimeState, acpState: ACPState): WorkerRuntimeSummary {
  const slots = Object.entries(state.workers);
  let active = 0;
  let merging = 0;
  let stale = 0;

  for (const [slotName, slot] of slots) {
    if (slot.status === 'active') {
      if (isACPBackedSlot(slot)) {
        const session = acpState.sessions[slotName];
        if (hasPersistedActiveRun(slot, session)) active++;
        else stale++;
      } else if (isLiveProcWorker(slot)) {
        active++;
      } else {
        stale++;
      }
      continue;
    }

    if (slot.status === 'merging' || slot.status === 'resolving') {
      merging++;
    }
  }

  const idle = slots.filter(([, slot]) => slot.status === 'idle').length;
  return {
    total: slots.length,
    idle,
    active,
    merging,
    stale,
    working: active + merging,
  };
}
