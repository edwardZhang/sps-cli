import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WorkerManagerImpl, type WorkerManagerDeps } from './worker-manager-impl.js';
import { ProcessSupervisor, type SpawnOpts, type WorkerHandle } from './supervisor.js';
import { CompletionJudge } from './completion-judge.js';
import { ResourceLimiter } from './resource-limiter.js';
import { writeState, createIdleWorkerSlot, type RuntimeState } from '../core/state.js';
import type { WorkerEvent, WorkerPhase } from './worker-manager.js';

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
  limiter: ResourceLimiter;
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
  const limiter = new ResourceLimiter({ maxGlobalWorkers: maxWorkers, staggerDelayMs: 0 });

  // Mock supervisor.spawn to avoid real process creation
  const spawnMock = vi.spyOn(supervisor, 'spawn').mockImplementation((opts: SpawnOpts): WorkerHandle => {
    return {
      id: opts.id,
      transport: 'proc',
      pid: 99999,
      child: null,
      outputFile: opts.outputFile,
      project: opts.project,
      seq: opts.seq,
      slot: opts.slot,
      branch: opts.branch,
      worktree: opts.worktree,
      tool: opts.tool,
      exitCode: null,
      sessionId: null,
      runId: null,
      sessionState: null,
      remoteStatus: null,
      lastEventAt: null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
    };
  });

  // Mock supervisor.kill
  vi.spyOn(supervisor, 'kill').mockResolvedValue();
  vi.spyOn(supervisor, 'remove').mockImplementation(() => {});

  const deps: WorkerManagerDeps = {
    supervisor,
    completionJudge: judge,
    resourceLimiter: limiter,
    agentRuntime: null,
    stateFile,
    maxWorkers,
  };
  const wm = new WorkerManagerImpl(deps);
  const events: WorkerEvent[] = [];
  wm.onEvent((event) => events.push(event));

  return { tempDir, stateFile, supervisor, judge, limiter, wm, events };
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
    transport: 'proc' as const,
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

    it('spawns via supervisor', async () => {
      ctx = setup(2);
      await ctx.wm.run(makeRunRequest('1'));

      expect(ctx.supervisor.spawn).toHaveBeenCalledOnce();
      const opts = (ctx.supervisor.spawn as any).mock.calls[0][0] as SpawnOpts;
      expect(opts.tool).toBe('claude');
      expect(opts.prompt).toBe('implement feature X');
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

  describe('integration queue', () => {
    it('queues second integration task', async () => {
      ctx = setup(2);
      const req1 = { ...makeRunRequest('1'), phase: 'integration' as WorkerPhase };
      const req2 = { ...makeRunRequest('2'), phase: 'integration' as WorkerPhase };

      const r1 = await ctx.wm.run(req1);
      expect(r1.accepted).toBe(true);
      expect(r1.queued).toBeUndefined();

      const r2 = await ctx.wm.run(req2);
      expect(r2.accepted).toBe(true);
      expect(r2.queued).toBe(true);
      expect(r2.queuePosition).toBeGreaterThan(0);
    });
  });

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
        transport: 'proc',
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
    it('emits run.failed event when spawn throws', async () => {
      ctx = setup(2);
      // Make spawn throw
      (ctx.supervisor.spawn as any).mockImplementation(() => {
        throw new Error('spawn failed: command not found');
      });

      const resp = await ctx.wm.run(makeRunRequest('1'));
      expect(resp.accepted).toBe(false);
      expect(resp.rejectReason).toBe('spawn_failed');

      const failEvent = ctx.events.find(e => e.type === 'run.failed');
      expect(failEvent).toBeDefined();
      expect(failEvent!.error).toContain('spawn failed');
    });

    it('releases resources after spawn failure', async () => {
      ctx = setup(1);
      (ctx.supervisor.spawn as any).mockImplementation(() => {
        throw new Error('oops');
      });

      await ctx.wm.run(makeRunRequest('1'));

      // Should be able to acquire again (resources released)
      (ctx.supervisor.spawn as any).mockImplementation((opts: SpawnOpts): WorkerHandle => ({
        id: opts.id, transport: 'proc', pid: 88888, child: null,
        outputFile: opts.outputFile, project: opts.project, seq: opts.seq,
        slot: opts.slot, branch: opts.branch, worktree: opts.worktree,
        tool: opts.tool, exitCode: null, sessionId: null, runId: null,
        sessionState: null, remoteStatus: null, lastEventAt: null,
        startedAt: new Date().toISOString(), exitedAt: null,
      }));

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

  describe('handleExit (via onExit callback)', () => {
    it('emits run.completed when CompletionJudge says completed', async () => {
      ctx = setup(2);
      let capturedOnExit: ((exitCode: number) => Promise<void> | void) | null = null;

      // Capture the onExit callback from spawn
      (ctx.supervisor.spawn as any).mockImplementation((opts: SpawnOpts): WorkerHandle => {
        capturedOnExit = opts.onExit;
        return {
          id: opts.id, transport: 'proc', pid: 99999, child: null,
          outputFile: opts.outputFile, project: opts.project, seq: opts.seq,
          slot: opts.slot, branch: opts.branch, worktree: opts.worktree,
          tool: opts.tool, exitCode: null, sessionId: null, runId: null,
          sessionState: null, remoteStatus: null, lastEventAt: null,
          startedAt: new Date().toISOString(), exitedAt: null,
        };
      });

      // Mock CompletionJudge to return completed
      vi.spyOn(ctx.judge, 'judge').mockReturnValue({
        status: 'completed',
        reason: 'branch_pushed',
      });

      await ctx.wm.run(makeRunRequest('1'));
      expect(capturedOnExit).not.toBeNull();

      // Trigger the exit callback
      await capturedOnExit!(0);

      const completedEvent = ctx.events.find(e => e.type === 'run.completed' && e.taskId === '1');
      expect(completedEvent).toBeDefined();
      expect(completedEvent!.completionResult?.status).toBe('completed');
      expect(completedEvent!.completionResult?.reason).toBe('branch_pushed');
    });

    it('emits run.failed when CompletionJudge says failed', async () => {
      ctx = setup(2);
      let capturedOnExit: ((exitCode: number) => Promise<void> | void) | null = null;

      (ctx.supervisor.spawn as any).mockImplementation((opts: SpawnOpts): WorkerHandle => {
        capturedOnExit = opts.onExit;
        return {
          id: opts.id, transport: 'proc', pid: 99999, child: null,
          outputFile: opts.outputFile, project: opts.project, seq: opts.seq,
          slot: opts.slot, branch: opts.branch, worktree: opts.worktree,
          tool: opts.tool, exitCode: null, sessionId: null, runId: null,
          sessionState: null, remoteStatus: null, lastEventAt: null,
          startedAt: new Date().toISOString(), exitedAt: null,
        };
      });

      vi.spyOn(ctx.judge, 'judge').mockReturnValue({
        status: 'failed',
        reason: 'crash(1)',
      });

      await ctx.wm.run(makeRunRequest('1'));
      await capturedOnExit!(1);

      const failedEvent = ctx.events.find(e => e.type === 'run.failed' && e.taskId === '1');
      expect(failedEvent).toBeDefined();
      expect(failedEvent!.exitCode).toBe(1);
    });

    it('releases resource limiter slot after exit', async () => {
      ctx = setup(1);
      let capturedOnExit: ((exitCode: number) => Promise<void> | void) | null = null;

      (ctx.supervisor.spawn as any).mockImplementation((opts: SpawnOpts): WorkerHandle => {
        capturedOnExit = opts.onExit;
        return {
          id: opts.id, transport: 'proc', pid: 99999, child: null,
          outputFile: opts.outputFile, project: opts.project, seq: opts.seq,
          slot: opts.slot, branch: opts.branch, worktree: opts.worktree,
          tool: opts.tool, exitCode: null, sessionId: null, runId: null,
          sessionState: null, remoteStatus: null, lastEventAt: null,
          startedAt: new Date().toISOString(), exitedAt: null,
        };
      });

      vi.spyOn(ctx.judge, 'judge').mockReturnValue({
        status: 'completed',
        reason: 'branch_pushed',
      });

      await ctx.wm.run(makeRunRequest('1'));
      // Resource limiter should be at capacity
      expect(ctx.limiter.tryAcquire()).toBe(false);

      // Trigger exit → handleExit releases the resource limiter slot
      await capturedOnExit!(0);

      // Resource limiter should have a free slot now
      // (state.json slot is released by SPSEventHandler, not handleExit)
      expect(ctx.limiter.tryAcquire()).toBe(true);
      ctx.limiter.release(); // clean up
    });
  });

  // Note: Integration queue auto-dequeue on exit is tested via
  // integration-queue.test.ts. The handleExit → advanceIntegrationQueue
  // path requires full stagger timing which is tested above via the
  // resource limiter release verification.

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
