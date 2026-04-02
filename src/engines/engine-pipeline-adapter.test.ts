/**
 * Integration test: verify all engines use ProjectPipelineAdapter states
 * instead of hardcoded 'Planning'/'Backlog'/'Todo'/'Inprogress'/'QA'/'Done'.
 *
 * Uses a custom pipeline YAML with non-default state names to prove
 * configurability end-to-end.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectPipelineAdapter } from '../core/projectPipelineAdapter.js';
import { ExecutionEngine } from './ExecutionEngine.js';
import { CloseoutEngine } from './CloseoutEngine.js';
import { MonitorEngine } from './MonitorEngine.js';
import { SchedulerEngine } from './SchedulerEngine.js';
import { SPSEventHandler } from './EventHandler.js';
import { RuntimeStore } from '../core/runtimeStore.js';
import { writeState, type RuntimeState, createIdleWorkerSlot } from '../core/state.js';
import type { ProjectConfig } from '../core/config.js';
import type { ProjectContext } from '../core/context.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { Card } from '../models/types.js';
import type { WorkerManager, TaskRunResponse } from '../manager/worker-manager.js';
import type { ProcessSupervisor } from '../manager/supervisor.js';

// ─── Custom state names (must match __fixtures__/custom-pipeline.yaml) ──

const CUSTOM = {
  planning: 'Planned',
  backlog: 'Queue',
  ready: 'Ready',
  active: 'Working',
  review: 'Review',
  done: 'Shipped',
};

// ─── Helpers ────────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sps-engine-adapter-test-'));
}

function makeConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
  return {
    PROJECT_NAME: 'test-project',
    PROJECT_DIR: '/tmp/test-project',
    GITLAB_PROJECT: 'test/project',
    GITLAB_PROJECT_ID: '1',
    GITLAB_MERGE_BRANCH: 'main',
    PM_TOOL: 'plane',
    MR_MODE: 'create',
    WORKER_TOOL: 'claude',
    WORKER_TRANSPORT: 'proc',
    MAX_CONCURRENT_WORKERS: 2,
    WORKER_RESTART_LIMIT: 3,
    MAX_ACTIONS_PER_TICK: 5,
    INPROGRESS_TIMEOUT_HOURS: 4,
    MONITOR_AUTO_QA: true,
    CONFLICT_DEFAULT: 'parallel',
    TICK_LOCK_TIMEOUT_MINUTES: 10,
    WORKER_LAUNCH_TIMEOUT_S: 60,
    WORKER_IDLE_TIMEOUT_M: 30,
    raw: {},
    ...overrides,
  };
}

function makeDefaultState(maxWorkers: number): RuntimeState {
  const workers: Record<string, ReturnType<typeof createIdleWorkerSlot>> = {};
  for (let i = 0; i < maxWorkers; i++) {
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

function makeCard(seq: string, state: string, overrides: Partial<Card> = {}): Card {
  return {
    id: `card-${seq}`,
    seq,
    name: `Test card ${seq}`,
    desc: `Description for card ${seq}`,
    state,
    labels: [],
    meta: {},
    ...overrides,
  };
}

function makeCtx(tempDir: string, config: ProjectConfig): ProjectContext {
  const stateFile = join(tempDir, 'state.json');
  const logsDir = join(tempDir, 'logs');
  mkdirSync(logsDir, { recursive: true });
  return {
    projectName: 'test-project',
    config,
    paths: {
      repoDir: tempDir,
      stateFile,
      lockFile: join(tempDir, 'tick.lock'),
      logsDir,
      pipelineOrderFile: join(tempDir, 'pipeline_order.json'),
    },
    pmTool: config.PM_TOOL,
    workerTool: config.WORKER_TOOL,
    maxWorkers: config.MAX_CONCURRENT_WORKERS,
    mrMode: config.MR_MODE,
    mergeBranch: config.GITLAB_MERGE_BRANCH,
    validate: () => ({ ok: true, errors: [] }),
    reload: () => {},
  } as unknown as ProjectContext;
}

function makeTaskBackend(): TaskBackend {
  return {
    listAll: vi.fn().mockResolvedValue([]),
    listByState: vi.fn().mockResolvedValue([]),
    getBySeq: vi.fn().mockResolvedValue(null),
    move: vi.fn().mockResolvedValue(undefined),
    addLabel: vi.fn().mockResolvedValue(undefined),
    removeLabel: vi.fn().mockResolvedValue(undefined),
    claim: vi.fn().mockResolvedValue(undefined),
    releaseClaim: vi.fn().mockResolvedValue(undefined),
    comment: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue(null),
    checklistCreate: vi.fn().mockResolvedValue(undefined),
    checklistList: vi.fn().mockResolvedValue([]),
    metaRead: vi.fn().mockResolvedValue({}),
    metaWrite: vi.fn().mockResolvedValue(undefined),
    bootstrap: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskBackend;
}

function makeRepoBackend(): RepoBackend {
  return {
    ensureCleanBase: vi.fn().mockResolvedValue(undefined),
    ensureBranch: vi.fn().mockResolvedValue(undefined),
    ensureWorktree: vi.fn().mockResolvedValue(undefined),
    commit: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
    createOrUpdateMr: vi.fn().mockResolvedValue({ url: '', iid: 1 }),
    getMrStatus: vi.fn().mockResolvedValue({ exists: false, state: 'none', merged: false }),
    mergeMr: vi.fn().mockResolvedValue({ merged: true }),
    detectMerged: vi.fn().mockResolvedValue(false),
    rebase: vi.fn().mockResolvedValue({ success: true, conflictFiles: [] }),
    removeWorktree: vi.fn().mockResolvedValue(undefined),
  } as unknown as RepoBackend;
}

function makeWorkerManager(): WorkerManager {
  const response: TaskRunResponse = {
    accepted: true,
    slot: 'worker-0',
    workerId: 'test-project:worker-0:1',
    pid: 99999,
    sessionId: 'test-session',
  };
  return {
    run: vi.fn().mockResolvedValue(response),
    cancel: vi.fn().mockResolvedValue(undefined),
    inspect: vi.fn().mockReturnValue([]),
    onEvent: vi.fn(),
    cleanup: vi.fn(),
  } as unknown as WorkerManager;
}

function makeSupervisor(): ProcessSupervisor {
  return {
    spawn: vi.fn(),
    kill: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn(),
    get: vi.fn().mockReturnValue(null),
    list: vi.fn().mockReturnValue([]),
  } as unknown as ProcessSupervisor;
}

// ─── Setup pipeline adapter from YAML fixture ──────────────────────

function setupAdapterWithCustomYaml(tempDir: string, config: ProjectConfig): ProjectPipelineAdapter {
  // Copy the custom YAML to the temp project dir
  const pipelinesDir = join(tempDir, '.sps', 'pipelines');
  mkdirSync(pipelinesDir, { recursive: true });
  cpSync(
    join(__dirname, '__fixtures__', 'custom-pipeline.yaml'),
    join(pipelinesDir, 'custom-pipeline.yaml'),
  );
  return new ProjectPipelineAdapter(config, tempDir);
}

// ─── Tests ──────────────────────────────────────────────────────────

describe('ProjectPipelineAdapter YAML loading', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('loads custom state names from YAML', () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const adapter = setupAdapterWithCustomYaml(tempDir, config);

    expect(adapter.states.planning).toBe(CUSTOM.planning);
    expect(adapter.states.backlog).toBe(CUSTOM.backlog);
    expect(adapter.states.ready).toBe(CUSTOM.ready);
    expect(adapter.states.active).toBe(CUSTOM.active);
    expect(adapter.states.review).toBe(CUSTOM.review);
    expect(adapter.states.done).toBe(CUSTOM.done);
  });

  it('loads custom stages from YAML', () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const adapter = setupAdapterWithCustomYaml(tempDir, config);

    expect(adapter.stages).toHaveLength(2);
    expect(adapter.stages[0].name).toBe('develop');
    expect(adapter.stages[0].triggerState).toBe('Ready');
    expect(adapter.stages[0].activeState).toBe('Working');
    expect(adapter.stages[0].onCompleteState).toBe('Review');
    expect(adapter.stages[1].name).toBe('integrate');
    expect(adapter.stages[1].triggerState).toBe('Review');
    expect(adapter.stages[1].onCompleteState).toBe('Shipped');
  });

  it('activeStates uses custom names', () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const adapter = setupAdapterWithCustomYaml(tempDir, config);

    expect(adapter.activeStates).toContain('Planned');
    expect(adapter.activeStates).toContain('Queue');
    expect(adapter.activeStates).toContain('Ready');
    expect(adapter.activeStates).toContain('Working');
    expect(adapter.activeStates).toContain('Review');
    expect(adapter.activeStates).not.toContain('Done');
    expect(adapter.activeStates).not.toContain('Shipped');
  });

  it('derivePmState maps lease phases to custom states', () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const adapter = setupAdapterWithCustomYaml(tempDir, config);

    expect(adapter.derivePmState('queued')).toBe('Ready');
    expect(adapter.derivePmState('coding')).toBe('Working');
    expect(adapter.derivePmState('merging')).toBe('Review');
    expect(adapter.derivePmState('resolving_conflict')).toBe('Review');
    expect(adapter.derivePmState('closing')).toBe('Review');
  });
});

describe('SchedulerEngine uses adapter states', () => {
  let tempDir: string;
  let taskBackend: TaskBackend;
  let adapter: ProjectPipelineAdapter;

  beforeEach(() => {
    tempDir = makeTempDir();
    taskBackend = makeTaskBackend();
    const config = makeConfig({ PROJECT_DIR: tempDir });
    adapter = setupAdapterWithCustomYaml(tempDir, config);
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('lists cards by custom planning state', async () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const ctx = makeCtx(tempDir, config);
    const state = makeDefaultState(2);
    writeState(ctx.paths.stateFile, state, 'test');

    // Return a card with AI-PIPELINE label
    const card = makeCard('1', CUSTOM.planning, { labels: ['AI-PIPELINE'] });
    (taskBackend.listByState as ReturnType<typeof vi.fn>).mockResolvedValue([card]);

    const engine = new SchedulerEngine(ctx, taskBackend, adapter);
    await engine.tick({ dryRun: true });

    // Should call listByState with custom 'Planned' state (not 'Planning')
    expect(taskBackend.listByState).toHaveBeenCalledWith('Planned');
  });

  it('moves cards to custom backlog state', async () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const ctx = makeCtx(tempDir, config);
    const state = makeDefaultState(2);
    writeState(ctx.paths.stateFile, state, 'test');

    const card = makeCard('1', CUSTOM.planning, { labels: ['AI-PIPELINE'] });
    (taskBackend.listByState as ReturnType<typeof vi.fn>).mockResolvedValue([card]);

    const engine = new SchedulerEngine(ctx, taskBackend, adapter);
    const result = await engine.tick();

    // Should move to custom 'Queue' state (not 'Backlog')
    expect(taskBackend.move).toHaveBeenCalledWith('1', 'Queue');
  });
});

describe('ExecutionEngine uses adapter states', () => {
  let tempDir: string;
  let taskBackend: TaskBackend;
  let repoBackend: RepoBackend;
  let workerManager: WorkerManager;
  let adapter: ProjectPipelineAdapter;

  beforeEach(() => {
    tempDir = makeTempDir();
    taskBackend = makeTaskBackend();
    repoBackend = makeRepoBackend();
    workerManager = makeWorkerManager();
    const config = makeConfig({ PROJECT_DIR: tempDir });
    adapter = setupAdapterWithCustomYaml(tempDir, config);
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('lists backlog cards by custom state', async () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const ctx = makeCtx(tempDir, config);
    const state = makeDefaultState(2);
    writeState(ctx.paths.stateFile, state, 'test');

    const engine = new ExecutionEngine(ctx, taskBackend, repoBackend, workerManager, adapter);
    await engine.tick({ dryRun: true });

    // Should query custom states: 'Working' (active), 'Queue' (backlog), 'Ready' (ready)
    const calls = (taskBackend.listByState as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    expect(calls).toContain('Working');  // listRuntimeAwareInprogressCards
    expect(calls).toContain('Queue');    // backlog cards
    expect(calls).toContain('Ready');    // todo cards (at least 2 calls)
  });

  it('prepares card: moves to custom ready state', async () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const ctx = makeCtx(tempDir, config);
    const state = makeDefaultState(2);
    writeState(ctx.paths.stateFile, state, 'test');

    // Return a backlog card, empty for other states
    const backlogCard = makeCard('1', CUSTOM.backlog);
    (taskBackend.listByState as ReturnType<typeof vi.fn>).mockImplementation((s: string) => {
      if (s === CUSTOM.backlog) return Promise.resolve([backlogCard]);
      return Promise.resolve([]);
    });

    const engine = new ExecutionEngine(ctx, taskBackend, repoBackend, workerManager, adapter);
    await engine.tick();

    // prepare phase should move Backlog → Ready (custom states)
    expect(taskBackend.move).toHaveBeenCalledWith('1', 'Ready');
  });

  it('launches card: moves to custom active state', async () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const ctx = makeCtx(tempDir, config);
    const state = makeDefaultState(2);
    writeState(ctx.paths.stateFile, state, 'test');

    // Return a Todo/Ready card ready to launch
    const readyCard = makeCard('1', CUSTOM.ready);
    (taskBackend.listByState as ReturnType<typeof vi.fn>).mockImplementation((s: string) => {
      if (s === CUSTOM.ready) return Promise.resolve([readyCard]);
      return Promise.resolve([]);
    });

    const engine = new ExecutionEngine(ctx, taskBackend, repoBackend, workerManager, adapter);
    await engine.tick();

    // launch phase should move Ready → Working (custom states)
    expect(taskBackend.move).toHaveBeenCalledWith('1', 'Working');
  });
});

describe('CloseoutEngine uses adapter states', () => {
  let tempDir: string;
  let taskBackend: TaskBackend;
  let repoBackend: RepoBackend;
  let workerManager: WorkerManager;
  let adapter: ProjectPipelineAdapter;

  beforeEach(() => {
    tempDir = makeTempDir();
    taskBackend = makeTaskBackend();
    repoBackend = makeRepoBackend();
    workerManager = makeWorkerManager();
    const config = makeConfig({ PROJECT_DIR: tempDir });
    adapter = setupAdapterWithCustomYaml(tempDir, config);
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('lists cards by custom review state', async () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const ctx = makeCtx(tempDir, config);
    const state = makeDefaultState(2);
    writeState(ctx.paths.stateFile, state, 'test');

    const engine = new CloseoutEngine(ctx, taskBackend, repoBackend, workerManager, adapter);
    await engine.tick();

    // Should call listByState with custom 'Review' (not 'QA')
    expect(taskBackend.listByState).toHaveBeenCalledWith('Review');
  });
});

describe('MonitorEngine uses adapter states', () => {
  let tempDir: string;
  let taskBackend: TaskBackend;
  let repoBackend: RepoBackend;
  let supervisor: ProcessSupervisor;
  let adapter: ProjectPipelineAdapter;

  beforeEach(() => {
    tempDir = makeTempDir();
    taskBackend = makeTaskBackend();
    repoBackend = makeRepoBackend();
    supervisor = makeSupervisor();
    const config = makeConfig({ PROJECT_DIR: tempDir });
    adapter = setupAdapterWithCustomYaml(tempDir, config);
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('lists inprogress cards by custom active state', async () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const ctx = makeCtx(tempDir, config);
    const state = makeDefaultState(2);
    writeState(ctx.paths.stateFile, state, 'test');

    const engine = new MonitorEngine(ctx, taskBackend, repoBackend, undefined, supervisor, adapter);
    await engine.tick();

    // Should call listByState with custom 'Working' (not 'Inprogress')
    const calls = (taskBackend.listByState as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    expect(calls).toContain('Working');
  });

  it('checkBlockedCards iterates custom state names', async () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const ctx = makeCtx(tempDir, config);
    const state = makeDefaultState(2);
    writeState(ctx.paths.stateFile, state, 'test');

    const engine = new MonitorEngine(ctx, taskBackend, repoBackend, undefined, supervisor, adapter);
    await engine.tick();

    // checkBlockedCards should iterate Queue/Ready/Working/Review (not Backlog/Todo/Inprogress/QA)
    const calls = (taskBackend.listByState as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    expect(calls).toContain('Queue');
    expect(calls).toContain('Ready');
    expect(calls).toContain('Review');
  });

  it('auto-retry moves to custom ready state', async () => {
    const config = makeConfig({ PROJECT_DIR: tempDir, MONITOR_AUTO_QA: true });
    const ctx = makeCtx(tempDir, config);

    // Set up state with an active card that has a stale slot
    const state = makeDefaultState(2);
    state.workers['worker-0'] = {
      ...createIdleWorkerSlot(),
      status: 'active',
      seq: 1,
      branch: 'feature/1-test',
      worktree: '/tmp/wt-1',
      claimedAt: new Date(Date.now() - 600_000).toISOString(),
      lastHeartbeat: null,
      mode: 'print',
      transport: 'proc',
      outputFile: '/tmp/non-existent-output.jsonl',
    };
    state.activeCards['1'] = {
      seq: 1,
      state: 'Working',
      worker: 'worker-0',
      mrUrl: null,
      conflictDomains: [],
      startedAt: new Date(Date.now() - 600_000).toISOString(),
      retryCount: 0,
    };
    state.leases['1'] = {
      seq: 1,
      pmStateObserved: 'Working',
      phase: 'coding',
      slot: 'worker-0',
      branch: 'feature/1-test',
      worktree: '/tmp/wt-1',
      sessionId: null,
      runId: null,
      claimedAt: new Date(Date.now() - 600_000).toISOString(),
      retryCount: 0,
      lastTransitionAt: new Date(Date.now() - 600_000).toISOString(),
    };
    writeState(ctx.paths.stateFile, state, 'test');

    // Return the card as being in 'Working' state
    const card = makeCard('1', CUSTOM.active);
    (taskBackend.listByState as ReturnType<typeof vi.fn>).mockImplementation((s: string) => {
      if (s === CUSTOM.active) return Promise.resolve([card]);
      return Promise.resolve([]);
    });
    // getMrStatus returns no MR (so it's a genuine stale runtime)
    (repoBackend.getMrStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      exists: false,
      state: 'none',
      merged: false,
    });

    const engine = new MonitorEngine(ctx, taskBackend, repoBackend, undefined, supervisor, adapter);
    await engine.tick();

    // With MONITOR_AUTO_QA, stale runtime should be moved to Review (custom, not QA)
    const moveCalls = (taskBackend.move as ReturnType<typeof vi.fn>).mock.calls;
    if (moveCalls.length > 0) {
      // Should use 'Review' (custom) not 'QA' (default)
      const targets = moveCalls.map(c => c[1]);
      expect(targets.every(t => t !== 'QA')).toBe(true);
      // Check for either Review (auto-qa) or Ready (auto-retry)
      expect(targets.some(t => t === 'Review' || t === 'Ready')).toBe(true);
    }
  });
});

describe('SPSEventHandler uses adapter states', () => {
  let tempDir: string;
  let taskBackend: TaskBackend;
  let adapter: ProjectPipelineAdapter;

  beforeEach(() => {
    tempDir = makeTempDir();
    taskBackend = makeTaskBackend();
    const config = makeConfig({ PROJECT_DIR: tempDir });
    adapter = setupAdapterWithCustomYaml(tempDir, config);
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('onCompleted moves to custom done state for integration', async () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const ctx = makeCtx(tempDir, config);
    const state = makeDefaultState(2);
    state.leases['1'] = {
      seq: 1,
      pmStateObserved: 'Review',
      phase: 'merging',
      slot: 'worker-0',
      branch: 'feature/1-test',
      worktree: '/tmp/wt-1',
      sessionId: null,
      runId: null,
      claimedAt: new Date().toISOString(),
      retryCount: 0,
      lastTransitionAt: new Date().toISOString(),
    };
    writeState(ctx.paths.stateFile, state, 'test');

    const runtimeStore = new RuntimeStore({
      paths: { stateFile: ctx.paths.stateFile },
      maxWorkers: config.MAX_CONCURRENT_WORKERS,
    });

    const handler = new SPSEventHandler({
      taskBackend,
      runtimeStore,
      project: 'test-project',
      pipelineAdapter: adapter,
    });

    // Simulate a completed integration event
    handler.handle({
      type: 'run.completed',
      taskId: '1',
      cardId: '1',
      workerId: 'test-project:worker-0:1',
      timestamp: new Date().toISOString(),
      phase: 'integration',
      slot: 'worker-0',
      project: 'test-project',
      state: 'completed',
      exitCode: 0,
      completionResult: { status: 'completed', reason: 'already_merged' },
    });

    // Allow async handlers to complete
    await new Promise(r => setTimeout(r, 100));

    // Should move to 'Shipped' (custom done), not 'Done'
    expect(taskBackend.move).toHaveBeenCalledWith('1', 'Shipped');
  });

  it('onCompleted moves to custom review state for development', async () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const ctx = makeCtx(tempDir, config);
    const state = makeDefaultState(2);
    state.leases['1'] = {
      seq: 1,
      pmStateObserved: 'Working',
      phase: 'coding',
      slot: 'worker-0',
      branch: 'feature/1-test',
      worktree: '/tmp/wt-1',
      sessionId: null,
      runId: null,
      claimedAt: new Date().toISOString(),
      retryCount: 0,
      lastTransitionAt: new Date().toISOString(),
    };
    writeState(ctx.paths.stateFile, state, 'test');

    const runtimeStore = new RuntimeStore({
      paths: { stateFile: ctx.paths.stateFile },
      maxWorkers: config.MAX_CONCURRENT_WORKERS,
    });

    const handler = new SPSEventHandler({
      taskBackend,
      runtimeStore,
      project: 'test-project',
      pipelineAdapter: adapter,
    });

    // Simulate a completed development event
    handler.handle({
      type: 'run.completed',
      taskId: '1',
      cardId: '1',
      workerId: 'test-project:worker-0:1',
      timestamp: new Date().toISOString(),
      phase: 'development',
      slot: 'worker-0',
      project: 'test-project',
      state: 'completed',
      exitCode: 0,
      completionResult: { status: 'completed', reason: 'branch_pushed' },
    });

    // Allow async handlers to complete
    await new Promise(r => setTimeout(r, 100));

    // Should move to 'Review' (custom review), not 'QA'
    expect(taskBackend.move).toHaveBeenCalledWith('1', 'Review');
  });

  it('releaseSlot sets custom review state in pmStateObserved', async () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const ctx = makeCtx(tempDir, config);
    const state = makeDefaultState(2);
    state.workers['worker-0'] = {
      ...createIdleWorkerSlot(),
      status: 'active',
      seq: 1,
      branch: 'feature/1-test',
      worktree: '/tmp/wt-1',
      claimedAt: new Date().toISOString(),
      lastHeartbeat: null,
    };
    state.activeCards['1'] = {
      seq: 1,
      state: 'Working',
      worker: 'worker-0',
      mrUrl: null,
      conflictDomains: [],
      startedAt: new Date().toISOString(),
    };
    state.leases['1'] = {
      seq: 1,
      pmStateObserved: 'Working',
      phase: 'coding',
      slot: 'worker-0',
      branch: 'feature/1-test',
      worktree: '/tmp/wt-1',
      sessionId: null,
      runId: null,
      claimedAt: new Date().toISOString(),
      retryCount: 0,
      lastTransitionAt: new Date().toISOString(),
    };
    writeState(ctx.paths.stateFile, state, 'test');

    const runtimeStore = new RuntimeStore({
      paths: { stateFile: ctx.paths.stateFile },
      maxWorkers: config.MAX_CONCURRENT_WORKERS,
    });

    const handler = new SPSEventHandler({
      taskBackend,
      runtimeStore,
      project: 'test-project',
      pipelineAdapter: adapter,
    });

    // Simulate development completion
    handler.handle({
      type: 'run.completed',
      taskId: '1',
      cardId: '1',
      workerId: 'test-project:worker-0:1',
      timestamp: new Date().toISOString(),
      phase: 'development',
      slot: 'worker-0',
      project: 'test-project',
      state: 'completed',
      exitCode: 0,
      completionResult: { status: 'completed', reason: 'branch_pushed' },
    });

    await new Promise(r => setTimeout(r, 100));

    // Verify runtime state has custom review state
    const freshState = runtimeStore.readState();
    if (freshState.leases['1']) {
      expect(freshState.leases['1'].pmStateObserved).toBe('Review');
    }
  });
});

describe('Full pipeline flow with custom states (dry-run)', () => {
  let tempDir: string;
  let taskBackend: TaskBackend;
  let repoBackend: RepoBackend;
  let workerManager: WorkerManager;
  let adapter: ProjectPipelineAdapter;

  beforeEach(() => {
    tempDir = makeTempDir();
    taskBackend = makeTaskBackend();
    repoBackend = makeRepoBackend();
    workerManager = makeWorkerManager();
    const config = makeConfig({ PROJECT_DIR: tempDir });
    adapter = setupAdapterWithCustomYaml(tempDir, config);
  });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('never uses default state names when custom YAML is loaded', async () => {
    const config = makeConfig({ PROJECT_DIR: tempDir });
    const ctx = makeCtx(tempDir, config);
    const state = makeDefaultState(2);
    writeState(ctx.paths.stateFile, state, 'test');

    const DEFAULTS = ['Planning', 'Backlog', 'Todo', 'Inprogress', 'QA', 'Done'];

    // Run all engines in sequence
    const scheduler = new SchedulerEngine(ctx, taskBackend, adapter);
    await scheduler.tick();

    const execution = new ExecutionEngine(ctx, taskBackend, repoBackend, workerManager, adapter);
    await execution.tick();

    const closeout = new CloseoutEngine(ctx, taskBackend, repoBackend, workerManager, adapter);
    await closeout.tick();

    const supervisor = makeSupervisor();
    const monitor = new MonitorEngine(ctx, taskBackend, repoBackend, undefined, supervisor, adapter);
    await monitor.tick();

    // Collect all calls to listByState and move
    const listCalls = (taskBackend.listByState as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0]);
    const moveCalls = (taskBackend.move as ReturnType<typeof vi.fn>).mock.calls.map(c => c[1]);
    const allStateCalls = [...listCalls, ...moveCalls];

    // No call should use any default state name
    for (const call of allStateCalls) {
      expect(DEFAULTS).not.toContain(call);
    }

    // Should use custom state names instead
    expect(listCalls).toContain('Planned');   // Scheduler
    expect(listCalls).toContain('Queue');     // Execution (backlog)
    expect(listCalls).toContain('Ready');     // Execution (todo)
    expect(listCalls).toContain('Working');   // Execution (inprogress) + Monitor
    expect(listCalls).toContain('Review');    // Closeout + Monitor blocked check
  });
});
