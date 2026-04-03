import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { IntegrationQueue, type QueueEntry } from './integration-queue.js';
import { writeState, createIdleWorkerSlot, type RuntimeState } from '../core/state.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sps-iq-test-'));
}

function initState(stateFile: string, maxWorkers = 1): void {
  const workers: Record<string, ReturnType<typeof createIdleWorkerSlot>> = {};
  for (let i = 1; i <= maxWorkers; i++) {
    workers[`worker-${i}`] = createIdleWorkerSlot();
  }
  const state: RuntimeState = {
    version: 1, generation: 0,
    updatedAt: new Date().toISOString(), updatedBy: 'test',
    workers, activeCards: {}, leases: {},
    worktreeEvidence: {}, worktreeCleanup: [],
    sessions: {}, integrationQueues: {}, pendingPMActions: [],
  };
  writeState(stateFile, state, 'test-init');
}

function makeEntry(taskId: string, project = 'myapp', targetBranch = 'main'): QueueEntry {
  return {
    taskId, cardId: taskId, project,
    prompt: `integrate task ${taskId}`,
    cwd: `/tmp/wt-${taskId}`,
    branch: `feat-${taskId}`,
    targetBranch,
    tool: 'claude', transport: 'acp-sdk',
    outputFile: `/tmp/out-${taskId}.jsonl`,
    enqueuedAt: new Date().toISOString(),
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('IntegrationQueue', () => {
  let tempDir: string;
  let stateFile: string;
  let iq: IntegrationQueue;

  beforeEach(() => {
    tempDir = makeTempDir();
    stateFile = join(tempDir, 'state.json');
    initState(stateFile);
    iq = new IntegrationQueue(stateFile, 1);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('enqueue', () => {
    it('first entry becomes active immediately', () => {
      const result = iq.enqueue(makeEntry('1'));
      expect(result.queued).toBe(false);
      expect(result.position).toBe(0);
    });

    it('second entry is queued as waiting', () => {
      iq.enqueue(makeEntry('1'));
      const result = iq.enqueue(makeEntry('2'));
      expect(result.queued).toBe(true);
      expect(result.position).toBe(1);
    });

    it('third entry gets position 2', () => {
      iq.enqueue(makeEntry('1'));
      iq.enqueue(makeEntry('2'));
      const result = iq.enqueue(makeEntry('3'));
      expect(result.queued).toBe(true);
      expect(result.position).toBe(2);
    });

    it('different targetBranches have independent queues', () => {
      iq.enqueue(makeEntry('1', 'myapp', 'main'));
      const r2 = iq.enqueue(makeEntry('2', 'myapp', 'develop'));
      // Different queue key — becomes active, not queued
      expect(r2.queued).toBe(false);
      expect(r2.position).toBe(0);
    });

    it('different projects have independent queues', () => {
      iq.enqueue(makeEntry('1', 'proj-a', 'main'));
      const r2 = iq.enqueue(makeEntry('2', 'proj-b', 'main'));
      expect(r2.queued).toBe(false);
    });
  });

  describe('getActive', () => {
    it('returns null when queue is empty', () => {
      expect(iq.getActive('myapp', 'main')).toBeNull();
    });

    it('returns the active entry', () => {
      iq.enqueue(makeEntry('1'));
      const active = iq.getActive('myapp', 'main');
      expect(active).not.toBeNull();
      expect(active!.taskId).toBe('1');
    });

    it('returns null for wrong project', () => {
      iq.enqueue(makeEntry('1', 'myapp'));
      expect(iq.getActive('other', 'main')).toBeNull();
    });
  });

  describe('getPosition', () => {
    it('returns -1 for unknown task', () => {
      expect(iq.getPosition('999')).toBe(-1);
    });

    it('returns 0 for active task', () => {
      iq.enqueue(makeEntry('1'));
      expect(iq.getPosition('1')).toBe(0);
    });

    it('returns 1-based position for waiting tasks', () => {
      iq.enqueue(makeEntry('1'));
      iq.enqueue(makeEntry('2'));
      iq.enqueue(makeEntry('3'));
      expect(iq.getPosition('2')).toBe(1);
      expect(iq.getPosition('3')).toBe(2);
    });
  });

  describe('dequeueNext', () => {
    it('returns null when queue is empty', () => {
      expect(iq.dequeueNext('myapp', 'main')).toBeNull();
    });

    it('promotes waiting entry to active', () => {
      iq.enqueue(makeEntry('1'));
      iq.enqueue(makeEntry('2'));
      iq.enqueue(makeEntry('3'));

      const next = iq.dequeueNext('myapp', 'main');
      expect(next).not.toBeNull();
      expect(next!.taskId).toBe('2');

      // Now 2 should be active
      const active = iq.getActive('myapp', 'main');
      expect(active!.taskId).toBe('2');
    });

    it('returns null after all waiting entries are consumed', () => {
      iq.enqueue(makeEntry('1'));
      iq.enqueue(makeEntry('2'));

      const next1 = iq.dequeueNext('myapp', 'main');
      expect(next1!.taskId).toBe('2');

      const next2 = iq.dequeueNext('myapp', 'main');
      expect(next2).toBeNull();
    });

    it('cleans up queue key when fully drained', () => {
      iq.enqueue(makeEntry('1'));
      iq.dequeueNext('myapp', 'main'); // Drains active, no waiting
      // Queue should be gone — getActive returns null
      expect(iq.getActive('myapp', 'main')).toBeNull();
    });
  });

  describe('remove', () => {
    it('removes a waiting task', () => {
      iq.enqueue(makeEntry('1'));
      iq.enqueue(makeEntry('2'));
      iq.enqueue(makeEntry('3'));

      const removed = iq.remove('2');
      expect(removed).toBe(true);
      expect(iq.getPosition('2')).toBe(-1);
      // Task 3 should now be position 1
      expect(iq.getPosition('3')).toBe(1);
    });

    it('returns false for unknown task', () => {
      expect(iq.remove('999')).toBe(false);
    });

    it('does not remove active task', () => {
      iq.enqueue(makeEntry('1'));
      // remove() only targets waiting list
      const removed = iq.remove('1');
      expect(removed).toBe(false);
      expect(iq.getActive('myapp', 'main')!.taskId).toBe('1');
    });
  });

  describe('list', () => {
    it('returns empty when no queues', () => {
      expect(iq.list()).toEqual([]);
    });

    it('returns all queues', () => {
      iq.enqueue(makeEntry('1', 'proj-a', 'main'));
      iq.enqueue(makeEntry('2', 'proj-b', 'main'));
      expect(iq.list()).toHaveLength(2);
    });

    it('filters by project', () => {
      iq.enqueue(makeEntry('1', 'proj-a', 'main'));
      iq.enqueue(makeEntry('2', 'proj-b', 'main'));
      expect(iq.list('proj-a')).toHaveLength(1);
      expect(iq.list('proj-c')).toHaveLength(0);
    });
  });

  describe('persistence', () => {
    it('survives queue reconstruction', () => {
      iq.enqueue(makeEntry('1'));
      iq.enqueue(makeEntry('2'));
      iq.enqueue(makeEntry('3'));

      // Create a new IntegrationQueue instance pointing to the same state file
      const iq2 = new IntegrationQueue(stateFile, 1);
      expect(iq2.getActive('myapp', 'main')!.taskId).toBe('1');
      expect(iq2.getPosition('2')).toBe(1);
      expect(iq2.getPosition('3')).toBe(2);
    });
  });
});
