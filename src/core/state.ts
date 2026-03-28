import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CardState } from '../models/types.js';
import type { ACPSessionRecord } from '../models/acp.js';

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
  sessionState?: 'booting' | 'ready' | 'busy' | 'needs_confirmation' | 'draining' | 'offline' | null;
  /** ACP run lifecycle status */
  remoteStatus?: 'submitted' | 'running' | 'waiting_input' | 'needs_confirmation' | 'stalled_submit' | 'completed' | 'failed' | 'cancelled' | 'lost' | null;
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

export type TaskLeasePhase =
  | 'queued'
  | 'preparing'
  | 'coding'
  | 'merging'
  | 'resolving_conflict'
  | 'waiting_confirmation'
  | 'suspended'
  | 'closing'
  | 'released';

export interface TaskLease {
  seq: number;
  pmStateObserved: CardState | null;
  phase: TaskLeasePhase;
  slot: string | null;
  branch: string | null;
  worktree: string | null;
  sessionId: string | null;
  runId: string | null;
  claimedAt: string | null;
  retryCount: number;
  lastTransitionAt: string;
}

export type WorktreeEvidenceStatus =
  | 'missing'
  | 'clean'
  | 'dirty'
  | 'rebase'
  | 'merge'
  | 'conflict';

export interface WorktreeEvidence {
  seq: number;
  branch: string | null;
  worktree: string | null;
  worktreeExists: boolean;
  branchExists: boolean;
  gitStatus: WorktreeEvidenceStatus;
  pushed: boolean;
  mergedToBase: boolean;
  aheadOfBase: number;
  behindBase: number;
  lastCheckedAt: string;
}

export interface PendingPMAction {
  type: 'move' | 'comment' | 'label' | 'release';
  taskId: string;
  project: string;
  target?: string;
  message?: string;
  createdAt: string;
  retryCount: number;
}

export interface IntegrationQueueEntry {
  taskId: string;
  cardId: string;
  project: string;
  prompt: string;
  cwd: string;
  branch: string;
  targetBranch: string;
  tool: 'claude' | 'codex';
  transport: 'proc' | 'pty';
  outputFile: string;
  enqueuedAt: string;
}

export interface IntegrationQueueState {
  active: IntegrationQueueEntry | null;
  waiting: IntegrationQueueEntry[];
}

export interface RuntimeState {
  version: number;
  generation: number;
  updatedAt: string;
  updatedBy: string;
  workers: Record<string, WorkerSlotState>;
  activeCards: Record<string, ActiveCardState>;
  leases: Record<string, TaskLease>;
  worktreeEvidence: Record<string, WorktreeEvidence>;
  worktreeCleanup: WorktreeCleanupEntry[];
  /** ACP/PTY session records — merged from former acp-state.json */
  sessions: Record<string, ACPSessionRecord>;
  /** Per-project:targetBranch integration serialisation queues */
  integrationQueues: Record<string, IntegrationQueueState>;
  /** PM operations that failed and need retry on next tick cycle */
  pendingPMActions: PendingPMAction[];
}

export function createIdleWorkerSlot(): WorkerSlotState {
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
    workers[`worker-${i}`] = createIdleWorkerSlot();
  }
  return {
    version: 1,
    generation: 0,
    updatedAt: new Date().toISOString(),
    updatedBy: 'init',
    workers,
    activeCards: {},
    leases: {},
    worktreeEvidence: {},
    worktreeCleanup: [],
    sessions: {},
    integrationQueues: {},
    pendingPMActions: [],
  };
}

function reconcileState(raw: RuntimeState, maxWorkers: number): RuntimeState {
  const workers: Record<string, WorkerSlotState> = { ...(raw.workers || {}) };
  const activeCards = Object.fromEntries(
    Object.entries(raw.activeCards || {}).map(([seq, card]) => [
      seq,
      {
        ...card,
        retryCount: card.retryCount ?? 0,
      },
    ]),
  );
  const leases = Object.fromEntries(
    Object.entries(raw.leases || {}).map(([seq, lease]) => [
      seq,
      {
        ...lease,
        retryCount: lease.retryCount ?? 0,
      },
    ]),
  );

  // Grow legacy state files when MAX_CONCURRENT_WORKERS increases.
  // This lets projects scale from 1 -> N workers without deleting state.json.
  for (let i = 1; i <= maxWorkers; i++) {
    const slotName = `worker-${i}`;
    if (!workers[slotName]) {
      workers[slotName] = createIdleWorkerSlot();
      continue;
    }

    workers[slotName] = {
      ...createIdleWorkerSlot(),
      ...workers[slotName],
    };
  }

  return {
    version: raw.version ?? 1,
    generation: raw.generation ?? 0,
    updatedAt: raw.updatedAt || new Date().toISOString(),
    updatedBy: raw.updatedBy || 'migrate',
    workers,
    activeCards,
    leases,
    worktreeEvidence: raw.worktreeEvidence || {},
    worktreeCleanup: raw.worktreeCleanup || [],
    sessions: raw.sessions || {},
    integrationQueues: raw.integrationQueues || {},
    pendingPMActions: raw.pendingPMActions || [],
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

  const tmpFile = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(state, null, 2) + '\n');
  renameSync(tmpFile, stateFile);
}
