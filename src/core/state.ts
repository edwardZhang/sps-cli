import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export interface WorkerSlotState {
  status: 'idle' | 'active' | 'merging' | 'resolving' | 'releasing';
  seq: number | null;
  branch: string | null;
  worktree: string | null;
  tmuxSession: string | null;
  claimedAt: string | null;
  lastHeartbeat: string | null;
  /** Worker execution mode — null for legacy state files */
  mode?: 'print' | 'interactive' | 'acp' | 'pty' | null;
  /** Underlying worker transport */
  transport?: 'proc' | 'acp' | 'pty' | null;
  /** Worker tool currently bound to the slot */
  agent?: 'claude' | 'codex' | null;
  /** Claude/Codex session ID for resume chains (print mode) */
  sessionId?: string | null;
  /** ACP run ID for the active task */
  runId?: string | null;
  /** ACP session lifecycle status */
  sessionState?: 'booting' | 'ready' | 'busy' | 'draining' | 'offline' | null;
  /** ACP run lifecycle status */
  remoteStatus?: 'submitted' | 'running' | 'waiting_input' | 'completed' | 'failed' | 'cancelled' | 'lost' | null;
  /** Last ACP event timestamp observed by SPS */
  lastEventAt?: string | null;
  /** OS process ID of the worker (print mode) */
  pid?: number | null;
  /** Path to the JSONL output file (print mode) */
  outputFile?: string | null;
  /** Process exit code — null while running (print mode) */
  exitCode?: number | null;
  /** Number of L2 merge conflict resolution attempts */
  mergeRetries?: number;
  /** When worker finished coding (ISO string, for merge queue FIFO ordering) */
  completedAt?: string | null;
}

export interface ActiveCardState {
  seq: number;
  state: string;
  worker: string | null;
  mrUrl: string | null;
  conflictDomains: string[];
  startedAt: string;
  /** Number of times this card has been auto-retried */
  retryCount?: number;
}

export interface WorktreeCleanupEntry {
  branch: string;
  worktreePath: string;
  markedAt: string;
}

export interface RuntimeState {
  version: number;
  generation: number;
  updatedAt: string;
  updatedBy: string;
  workers: Record<string, WorkerSlotState>;
  activeCards: Record<string, ActiveCardState>;
  worktreeCleanup: WorktreeCleanupEntry[];
}

function idleWorkerSlot(): WorkerSlotState {
  return {
    status: 'idle',
    seq: null,
    branch: null,
    worktree: null,
    tmuxSession: null,
    claimedAt: null,
    lastHeartbeat: null,
    mode: null,
    transport: null,
    agent: null,
    sessionId: null,
    runId: null,
    sessionState: null,
    remoteStatus: null,
    lastEventAt: null,
    pid: null,
    outputFile: null,
    exitCode: null,
    mergeRetries: 0,
    completedAt: null,
  };
}

function defaultState(maxWorkers: number): RuntimeState {
  const workers: Record<string, WorkerSlotState> = {};
  for (let i = 1; i <= maxWorkers; i++) {
    workers[`worker-${i}`] = idleWorkerSlot();
  }
  return {
    version: 1,
    generation: 0,
    updatedAt: new Date().toISOString(),
    updatedBy: 'init',
    workers,
    activeCards: {},
    worktreeCleanup: [],
  };
}

function reconcileState(raw: RuntimeState, maxWorkers: number): RuntimeState {
  const workers: Record<string, WorkerSlotState> = { ...(raw.workers || {}) };

  // Grow legacy state files when MAX_CONCURRENT_WORKERS increases.
  // This lets projects scale from 1 -> N workers without deleting state.json.
  for (let i = 1; i <= maxWorkers; i++) {
    const slotName = `worker-${i}`;
    if (!workers[slotName]) {
      workers[slotName] = idleWorkerSlot();
      continue;
    }

    workers[slotName] = {
      ...idleWorkerSlot(),
      ...workers[slotName],
    };
  }

  return {
    version: raw.version ?? 1,
    generation: raw.generation ?? 0,
    updatedAt: raw.updatedAt || new Date().toISOString(),
    updatedBy: raw.updatedBy || 'migrate',
    workers,
    activeCards: raw.activeCards || {},
    worktreeCleanup: raw.worktreeCleanup || [],
  };
}

export function readState(stateFile: string, maxWorkers: number): RuntimeState {
  if (!existsSync(stateFile)) {
    return defaultState(maxWorkers);
  }
  try {
    const raw = readFileSync(stateFile, 'utf-8');
    return reconcileState(JSON.parse(raw) as RuntimeState, maxWorkers);
  } catch {
    return defaultState(maxWorkers);
  }
}

/**
 * Atomic write: write to temp file, then rename.
 * Increments generation automatically.
 */
export function writeState(stateFile: string, state: RuntimeState, updatedBy: string): void {
  const dir = dirname(stateFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  state.generation += 1;
  state.updatedAt = new Date().toISOString();
  state.updatedBy = updatedBy;

  const tmpFile = stateFile + '.tmp';
  writeFileSync(tmpFile, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmpFile, stateFile);
}
