import type { ACPSessionRecord } from '../models/acp.js';
import type { WorkerSlotState } from './state.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'lost']);

export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isPTYBackedSlot(
  slot: Pick<WorkerSlotState, 'transport' | 'mode'>,
  session?: Pick<ACPSessionRecord, 'sessionId'> | null,
): boolean {
  return (
    slot.transport === 'pty' ||
    slot.mode === 'pty' ||
    Boolean(session?.sessionId && session.sessionId.startsWith('pty-'))
  );
}

export function isACPBackedSlot(slot: Pick<WorkerSlotState, 'transport' | 'mode'>): boolean {
  return (
    slot.transport === 'acp' ||
    slot.transport === 'pty' ||
    slot.mode === 'acp' ||
    slot.mode === 'pty'
  );
}

export function extractPersistedSessionPid(
  session?: Pick<ACPSessionRecord, 'pid' | 'sessionId'> | null,
): number | null {
  if (session?.pid && session.pid > 0) return session.pid;
  const match = session?.sessionId?.match(/^pty-[^-]+-(\d+)-\d+$/);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

export function getPersistedRunStatus(
  slot: Pick<WorkerSlotState, 'remoteStatus'>,
  session?: Pick<ACPSessionRecord, 'pendingInput' | 'currentRun'> | null,
): string | null {
  if (session?.pendingInput) {
    return session.pendingInput.type === 'input' ? 'waiting_input' : 'needs_confirmation';
  }
  return session?.currentRun?.status || slot.remoteStatus || null;
}

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return !status || TERMINAL_RUN_STATUSES.has(status);
}

export function isPersistedSessionAlive(
  slot: Pick<WorkerSlotState, 'transport' | 'mode'>,
  session?: Pick<ACPSessionRecord, 'sessionId' | 'sessionState' | 'pid'> | null,
): boolean {
  if (!session || session.sessionState === 'offline') return false;

  if (isPTYBackedSlot(slot, session)) {
    return isProcessAlive(extractPersistedSessionPid(session));
  }

  return true;
}

export function hasPersistedActiveRun(
  slot: Pick<WorkerSlotState, 'transport' | 'mode' | 'remoteStatus'>,
  session?: Pick<ACPSessionRecord, 'sessionId' | 'sessionState' | 'pid' | 'pendingInput' | 'currentRun'> | null,
): boolean {
  const runStatus = getPersistedRunStatus(slot, session);
  return isPersistedSessionAlive(slot, session) && !isTerminalRunStatus(runStatus);
}
