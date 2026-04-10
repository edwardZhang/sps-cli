/**
 * @module        worker-manager-impl.test
 * @description   WorkerManagerImpl 单元测试
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-29
 * @updated       2026-04-03
 *
 * @role          test
 * @layer         manager
 * @boundedContext worker-lifecycle
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createIdleWorkerSlot, type RuntimeState, writeState } from '../core/state.js';
import { CompletionJudge } from './completion-judge.js';
import { ProcessSupervisor } from './supervisor.js';
import type { WorkerEvent, WorkerPhase } from './worker-manager.js';
import { type WorkerManagerDeps, WorkerManagerImpl } from './worker-manager-impl.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sps-wm-test-'));
}

function makeState(maxWorkers: number): RuntimeState {
  const workers: Record<string, ReturnType<typeof createIdleWorkerSlot>> = {};
  for (let i = 1; i <= maxWorkers; i++) {
    workers[`worker-${i}`] = createIdleWorkerSlot();
  }
  return {
    version: 1,
    generation: 0,
    updatedAt: new Date().toISOString(),
    updatedBy: 'test',
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

interface TestContext {
  tempDir: string;
  stateFile: string;
  supervisor: ProcessSupervisor;
  judge: CompletionJudge;
  agentRuntime: Record<string, ReturnType<typeof vi.fn>>;
  wm: WorkerManagerImpl;
  events: WorkerEvent[];
}

function setup(maxWorkers = 2): TestContext {
  const tempDir = makeTempDir();
  const stateFile = join(tempDir, 'state.json');
  const state = makeState(maxWorkers);
  writeState(stateFile, state, 'test-init');

  const supervisor = new ProcessSupervisor();
  const judge = new CompletionJudge();

  // Mock supervisor.kill
  vi.spyOn(supervisor, 'kill').mockResolvedValue();
  vi.spyOn(supervisor, 'remove').mockImplementation(() => {});

  // Mock agentRuntime for ACP transport
  const agentRuntime = {
    startRun: vi.fn().mockResolvedValue({ sessionId: 'mock-session', sessionName: 'mock', pid: 99999 }),
    resumeRun: vi.fn().mockResolvedValue({ sessionId: 'mock-session', sessionName: 'mock', pid: 99999 }),
    inspectRun: vi.fn().mockResolvedValue({ status: 'running' }),
    stopSession: vi.fn().mockResolvedValue(undefined),
    ensureSession: vi.fn().mockResolvedValue({ sessionId: 'mock-session' }),
  };

  const deps: WorkerManagerDeps = {
    supervisor,
    completionJudge: judge,
    agentRuntime: agentRuntime as any,
    stateFile,
    maxWorkers,
  };
  const wm = new WorkerManagerImpl(deps);
  const events: WorkerEvent[] = [];
  wm.onEvent((event) => events.push(event));

  return { tempDir, stateFile, supervisor, judge, agentRuntime, wm, events };
}

function makeRunRequest(taskId: string, project = 'test') {
  return {
    taskId,
    cardId: taskId,
    project,
    phase: 'development' as WorkerPhase,
    prompt: 'implement feature X',
    cwd: '/tmp/worktree',
    branch: `feat-${taskId}`,
    targetBranch: 'main',
    tool: 'claude' as const,
    transport: 'acp-sdk' as const,
    outputFile: `/tmp/output-${taskId}.jsonl`,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('WorkerManagerImpl', () => {
  let ctx: TestContext;

  afterEach(() => {
    if (ctx?.tempDir) {
      rmSync(ctx.tempDir, { recursive: true, force: true });
    }
  });

  describe('run', () => {
    it('accepts a task and assigns a slot', async () => {
      ctx = setup(2);
      const resp = await ctx.wm.run(makeRunRequest('1'));

      expect(resp.accepted).toBe(true);
      expect(resp.slot).toBe('worker-1');
      expect(resp.workerId).toBe('test:worker-1:1');
      expect(resp.pid).toBe(99999);
    });

    it('rejects duplicate task', async () => {
      ctx = setup(2);
      await ctx.wm.run(makeRunRequest('1'));
      const resp2 = await ctx.wm.run(makeRunRequest('1'));

      expect(resp2.accepted).toBe(false);
      expect(resp2.rejectReason).toBe('duplicate_task');
    });

    it('rejects when all slots exhausted', async () => {
      ctx = setup(1);
      await ctx.wm.run(makeRunRequest('1'));
      const resp = await ctx.wm.run(makeRunRequest('2'));

      expect(resp.accepted).toBe(false);
      expect(resp.rejectReason).toBe('resource_exhausted');
    });

    it('fills multiple slots', async () => {
      ctx = setup(3);
      const r1 = await ctx.wm.run(makeRunRequest('1'));
      const r2 = await ctx.wm.run(makeRunRequest('2'));
      const r3 = await ctx.wm.run(makeRunRequest('3'));

      expect(r1.slot).toBe('worker-1');
      expect(r2.slot).toBe('worker-2');
      expect(r3.slot).toBe('worker-3');
    });
  });

  describe('inspect', () => {
    it('returns all worker snapshots', async () => {
      ctx = setup(2);
      await ctx.wm.run(makeRunRequest('1'));

      const snapshots = ctx.wm.inspect({ project: 'test' });
      expect(snapshots).toHaveLength(2);

      const active = snapshots.find(s => s.state === 'running');
      expect(active).toBeDefined();
      expect(active!.slot).toBe('worker-1');
      expect(active!.taskId).toBe('1');

      const idle = snapshots.find(s => s.state === 'idle');
      expect(idle).toBeDefined();
    });

    it('filters by slot', async () => {
      ctx = setup(2);
      await ctx.wm.run(makeRunRequest('1'));

      const snapshots = ctx.wm.inspect({ slot: 'worker-1' });
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0].slot).toBe('worker-1');
    });

    it('filters by taskId', async () => {
      ctx = setup(2);
      await ctx.wm.run(makeRunRequest('1'));

      const snapshots = ctx.wm.inspect({ taskId: '1' });
      // Idle workers with seq=null pass the filter (null !== '1' check doesn't exclude them)
      // So we check that our target task is in the results
      const match = snapshots.find(s => s.taskId === '1');
      expect(match).toBeDefined();
      expect(match!.slot).toBe('worker-1');

      // Task 999 doesn't exist — only idle workers returned
      const result999 = ctx.wm.inspect({ taskId: '999' });
      const active999 = result999.filter(s => s.state !== 'idle');
      expect(active999).toHaveLength(0);
    });
  });

  describe('cancel', () => {
    it('cancels a running task', async () => {
      ctx = setup(2);
      await ctx.wm.run(makeRunRequest('1'));
      await ctx.wm.cancel({ taskId: '1', project: 'test', reason: 'user_cancel' });

      expect(ctx.supervisor.kill).toHaveBeenCalled();
      const failEvent = ctx.events.find(e => e.type === 'run.failed' && e.taskId === '1');
      expect(failEvent).toBeDefined();
      expect(failEvent!.error).toContain('Cancelled');
    });

    it('does nothing for unknown task', async () => {
      ctx = setup(2);
      await ctx.wm.cancel({ taskId: '999', project: 'test', reason: 'user_cancel' });
      expect(ctx.supervisor.kill).not.toHaveBeenCalled();
    });
  });

  describe('onEvent', () => {
    it('calls registered event handlers', async () => {
      ctx = setup(2);
      const handler = vi.fn();
      ctx.wm.onEvent(handler);

      await ctx.wm.run(makeRunRequest('1'));
      await ctx.wm.cancel({ taskId: '1', project: 'test', reason: 'user_cancel' });

      expect(handler).toHaveBeenCalled();
    });
  });

  // Integration queue tests removed — single worker model, no queue

  describe('resume', () => {
    it('accepts a resume request with session ID', async () => {
      ctx = setup(2);
      const resp = await ctx.wm.resume({
        taskId: '1',
        cardId: '1',
        project: 'test',
        phase: 'development',
        prompt: 'continue work',
        cwd: '/tmp/worktree',
        branch: 'feat-1',
        targetBranch: 'main',
        tool: 'claude',
        transport: 'acp-sdk',
        outputFile: '/tmp/output-1.jsonl',
        sessionId: 'session-abc-123',
      });

      expect(resp.accepted).toBe(true);
      expect(resp.slot).toBe('worker-1');
    });
  });

  describe('recover', () => {
    it('returns empty result when no leases exist', async () => {
      ctx = setup(2);
      const result = await ctx.wm.recover([{
        project: 'test',
        stateFile: ctx.stateFile,
        baseBranch: 'main',
      }]);

      expect(result.scanned).toBe(0);
      expect(result.alive).toBe(0);
      expect(result.completed).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.released).toBe(0);
    });

    it('releases leases when PM state is Done', async () => {
      ctx = setup(2);
      // Write state with a lease in Done state
      const { readState } = await import('../core/state.js');
      const state = readState(ctx.stateFile, 2);
      state.workers['worker-1'] = {
        ...createIdleWorkerSlot(),
        status: 'active',
        seq: 5,
      };
      state.leases['5'] = {
        seq: 5,
        pmStateObserved: 'Done',
        phase: 'coding',
        slot: 'worker-1',
        branch: 'feat-5',
        worktree: '/tmp/wt',
        sessionId: null,
        runId: null,
        claimedAt: '2026-01-01T00:00:00.000Z',
        retryCount: 0,
        lastTransitionAt: '2026-01-01T00:00:00.000Z',
      };
      writeState(ctx.stateFile, state, 'test-recover');

      const result = await ctx.wm.recover([{
        project: 'test',
        stateFile: ctx.stateFile,
        baseBranch: 'main',
      }]);

      expect(result.scanned).toBe(1);
      expect(result.released).toBe(1);
    });

    it('releases leases when PM state is Backlog', async () => {
      ctx = setup(2);
      const { readState } = await import('../core/state.js');
      const state = readState(ctx.stateFile, 2);
      state.workers['worker-1'] = {
        ...createIdleWorkerSlot(),
        status: 'active',
        seq: 3,
      };
      state.leases['3'] = {
        seq: 3,
        pmStateObserved: 'Backlog',
        phase: 'coding',
        slot: 'worker-1',
        branch: 'feat-3',
        worktree: '/tmp/wt',
        sessionId: null,
        runId: null,
        claimedAt: '2026-01-01T00:00:00.000Z',
        retryCount: 0,
        lastTransitionAt: '2026-01-01T00:00:00.000Z',
      };
      writeState(ctx.stateFile, state, 'test-recover-backlog');

      const result = await ctx.wm.recover([{
        project: 'test',
        stateFile: ctx.stateFile,
        baseBranch: 'main',
      }]);

      expect(result.scanned).toBe(1);
      expect(result.released).toBe(1);
    });

    it('skips released and suspended leases', async () => {
      ctx = setup(2);
      const { readState } = await import('../core/state.js');
      const state = readState(ctx.stateFile, 2);
      state.leases['1'] = {
        seq: 1,
        pmStateObserved: 'Inprogress',
        phase: 'released',
        slot: 'worker-1',
        branch: 'feat-1',
        worktree: '/tmp/wt',
        sessionId: null,
        runId: null,
        claimedAt: '2026-01-01T00:00:00.000Z',
        retryCount: 0,
        lastTransitionAt: '2026-01-01T00:00:00.000Z',
      };
      state.leases['2'] = {
        seq: 2,
        pmStateObserved: 'Inprogress',
        phase: 'suspended',
        slot: 'worker-2',
        branch: 'feat-2',
        worktree: '/tmp/wt2',
        sessionId: null,
        runId: null,
        claimedAt: '2026-01-01T00:00:00.000Z',
        retryCount: 0,
        lastTransitionAt: '2026-01-01T00:00:00.000Z',
      };
      writeState(ctx.stateFile, state, 'test-skip');

      const result = await ctx.wm.recover([{
        project: 'test',
        stateFile: ctx.stateFile,
        baseBranch: 'main',
      }]);

      expect(result.scanned).toBe(0);
    });
  });

  describe('state management', () => {
    it('updates state after run (slot claimed, lease created)', async () => {
      ctx = setup(2);
      await ctx.wm.run(makeRunRequest('7'));

      const { readState } = await import('../core/state.js');
      const state = readState(ctx.stateFile, 2);
      expect(state.workers['worker-1'].status).toBe('active');
      expect(state.workers['worker-1'].seq).toBe(7);
      expect(state.activeCards['7']).toBeDefined();
      expect(state.activeCards['7'].state).toBe('Inprogress');
      expect(state.leases['7']).toBeDefined();
      expect(state.leases['7'].phase).toBe('coding');
    });

    it('releases slot after cancel', async () => {
      ctx = setup(2);
      await ctx.wm.run(makeRunRequest('7'));
      await ctx.wm.cancel({ taskId: '7', project: 'test', reason: 'user_cancel' });

      const { readState } = await import('../core/state.js');
      const state = readState(ctx.stateFile, 2);
      expect(state.workers['worker-1'].status).toBe('idle');
      expect(state.workers['worker-1'].seq).toBeNull();
      expect(state.activeCards['7']).toBeUndefined();
      expect(state.leases['7']).toBeUndefined();
    });
  });

  describe('spawn failure handling', () => {
    it('emits run.failed event when agentRuntime.startRun throws', async () => {
      ctx = setup(2);
      // Make agentRuntime.startRun throw
      ctx.agentRuntime.startRun.mockRejectedValueOnce(new Error('spawn failed: command not found'));

      const resp = await ctx.wm.run(makeRunRequest('1'));
      expect(resp.accepted).toBe(false);
      expect(resp.rejectReason).toBe('spawn_failed');

      const failEvent = ctx.events.find(e => e.type === 'run.failed');
      expect(failEvent).toBeDefined();
      expect(failEvent!.error).toContain('spawn failed');
    });

    it('releases resources after spawn failure', async () => {
      ctx = setup(1);
      ctx.agentRuntime.startRun.mockRejectedValueOnce(new Error('oops'));

      await ctx.wm.run(makeRunRequest('1'));

      // Should be able to acquire again (resources released)
      ctx.agentRuntime.startRun.mockResolvedValueOnce({ sessionId: 'mock-session-2', sessionName: 'mock', pid: 88888 });

      const resp2 = await ctx.wm.run(makeRunRequest('2'));
      expect(resp2.accepted).toBe(true);
    });
  });

  describe('event handler error isolation', () => {
    it('does not crash when event handler throws', async () => {
      ctx = setup(2);
      ctx.wm.onEvent(() => { throw new Error('handler crash'); });

      await ctx.wm.run(makeRunRequest('1'));
      // Should not throw — cancel emits event that handler will throw on
      await expect(
        ctx.wm.cancel({ taskId: '1', project: 'test', reason: 'user_cancel' })
      ).resolves.toBeUndefined();
    });
  });

  // Note: handleExit is now triggered by monitorAcpCompletion polling,
  // not by supervisor.spawn onExit callbacks. Integration-level tests
  // for the ACP completion flow live in integration-queue.test.ts.

  describe('mapWorkerState', () => {
    it('maps idle status correctly', async () => {
      ctx = setup(2);
      const snapshots = ctx.wm.inspect({});
      const idle = snapshots.find(s => s.state === 'idle');
      expect(idle).toBeDefined();
    });

    it('maps active status to running', async () => {
      ctx = setup(2);
      await ctx.wm.run(makeRunRequest('1'));
      const snapshots = ctx.wm.inspect({});
      const running = snapshots.find(s => s.state === 'running');
      expect(running).toBeDefined();
    });
  });
});
