import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

export interface WorkerSlotState {
  status: 'idle' | 'active' | 'releasing';
  seq: number | null;
  branch: string | null;
  worktree: string | null;
  tmuxSession: string | null;
  claimedAt: string | null;
  lastHeartbeat: string | null;
  /** Worker execution mode — null for legacy state files */
  mode?: 'print' | 'interactive' | null;
  /** Claude/Codex session ID for resume chains (print mode) */
  sessionId?: string | null;
  /** OS process ID of the worker (print mode) */
  pid?: number | null;
  /** Path to the JSONL output file (print mode) */
  outputFile?: string | null;
  /** Process exit code — null while running (print mode) */
  exitCode?: number | null;
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

function defaultState(maxWorkers: number): RuntimeState {
  const workers: Record<string, WorkerSlotState> = {};
  for (let i = 1; i <= maxWorkers; i++) {
    workers[`worker-${i}`] = {
      status: 'idle',
      seq: null,
      branch: null,
      worktree: null,
      tmuxSession: null,
      claimedAt: null,
      lastHeartbeat: null,
      mode: null,
      sessionId: null,
      pid: null,
      outputFile: null,
      exitCode: null,
    };
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

export function readState(stateFile: string, maxWorkers: number): RuntimeState {
  if (!existsSync(stateFile)) {
    return defaultState(maxWorkers);
  }
  try {
    const raw = readFileSync(stateFile, 'utf-8');
    return JSON.parse(raw) as RuntimeState;
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
