/**
 * @module        tick-heartbeat.test
 * @description   tick 心跳格式单元测试（v0.41.2）
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectContext } from '../core/context.js';
import { createIdleWorkerSlot, type RuntimeState, writeState } from '../core/state.js';
import { buildHeartbeat } from './tick.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sps-heartbeat-test-'));
}

function makeRunner(tempDir: string, state: RuntimeState): any {
  const stateFile = join(tempDir, 'state.json');
  writeState(stateFile, state, 'test');
  return {
    ctx: {
      projectName: 'test',
      maxWorkers: 2,
      paths: { stateFile },
    } as unknown as ProjectContext,
  };
}

function emptyState(maxWorkers = 2): RuntimeState {
  const workers: Record<string, ReturnType<typeof createIdleWorkerSlot>> = {};
  for (let i = 1; i <= maxWorkers; i++) workers[`worker-${i}`] = createIdleWorkerSlot();
  return {
    version: 1, generation: 0,
    updatedAt: new Date().toISOString(), updatedBy: 'test',
    workers, activeCards: {}, leases: {},
    worktreeEvidence: {}, worktreeCleanup: [],
    sessions: {}, integrationQueues: {}, pendingPMActions: [],
  };
}

describe('buildHeartbeat', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('reports idle when all workers are idle', () => {
    const runner = makeRunner(tempDir, emptyState(2));
    const hb = buildHeartbeat(runner);
    expect(hb).toMatch(/heartbeat: idle/);
    expect(hb).toMatch(/2\/2 slots free/);
  });

  it('reports active workers with seq + running duration', () => {
    const state = emptyState(2);
    state.workers['worker-1'].status = 'active';
    state.workers['worker-1'].seq = 42;
    state.workers['worker-1'].claimedAt = new Date(Date.now() - 60_000).toISOString(); // 60s ago
    state.leases['42'] = {
      seq: '42', slot: 'worker-1', phase: 'coding',
      claimedAt: new Date(Date.now() - 60_000).toISOString(),
      sessionId: null, runId: null, worktree: null, branch: null,
      targetBranch: 'main', pmStateObserved: 'Inprogress',
      retryCount: 0, lastTransitionAt: new Date().toISOString(),
    } as any;

    const runner = makeRunner(tempDir, state);
    const hb = buildHeartbeat(runner);
    expect(hb).toMatch(/heartbeat: 1\/2 active/);
    expect(hb).toMatch(/worker-1.*seq:42/);
    expect(hb).toMatch(/running 6[0-1]s/);  // allow ±1s jitter
  });

  it('reports last event timestamp when lastHeartbeat is set', () => {
    const state = emptyState(1);
    state.workers['worker-1'].status = 'active';
    state.workers['worker-1'].seq = 7;
    state.workers['worker-1'].claimedAt = new Date().toISOString();
    state.workers['worker-1'].lastHeartbeat = new Date(Date.now() - 5_000).toISOString();

    const runner = makeRunner(tempDir, state);
    const hb = buildHeartbeat(runner);
    expect(hb).toMatch(/last event [4-6]s ago/);
  });

  it('gracefully reports idle when state file is empty/default (unreadable path falls back to default state)', () => {
    // readState creates default state on missing file rather than throwing,
    // so the fallback is a normal idle message, not the "unreadable" branch.
    const runner: any = {
      ctx: {
        projectName: 'test',
        maxWorkers: 1,
        paths: { stateFile: '/nonexistent-dir/state.json' },
      },
    };
    const hb = buildHeartbeat(runner);
    expect(hb).toMatch(/heartbeat: idle/);
  });
});
