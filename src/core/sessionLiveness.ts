/**
 * @module        sessionLiveness
 * @description   会话与进程存活检测工具
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-27
 * @updated       2026-04-03
 *
 * @role          util
 * @layer         core
 * @boundedContext session
 */
import type { ACPSessionRecord } from '../models/acp.js';
import type { WorkerSlotState } from './state.js';

const TERMINAL_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'lost']);

import { isProcessAlive } from '../providers/outputParser.js';
export { isProcessAlive };

export function isACPBackedSlot(slot: Pick<WorkerSlotState, 'transport' | 'mode'>): boolean {
  return (
    slot.transport === 'acp-sdk' ||
    slot.mode === 'acp' ||
    slot.mode === 'acp-sdk'
  );
}

export function extractPersistedSessionPid(
  session?: Pick<ACPSessionRecord, 'pid' | 'sessionId'> | null,
): number | null {
  if (session?.pid && session.pid > 0) return session.pid;
  return null;
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

  // Check if the backing process is alive
  const pid = extractPersistedSessionPid(session);
  if (pid) return isProcessAlive(pid);

  return true;
}

export function hasPersistedActiveRun(
  slot: Pick<WorkerSlotState, 'transport' | 'mode' | 'remoteStatus'>,
  session?: Pick<ACPSessionRecord, 'sessionId' | 'sessionState' | 'pid' | 'pendingInput' | 'currentRun'> | null,
): boolean {
  const runStatus = getPersistedRunStatus(slot, session);
  return isPersistedSessionAlive(slot, session) && !isTerminalRunStatus(runStatus);
}
