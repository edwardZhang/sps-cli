/**
 * @module        state.test
 * @description   运行时状态读写的单元测试
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-29
 * @updated       2026-04-03
 *
 * @role          test
 * @layer         core
 * @boundedContext runtime
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createIdleWorkerSlot,
  type RuntimeState,
  readState,
  type WorkerSlotState,
  writeState,
} from './state.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sps-state-test-'));
}

function makeState(overrides?: Partial<RuntimeState>): RuntimeState {
  return {
    version: 1,
    generation: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedBy: 'test',
    workers: { 'worker-1': createIdleWorkerSlot() },
    activeCards: {},
    leases: {},
    worktreeEvidence: {},
    worktreeCleanup: [],
    sessions: {},
    integrationQueues: {},
    pendingPMActions: [],
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('createIdleWorkerSlot', () => {
  it('returns a slot with idle status and null fields', () => {
    const slot = createIdleWorkerSlot();
    expect(slot.status).toBe('idle');
    expect(slot.seq).toBeNull();
    expect(slot.branch).toBeNull();
    expect(slot.worktree).toBeNull();
    expect(slot.pid).toBeNull();
    expect(slot.exitCode).toBeNull();
    expect(slot.mergeRetries).toBe(0);
    expect(slot.mode).toBeNull();
    expect(slot.transport).toBeNull();
    expect(slot.agent).toBeNull();
  });

  it('creates independent instances (no shared reference)', () => {
    const a = createIdleWorkerSlot();
    const b = createIdleWorkerSlot();
    a.status = 'active';
    expect(b.status).toBe('idle');
  });
});

describe('readState', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns default state when file does not exist', () => {
    const stateFile = join(tempDir, 'nonexistent.json');
    const state = readState(stateFile, 2);

    expect(state.version).toBe(1);
    expect(state.generation).toBe(0);
    expect(Object.keys(state.workers)).toHaveLength(2);
    expect(state.workers['worker-1'].status).toBe('idle');
    expect(state.workers['worker-2'].status).toBe('idle');
    expect(state.activeCards).toEqual({});
    expect(state.leases).toEqual({});
  });

  it('creates N worker slots based on maxWorkers', () => {
    const stateFile = join(tempDir, 'nonexistent.json');
    const state = readState(stateFile, 5);
    expect(Object.keys(state.workers)).toHaveLength(5);
    for (let i = 1; i <= 5; i++) {
      expect(state.workers[`worker-${i}`]).toBeDefined();
    }
  });

  it('reads and reconciles an existing state file', () => {
    const stateFile = join(tempDir, 'state.json');
    const existing: RuntimeState = makeState({
      generation: 42,
      workers: {
        'worker-1': { ...createIdleWorkerSlot(), status: 'active', seq: 3 },
      },
    });
    writeFileSync(stateFile, JSON.stringify(existing));

    const state = readState(stateFile, 2);
    expect(state.generation).toBe(42);
    expect(state.workers['worker-1'].status).toBe('active');
    expect(state.workers['worker-1'].seq).toBe(3);
    // Worker-2 should be added by reconciliation
    expect(state.workers['worker-2'].status).toBe('idle');
  });

  it('returns default state on invalid JSON', () => {
    const stateFile = join(tempDir, 'state.json');
    writeFileSync(stateFile, 'NOT JSON');

    const state = readState(stateFile, 1);
    expect(state.version).toBe(1);
    expect(state.generation).toBe(0);
  });

  it('grows worker slots when maxWorkers increases', () => {
    const stateFile = join(tempDir, 'state.json');
    const existing = makeState({
      workers: {
        'worker-1': { ...createIdleWorkerSlot(), status: 'active', seq: 1 },
      },
    });
    writeFileSync(stateFile, JSON.stringify(existing));

    // Read with higher maxWorkers
    const state = readState(stateFile, 4);
    expect(Object.keys(state.workers)).toHaveLength(4);
    expect(state.workers['worker-1'].status).toBe('active');
    expect(state.workers['worker-2'].status).toBe('idle');
    expect(state.workers['worker-3'].status).toBe('idle');
    expect(state.workers['worker-4'].status).toBe('idle');
  });

  it('fills in missing fields on legacy worker slots', () => {
    const stateFile = join(tempDir, 'state.json');
    // Simulate a legacy state file without new fields
    const legacy = {
      version: 1,
      generation: 5,
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedBy: 'old',
      workers: {
        'worker-1': {
          status: 'active',
          seq: 2,
          branch: 'feat-1',
          worktree: '/tmp/wt',
          claimedAt: '2026-01-01T00:00:00.000Z',
          lastHeartbeat: null,
          // No mode, transport, agent, pid, etc.
        },
      },
      activeCards: {},
    };
    writeFileSync(stateFile, JSON.stringify(legacy));

    const state = readState(stateFile, 1);
    const w = state.workers['worker-1'];
    expect(w.status).toBe('active');
    expect(w.seq).toBe(2);
    // New fields should have defaults from createIdleWorkerSlot
    expect(w.mode).toBeNull();
    expect(w.transport).toBeNull();
    expect(w.pid).toBeNull();
    expect(w.mergeRetries).toBe(0);
  });

  it('reconciles activeCards with missing retryCount', () => {
    const stateFile = join(tempDir, 'state.json');
    const existing = makeState({
      activeCards: {
        '1': {
          seq: 1,
          state: 'Inprogress',
          worker: 'worker-1',
          mrUrl: null,
          conflictDomains: [],
          startedAt: '2026-01-01T00:00:00.000Z',
          // no retryCount
        } as any,
      },
    });
    writeFileSync(stateFile, JSON.stringify(existing));

    const state = readState(stateFile, 1);
    expect(state.activeCards['1'].retryCount).toBe(0);
  });

  it('reconciles leases with missing retryCount', () => {
    const stateFile = join(tempDir, 'state.json');
    const existing = makeState({
      leases: {
        '5': {
          seq: 5,
          pmStateObserved: 'Inprogress',
          phase: 'coding',
          slot: 'worker-1',
          branch: 'feat-5',
          worktree: '/tmp/wt',
          sessionId: null,
          runId: null,
          claimedAt: '2026-01-01T00:00:00.000Z',
          lastTransitionAt: '2026-01-01T00:00:00.000Z',
          // no retryCount
        } as any,
      },
    });
    writeFileSync(stateFile, JSON.stringify(existing));

    const state = readState(stateFile, 1);
    expect(state.leases['5'].retryCount).toBe(0);
  });
});

describe('writeState', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes state atomically (temp + rename)', () => {
    const stateFile = join(tempDir, 'state.json');
    const state = makeState();

    writeState(stateFile, state, 'test-writer');

    expect(existsSync(stateFile)).toBe(true);
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(raw.updatedBy).toBe('test-writer');
    expect(raw.generation).toBe(1);
  });

  it('increments generation on each write', () => {
    const stateFile = join(tempDir, 'state.json');
    const state = makeState({ generation: 10 });

    writeState(stateFile, state, 'w1');
    expect(state.generation).toBe(11);

    writeState(stateFile, state, 'w2');
    expect(state.generation).toBe(12);

    const raw = JSON.parse(readFileSync(stateFile, 'utf-8'));
    expect(raw.generation).toBe(12);
  });

  it('updates the updatedAt timestamp', () => {
    const stateFile = join(tempDir, 'state.json');
    const state = makeState({ updatedAt: '2020-01-01T00:00:00.000Z' });

    writeState(stateFile, state, 'ts-test');

    expect(state.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    const parsed = new Date(state.updatedAt);
    expect(parsed.getFullYear()).toBeGreaterThanOrEqual(2026);
  });

  it('creates parent directories if missing', () => {
    const stateFile = join(tempDir, 'deep', 'nested', 'state.json');
    const state = makeState();

    writeState(stateFile, state, 'mkdir-test');

    expect(existsSync(stateFile)).toBe(true);
  });

  it('produces valid JSON that can be read back', () => {
    const stateFile = join(tempDir, 'state.json');
    const state = makeState({
      workers: {
        'worker-1': {
          ...createIdleWorkerSlot(),
          status: 'active',
          seq: 7,
          branch: 'feat-7',
          pid: 12345,
        },
      },
      activeCards: {
        '7': {
          seq: 7,
          state: 'Inprogress',
          worker: 'worker-1',
          mrUrl: null,
          conflictDomains: ['auth'],
          startedAt: '2026-01-01T00:00:00.000Z',
          retryCount: 1,
        },
      },
    });

    writeState(stateFile, state, 'roundtrip');
    const readBack = readState(stateFile, 1);

    expect(readBack.workers['worker-1'].status).toBe('active');
    expect(readBack.workers['worker-1'].seq).toBe(7);
    expect(readBack.workers['worker-1'].pid).toBe(12345);
    expect(readBack.activeCards['7'].conflictDomains).toEqual(['auth']);
    expect(readBack.activeCards['7'].retryCount).toBe(1);
  });

  it('does not leave temp files on success', () => {
    const stateFile = join(tempDir, 'state.json');
    const state = makeState();
    writeState(stateFile, state, 'clean');

    const { readdirSync } = require('node:fs');
    const files = readdirSync(tempDir) as string[];
    const tmpFiles = files.filter((f: string) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe('state roundtrip with reconciliation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = makeTempDir();
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('write then read preserves all data', () => {
    const stateFile = join(tempDir, 'state.json');
    const state = makeState({
      sessions: { 'sess-1': { sessionId: 'abc', slotName: 'worker-1' } as any },
      pendingPMActions: [
        {
          type: 'move',
          taskId: '5',
          project: 'test',
          target: 'Done',
          createdAt: '2026-01-01T00:00:00.000Z',
          retryCount: 0,
        },
      ],
    });

    writeState(stateFile, state, 'roundtrip');
    const read = readState(stateFile, 1);

    expect(read.sessions['sess-1']).toBeDefined();
    expect(read.pendingPMActions).toHaveLength(1);
    expect(read.pendingPMActions[0].type).toBe('move');
    expect(read.pendingPMActions[0].taskId).toBe('5');
  });

  it('handles missing top-level fields gracefully', () => {
    const stateFile = join(tempDir, 'state.json');
    // Minimal state file — missing many fields
    writeFileSync(stateFile, JSON.stringify({
      workers: {
        'worker-1': { status: 'idle', seq: null },
      },
    }));

    const state = readState(stateFile, 2);
    expect(state.version).toBe(1);
    expect(state.generation).toBe(0);
    expect(state.worktreeCleanup).toEqual([]);
    expect(state.sessions).toEqual({});
    expect(state.integrationQueues).toEqual({});
    expect(state.pendingPMActions).toEqual([]);
    expect(Object.keys(state.workers)).toHaveLength(2);
  });
});
