/**
 * @module        MonitorEngine.test
 * @description   MonitorEngine ACP shim 健康检查的单元测试
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-04-17
 * @updated       2026-04-17
 *
 * @role          test
 * @layer         engine
 * @boundedContext pipeline-health
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectContext } from '../core/context.js';
import type { ProjectPipelineAdapter } from '../core/projectPipelineAdapter.js';
import { createIdleWorkerSlot, type RuntimeState, writeState } from '../core/state.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { ProcessSupervisor } from '../manager/supervisor.js';
import type { WorkerManager } from '../manager/worker-manager.js';
import { MonitorEngine } from './MonitorEngine.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sps-monitor-test-'));
}

function makeCtx(tempDir: string, overrides: Record<string, unknown> = {}): ProjectContext {
  return {
    projectName: 'test',
    maxWorkers: 1,
    paths: { stateFile: join(tempDir, 'state.json'), logsDir: tempDir },
    config: {
      WORKER_LAUNCH_TIMEOUT_S: 300,
      WORKER_IDLE_TIMEOUT_M: 10,
      WORKER_RESTART_LIMIT: 3,
      WORKER_ACK_TIMEOUT_S: 60,
      WORKER_ACK_MAX_RETRIES: 1,
      INPROGRESS_TIMEOUT_HOURS: 8,
      ...overrides,
    },
  } as unknown as ProjectContext;
}

function buildState(overrides: {
  workers?: RuntimeState['workers'];
  sessions?: RuntimeState['sessions'];
  leases?: RuntimeState['leases'];
}): RuntimeState {
  return {
    version: 1,
    generation: 0,
    updatedAt: new Date().toISOString(),
    updatedBy: 'test',
    workers: overrides.workers ?? {},
    activeCards: {},
    leases: overrides.leases ?? {},
    worktreeEvidence: {},
    worktreeCleanup: [],
    sessions: overrides.sessions ?? {},
    integrationQueues: {},
    pendingPMActions: [],
  };
}

function makeSession(pid: number, slot = 'worker-1') {
  return {
    slot, tool: 'claude' as const, sessionId: `sess-${pid}`,
    sessionName: `sps-acp-test-${slot}`, pid, cwd: '/tmp',
    status: 'active' as const, sessionState: 'busy' as const,
    currentRun: {
      runId: 'run-1', status: 'running' as const, promptPreview: 'x',
      startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      completedAt: null,
    },
    pendingInput: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    lastSeenAt: null, lastPaneText: '',
  };
}

function makeWorkerManager(): WorkerManager {
  return {
    run: vi.fn().mockResolvedValue({ accepted: true, slot: 'worker-1', workerId: 'w', pid: 1 }),
    resume: vi.fn().mockResolvedValue({ accepted: true, slot: 'worker-1', workerId: 'w', pid: 1 }),
    cancel: vi.fn().mockResolvedValue(undefined),
    sendInput: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockReturnValue([]),
    onEvent: vi.fn(),
    recover: vi.fn().mockResolvedValue({ scanned: 0, alive: 0, completed: 0, failed: 0, released: 0, queueRebuilt: 0 }),
    cleanup: vi.fn(),
  } as unknown as WorkerManager;
}

function makeEngine(tempDir: string): MonitorEngine {
  const ctx = makeCtx(tempDir);
  const taskBackend = { move: vi.fn().mockResolvedValue(undefined), addLabel: vi.fn(), removeLabel: vi.fn(), comment: vi.fn() } as unknown as TaskBackend;
  const repoBackend = { getMrStatus: vi.fn().mockResolvedValue({ exists: false, state: 'unknown' }) } as unknown as RepoBackend;
  const notifier = {
    send: vi.fn().mockResolvedValue(undefined),
    sendSuccess: vi.fn().mockResolvedValue(undefined),
    sendWarning: vi.fn().mockResolvedValue(undefined),
    sendError: vi.fn().mockResolvedValue(undefined),
    sendDigest: vi.fn().mockResolvedValue(undefined),
  } as unknown as Notifier;
  const supervisor = { kill: vi.fn().mockResolvedValue(undefined), get: vi.fn(), remove: vi.fn() } as unknown as ProcessSupervisor;
  const pipelineAdapter = {
    states: { ready: 'Todo', planning: 'Planning', backlog: 'Backlog', done: 'Done', review: 'QA' },
    stages: [], activeStates: [],
  } as unknown as ProjectPipelineAdapter;

  return new MonitorEngine(ctx, taskBackend, repoBackend, notifier, supervisor, pipelineAdapter, makeWorkerManager());
}

describe('MonitorEngine.checkAcpShimHealth', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('detects dead shim pid for active worker slot and marks session offline', async () => {
    const DEAD_PID = 9_999_999;
    const activeWorker = createIdleWorkerSlot();
    activeWorker.status = 'active';
    activeWorker.seq = 42;

    writeState(join(tempDir, 'state.json'), buildState({
      workers: { 'worker-1': activeWorker },
      sessions: { 'worker-1': makeSession(DEAD_PID) },
      leases: {
        '42': {
          seq: '42', slot: 'worker-1', phase: 'coding',
          sessionId: 'sess-1', runId: null, worktree: null, branch: null,
          targetBranch: 'main', pmStateObserved: 'Inprogress',
          retryCount: 0, lastTransitionAt: new Date().toISOString(),
        } as any,
      },
    }), 'test-setup');

    const engine = makeEngine(tempDir);
    const result = await engine.tick();

    const check = (result.details as any).checks.find((c: any) => c.name === 'acp-shim-health');
    expect(check).toBeDefined();
    expect(check.status).toBe('warn');
    expect(check.message).toMatch(/1 dead ACP shim/);

    // session should be marked offline
    const { readState } = await import('../core/state.js');
    const finalState = readState(join(tempDir, 'state.json'), 1);
    const session = finalState.sessions['worker-1'];
    expect(session?.sessionState).toBe('offline');
    expect(session?.currentRun).toBeNull();
  });

  it('leaves alive shim alone', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    const ALIVE_PID = child.pid!;
    try {
      const activeWorker = createIdleWorkerSlot();
      activeWorker.status = 'active';
      activeWorker.seq = 42;

      writeState(join(tempDir, 'state.json'), buildState({
        workers: { 'worker-1': activeWorker },
        sessions: { 'worker-1': makeSession(ALIVE_PID) },
      }), 'test-setup');

      const engine = makeEngine(tempDir);
      const result = await engine.tick();

      const check = (result.details as any).checks.find((c: any) => c.name === 'acp-shim-health');
      expect(check?.status).toBe('pass');

      // session stays active
      const { readState } = await import('../core/state.js');
      const finalState = readState(join(tempDir, 'state.json'), 1);
      expect(finalState.sessions['worker-1']?.sessionState).toBe('busy');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('ignores idle slot sessions (session-reuse design)', async () => {
    // An idle slot with leftover session record is normal (session reuse).
    // Even if pid is dead, we don't care until the slot is active again.
    const DEAD_PID = 9_999_999;
    const idleWorker = createIdleWorkerSlot(); // status='idle' by default

    writeState(join(tempDir, 'state.json'), buildState({
      workers: { 'worker-1': idleWorker },
      sessions: { 'worker-1': makeSession(DEAD_PID) },
    }), 'test-setup');

    const engine = makeEngine(tempDir);
    const result = await engine.tick();

    const check = (result.details as any).checks.find((c: any) => c.name === 'acp-shim-health');
    expect(check?.status).toBe('pass');
  });

  it('ignores harness session-* slots', async () => {
    const DEAD_PID = 9_999_999;
    const harnessSession = { ...makeSession(DEAD_PID, 'session-my-chat'), slot: 'session-my-chat' };

    writeState(join(tempDir, 'state.json'), buildState({
      sessions: { 'session-my-chat': harnessSession },
    }), 'test-setup');

    const engine = makeEngine(tempDir);
    const result = await engine.tick();

    const check = (result.details as any).checks.find((c: any) => c.name === 'acp-shim-health');
    expect(check?.status).toBe('pass');
  });
});

describe('MonitorEngine.checkAckTimeout', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  function makeAckEngine(
    cards: Array<{ seq: string; labels: string[] }>,
    configOverrides: Record<string, unknown> = {},
  ): { engine: MonitorEngine; addLabel: ReturnType<typeof vi.fn> } {
    const ctx = makeCtx(tempDir, configOverrides);
    const addLabel = vi.fn().mockResolvedValue(undefined);
    const taskBackend = {
      move: vi.fn().mockResolvedValue(undefined),
      addLabel,
      removeLabel: vi.fn(),
      comment: vi.fn(),
      listByState: vi.fn().mockImplementation(async (state: string) => {
        if (state === 'Inprogress') return cards;
        return [];
      }),
    } as unknown as TaskBackend;
    const repoBackend = { getMrStatus: vi.fn().mockResolvedValue({ exists: false, state: 'unknown' }) } as unknown as RepoBackend;
    const notifier = {
      send: vi.fn().mockResolvedValue(undefined),
      sendSuccess: vi.fn().mockResolvedValue(undefined),
      sendWarning: vi.fn().mockResolvedValue(undefined),
      sendError: vi.fn().mockResolvedValue(undefined),
      sendDigest: vi.fn().mockResolvedValue(undefined),
    } as unknown as Notifier;
    const supervisor = { kill: vi.fn().mockResolvedValue(undefined), get: vi.fn(), remove: vi.fn() } as unknown as ProcessSupervisor;
    const pipelineAdapter = {
      states: { ready: 'Todo', planning: 'Planning', backlog: 'Backlog', done: 'Done', review: 'QA' },
      stages: [
        { name: 'develop', triggerState: 'Todo', activeState: 'Inprogress', onCompleteState: 'Done' },
      ],
      activeStates: ['Planning', 'Backlog', 'Todo', 'Inprogress'],
    } as unknown as ProjectPipelineAdapter;

    return { engine: new MonitorEngine(ctx, taskBackend, repoBackend, notifier, supervisor, pipelineAdapter, makeWorkerManager()), addLabel };
  }

  function writeLeaseState(seq: string, claimedAt: string) {
    writeState(join(tempDir, 'state.json'), buildState({
      leases: {
        [seq]: {
          seq, slot: 'worker-1', phase: 'coding', claimedAt,
          sessionId: null, runId: null, worktree: null, branch: null,
          targetBranch: 'main', pmStateObserved: 'Inprogress',
          retryCount: 0, lastTransitionAt: claimedAt,
        } as any,
      },
    }), 'test-setup');
  }

  it('flags ACK-TIMEOUT when card past timeout with no STARTED-<stage> label', async () => {
    const oldTime = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    writeLeaseState('42', oldTime);

    const { engine, addLabel } = makeAckEngine([
      { seq: '42', labels: ['AI-PIPELINE', 'CLAIMED'] },
    ]);

    const result = await engine.tick();
    const check = (result.details as any).checks.find((c: any) => c.name === 'ack-timeout');

    expect(check.status).toBe('warn');
    expect(addLabel).toHaveBeenCalledWith('42', 'ACK-TIMEOUT');
  });

  it('does NOT flag when STARTED-<stage> label is present', async () => {
    const oldTime = new Date(Date.now() - 120_000).toISOString();
    writeLeaseState('42', oldTime);

    const { engine, addLabel } = makeAckEngine([
      { seq: '42', labels: ['AI-PIPELINE', 'CLAIMED', 'STARTED-develop'] },
    ]);

    await engine.tick();
    expect(addLabel).not.toHaveBeenCalledWith('42', 'ACK-TIMEOUT');
  });

  it('does NOT flag when still within ACK timeout window', async () => {
    const recentTime = new Date(Date.now() - 10_000).toISOString(); // 10s ago, well under 60s
    writeLeaseState('42', recentTime);

    const { engine, addLabel } = makeAckEngine([
      { seq: '42', labels: ['AI-PIPELINE', 'CLAIMED'] },
    ]);

    await engine.tick();
    expect(addLabel).not.toHaveBeenCalledWith('42', 'ACK-TIMEOUT');
  });

  it('does NOT double-flag when ACK-TIMEOUT label is already present', async () => {
    const oldTime = new Date(Date.now() - 120_000).toISOString();
    writeLeaseState('42', oldTime);

    const { engine, addLabel } = makeAckEngine([
      { seq: '42', labels: ['AI-PIPELINE', 'CLAIMED', 'ACK-TIMEOUT'] },
    ]);

    await engine.tick();
    expect(addLabel).not.toHaveBeenCalledWith('42', 'ACK-TIMEOUT');
  });

  it('skips cards already in NEEDS-FIX (different failure path)', async () => {
    const oldTime = new Date(Date.now() - 120_000).toISOString();
    writeLeaseState('42', oldTime);

    const { engine, addLabel } = makeAckEngine([
      { seq: '42', labels: ['AI-PIPELINE', 'NEEDS-FIX'] },
    ]);

    await engine.tick();
    expect(addLabel).not.toHaveBeenCalledWith('42', 'ACK-TIMEOUT');
  });
});

describe('MonitorEngine.autoRetry (v0.41.1 bug fixes)', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  function makeRetryEngine(): {
    engine: MonitorEngine;
    workerManager: WorkerManager;
    cancelMock: ReturnType<typeof vi.fn>;
    removeLabelMock: ReturnType<typeof vi.fn>;
  } {
    const ctx = makeCtx(tempDir);
    const removeLabelMock = vi.fn().mockResolvedValue(undefined);
    const taskBackend = {
      move: vi.fn().mockResolvedValue(undefined),
      addLabel: vi.fn().mockResolvedValue(undefined),
      removeLabel: removeLabelMock,
      comment: vi.fn(),
      listByState: vi.fn().mockResolvedValue([]),
    } as unknown as TaskBackend;
    const repoBackend = { getMrStatus: vi.fn().mockResolvedValue({ exists: false, state: 'unknown' }) } as unknown as RepoBackend;
    const notifier = {
      send: vi.fn().mockResolvedValue(undefined),
      sendSuccess: vi.fn().mockResolvedValue(undefined),
      sendWarning: vi.fn().mockResolvedValue(undefined),
      sendError: vi.fn().mockResolvedValue(undefined),
      sendDigest: vi.fn().mockResolvedValue(undefined),
    } as unknown as Notifier;
    const supervisor = { kill: vi.fn().mockResolvedValue(undefined), get: vi.fn(), remove: vi.fn() } as unknown as ProcessSupervisor;
    const pipelineAdapter = {
      states: { ready: 'Todo', planning: 'Planning', backlog: 'Backlog', done: 'Done', review: 'QA' },
      stages: [
        { name: 'develop', triggerState: 'Todo', activeState: 'Inprogress', onCompleteState: 'Done' },
        { name: 'review', triggerState: 'QA', activeState: 'QA', onCompleteState: 'Done' },
      ],
      activeStates: ['Planning', 'Backlog', 'Todo', 'Inprogress', 'QA'],
    } as unknown as ProjectPipelineAdapter;

    const cancelMock = vi.fn().mockResolvedValue(undefined);
    const workerManager = {
      ...makeWorkerManager(),
      cancel: cancelMock,
    } as unknown as WorkerManager;

    return {
      engine: new MonitorEngine(ctx, taskBackend, repoBackend, notifier, supervisor, pipelineAdapter, workerManager),
      workerManager,
      cancelMock,
      removeLabelMock,
    };
  }

  it('calls workerManager.cancel to release taskSlotMap (Bug 2 fix)', async () => {
    const { engine, cancelMock } = makeRetryEngine();
    // Invoke the private method directly via casting — this is the core
    // behavior we want to guarantee; integration via tick() is covered by smoke.
    await (engine as any).autoRetry('42', 'worker-1', [], 'test');

    expect(cancelMock).toHaveBeenCalledWith(expect.objectContaining({
      taskId: '42',
      reason: 'anomaly',
    }));
  });

  it('clears STARTED-<stage> labels for all stages (Bug 1 fix)', async () => {
    const { engine, removeLabelMock } = makeRetryEngine();
    await (engine as any).autoRetry('42', 'worker-1', [], 'test');

    expect(removeLabelMock).toHaveBeenCalledWith('42', 'STARTED-develop');
    expect(removeLabelMock).toHaveBeenCalledWith('42', 'STARTED-review');
  });

  it('clears ACK-TIMEOUT label so next retry is clean', async () => {
    const { engine, removeLabelMock } = makeRetryEngine();
    await (engine as any).autoRetry('42', 'worker-1', [], 'test');

    expect(removeLabelMock).toHaveBeenCalledWith('42', 'ACK-TIMEOUT');
  });

  it('still clears legacy labels (CLAIMED, STALE-RUNTIME)', async () => {
    const { engine, removeLabelMock } = makeRetryEngine();
    await (engine as any).autoRetry('42', 'worker-1', [], 'test');

    expect(removeLabelMock).toHaveBeenCalledWith('42', 'CLAIMED');
    expect(removeLabelMock).toHaveBeenCalledWith('42', 'STALE-RUNTIME');
  });
});
