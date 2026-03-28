/**
 * IntegrationQueue — serialises integration workers per project+targetBranch.
 *
 * Same project + same target branch can only have ONE active integration worker
 * at a time.  Additional requests are FIFO-queued and auto-dequeued when the
 * active worker completes or fails.
 *
 * State is persisted to state.json under the `integrationQueues` field.
 */

import { readState, writeState } from '../core/state.js';
import type { RuntimeState } from '../core/state.js';

// ─── Types ──────────────────────────────────────────────────────

export interface QueueEntry {
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

export interface QueueState {
  active: QueueEntry | null;
  waiting: QueueEntry[];
}

/** Key format: `${project}:${targetBranch}` */
export type IntegrationQueues = Record<string, QueueState>;

// ─── Helpers ────────────────────────────────────────────────────

function queueKey(project: string, targetBranch: string): string {
  return `${project}:${targetBranch}`;
}

function emptyQueue(): QueueState {
  return { active: null, waiting: [] };
}

// ─── Class ──────────────────────────────────────────────────────

export class IntegrationQueue {
  private readonly stateFile: string;
  private readonly maxWorkers: number;

  constructor(stateFile: string, maxWorkers: number) {
    this.stateFile = stateFile;
    this.maxWorkers = maxWorkers;
  }

  /**
   * Enqueue an integration task.
   * If no active worker exists for the queue key, the entry becomes active
   * immediately (queued=false).  Otherwise it is appended to waiting.
   */
  enqueue(entry: QueueEntry): { queued: boolean; position: number } {
    const state = this.rd();
    const key = queueKey(entry.project, entry.targetBranch);
    const q = state.integrationQueues[key] ?? emptyQueue();

    if (!q.active) {
      q.active = entry;
      state.integrationQueues[key] = q;
      this.wr(state, 'iq-enqueue-active');
      return { queued: false, position: 0 };
    }

    q.waiting.push(entry);
    state.integrationQueues[key] = q;
    this.wr(state, 'iq-enqueue-wait');
    return { queued: true, position: q.waiting.length };
  }

  /**
   * Pop the next waiting entry and promote it to active.
   * Returns null if the waiting list is empty.
   */
  dequeueNext(project: string, targetBranch: string): QueueEntry | null {
    const state = this.rd();
    const key = queueKey(project, targetBranch);
    const q = state.integrationQueues[key];
    if (!q) return null;

    const next = q.waiting.shift() ?? null;
    q.active = next;

    if (!next && q.waiting.length === 0) {
      delete state.integrationQueues[key];
    }

    this.wr(state, 'iq-dequeue');
    return next;
  }

  /**
   * Remove a task from the waiting list (not from active).
   * Returns true if the task was found and removed.
   */
  remove(taskId: string): boolean {
    const state = this.rd();
    for (const q of Object.values(state.integrationQueues)) {
      const idx = q.waiting.findIndex((e) => e.taskId === taskId);
      if (idx !== -1) {
        q.waiting.splice(idx, 1);
        this.wr(state, 'iq-remove');
        return true;
      }
    }
    return false;
  }

  /** Get the currently active entry for a project+targetBranch. */
  getActive(project: string, targetBranch: string): QueueEntry | null {
    const state = this.rd();
    const key = queueKey(project, targetBranch);
    return state.integrationQueues[key]?.active ?? null;
  }

  /**
   * Get the position of a task in any queue.
   * Returns -1 if not found, 0 if active, 1+ if waiting.
   */
  getPosition(taskId: string): number {
    const state = this.rd();
    for (const q of Object.values(state.integrationQueues)) {
      if (q.active?.taskId === taskId) return 0;
      const idx = q.waiting.findIndex((e) => e.taskId === taskId);
      if (idx !== -1) return idx + 1;
    }
    return -1;
  }

  /** List queue states, optionally filtered by project. */
  list(project?: string): QueueState[] {
    const state = this.rd();
    const result: QueueState[] = [];
    for (const [key, q] of Object.entries(state.integrationQueues)) {
      if (project && !key.startsWith(`${project}:`)) continue;
      result.push(q);
    }
    return result;
  }

  // ─── Private ────────────────────────────────────────────────

  private rd(): RuntimeState {
    return readState(this.stateFile, this.maxWorkers);
  }

  private wr(state: RuntimeState, by: string): void {
    writeState(this.stateFile, state, by);
  }

  private log(msg: string): void {
    process.stderr.write(`[integration-queue] ${msg}\n`);
  }
}
