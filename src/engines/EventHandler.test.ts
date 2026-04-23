/**
 * @module        EventHandler.test
 * @description   SPSEventHandler COMPLETED-<stage> 标签门控逻辑测试
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
 * @boundedContext worker-lifecycle
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectPipelineAdapter, StageDefinition } from '../core/projectPipelineAdapter.js';
import { RuntimeStore } from '../core/runtimeStore.js';
import type { RuntimeState } from '../core/state.js';
import { writeState } from '../core/state.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { WorkerEvent } from '../manager/worker-manager.js';
import type { Card } from '../shared/types.js';
import { SPSEventHandler } from './EventHandler.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sps-eh-test-'));
}

function makeState(): RuntimeState {
  return {
    version: 1, generation: 0,
    updatedAt: new Date().toISOString(), updatedBy: 'test',
    workers: { 'worker-1': { status: 'active', seq: 42 } as any },
    activeCards: {},
    leases: {},
    worktreeEvidence: {},
    worktreeCleanup: [],
    sessions: {},
    integrationQueues: {},
    pendingPMActions: [],
  };
}

function makeStage(name = 'develop'): StageDefinition {
  return {
    name,
    triggerState: 'Todo',
    activeState: 'Inprogress',
    agent: 'claude',
    completion: 'exit-code',
    onCompleteState: 'QA',
    onFailLabel: 'NEEDS-FIX',
    onFailComment: 'failed',
  } as any;
}

function makePipelineAdapter(stage: StageDefinition = makeStage()): ProjectPipelineAdapter {
  return {
    states: { planning: 'Planning', backlog: 'Backlog', ready: 'Todo', done: 'Done' },
    stages: [stage],
    activeStates: ['Inprogress'],
    getStage: () => stage,
  } as unknown as ProjectPipelineAdapter;
}

function makeCompletedEvent(taskId = '42'): WorkerEvent {
  return {
    type: 'run.completed',
    taskId,
    cardId: taskId,
    project: 'test',
    phase: 'development',
    slot: 'worker-1',
    workerId: 'test:worker-1:42',
    timestamp: new Date().toISOString(),
    state: 'completed',
    exitCode: 0,
    completionResult: { status: 'completed', reason: 'acp_completed' } as any,
  } as any;
}

describe('SPSEventHandler.onCompleted (label gating)', () => {
  let dir: string;

  beforeEach(() => { dir = tempDir(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('moves card to onCompleteState when COMPLETED-<stage> label present', async () => {
    writeState(join(dir, 'state.json'), makeState(), 'init');
    const card: Card = {
      id: 'c42', seq: '42', title: 't', desc: '', state: 'Inprogress',
      labels: ['COMPLETED-develop'], meta: {},
    };
    const move = vi.fn(async () => {});
    const addLabel = vi.fn(async () => {});
    const comment = vi.fn(async () => {});
    const taskBackend = {
      getBySeq: vi.fn(async () => card),
      move, addLabel, comment, removeLabel: vi.fn(async () => {}),
      releaseClaim: vi.fn(async () => {}), claim: vi.fn(async () => {}),
    } as unknown as TaskBackend;
    const notifier: Notifier = {
      send: vi.fn(async () => {}),
      sendSuccess: vi.fn(async () => {}), sendWarning: vi.fn(async () => {}),
      sendError: vi.fn(async () => {}), sendDigest: vi.fn(async () => {}),
    } as any;
    const handler = new SPSEventHandler({
      taskBackend, notifier,
      runtimeStore: new RuntimeStore({ paths: { stateFile: join(dir, 'state.json') }, maxWorkers: 1 } as any),
      project: 'test',
      pipelineAdapter: makePipelineAdapter(),
    });

    // handle is sync-dispatch, run async and await
    handler.handle(makeCompletedEvent());
    await new Promise((r) => setTimeout(r, 50));

    expect(move).toHaveBeenCalledWith('42', 'QA');
    expect(addLabel).not.toHaveBeenCalledWith('42', 'NEEDS-FIX');
  });

  it('marks NEEDS-FIX when COMPLETED-<stage> label missing', async () => {
    writeState(join(dir, 'state.json'), makeState(), 'init');
    const card: Card = {
      id: 'c42', seq: '42', title: 't', desc: '', state: 'Inprogress',
      labels: [], meta: {},   // no COMPLETED label
    };
    const move = vi.fn(async () => {});
    const addLabel = vi.fn(async () => {});
    const comment = vi.fn(async () => {});
    const taskBackend = {
      getBySeq: vi.fn(async () => card),
      move, addLabel, comment, removeLabel: vi.fn(async () => {}),
      releaseClaim: vi.fn(async () => {}), claim: vi.fn(async () => {}),
    } as unknown as TaskBackend;
    const notifier: Notifier = {
      send: vi.fn(async () => {}),
      sendSuccess: vi.fn(async () => {}), sendWarning: vi.fn(async () => {}),
      sendError: vi.fn(async () => {}), sendDigest: vi.fn(async () => {}),
    } as any;
    const handler = new SPSEventHandler({
      taskBackend, notifier,
      runtimeStore: new RuntimeStore({ paths: { stateFile: join(dir, 'state.json') }, maxWorkers: 1 } as any),
      project: 'test',
      pipelineAdapter: makePipelineAdapter(),
      completedLabelPoll: { timeoutMs: 30, intervalMs: 10 },
    });

    handler.handle(makeCompletedEvent());
    await new Promise((r) => setTimeout(r, 100));

    expect(addLabel).toHaveBeenCalledWith('42', 'NEEDS-FIX');
    expect(move).not.toHaveBeenCalledWith('42', 'QA');  // NOT moved to onCompleteState
  });

  // v0.50.12：Stop hook race regression
  it('polls for COMPLETED label before declaring NEEDS-FIX', async () => {
    writeState(join(dir, 'state.json'), makeState(), 'init');
    // 先无 label，第 2 次读才有 —— 模拟 Stop hook 晚到
    let readCount = 0;
    const card = (): Card => ({
      id: 'c42', seq: '42', title: 't', desc: '', state: 'Inprogress',
      labels: readCount++ >= 1 ? ['COMPLETED-develop'] : [],
      meta: {},
    });
    const move = vi.fn(async () => {});
    const addLabel = vi.fn(async () => {});
    const taskBackend = {
      getBySeq: vi.fn(async () => card()),
      move, addLabel, comment: vi.fn(async () => {}), removeLabel: vi.fn(async () => {}),
      releaseClaim: vi.fn(async () => {}), claim: vi.fn(async () => {}),
    } as unknown as TaskBackend;
    const handler = new SPSEventHandler({
      taskBackend,
      notifier: {
        send: vi.fn(async () => {}), sendSuccess: vi.fn(async () => {}),
        sendWarning: vi.fn(async () => {}), sendError: vi.fn(async () => {}),
        sendDigest: vi.fn(async () => {}),
      } as any,
      runtimeStore: new RuntimeStore({ paths: { stateFile: join(dir, 'state.json') }, maxWorkers: 1 } as any),
      project: 'test',
      pipelineAdapter: makePipelineAdapter(),
      completedLabelPoll: { timeoutMs: 500, intervalMs: 20 },
    });

    handler.handle(makeCompletedEvent());
    await new Promise((r) => setTimeout(r, 150));

    // label 第 2 次出现，应按成功路径处理
    expect(move).toHaveBeenCalledWith('42', 'QA');
    expect(addLabel).not.toHaveBeenCalledWith('42', 'NEEDS-FIX');
  });

  it('routes to stage-specific label — COMPLETED-qa for qa stage', async () => {
    writeState(join(dir, 'state.json'), makeState(), 'init');
    const qaStage = makeStage('qa');
    const card: Card = {
      id: 'c42', seq: '42', title: 't', desc: '', state: 'QA',
      labels: ['COMPLETED-qa'], meta: {},
    };
    const move = vi.fn(async () => {});
    const taskBackend = {
      getBySeq: vi.fn(async () => card),
      move, addLabel: vi.fn(async () => {}), comment: vi.fn(async () => {}),
      removeLabel: vi.fn(async () => {}), releaseClaim: vi.fn(async () => {}), claim: vi.fn(async () => {}),
    } as unknown as TaskBackend;
    const notifier: Notifier = {
      send: vi.fn(async () => {}),
      sendSuccess: vi.fn(async () => {}), sendWarning: vi.fn(async () => {}),
      sendError: vi.fn(async () => {}), sendDigest: vi.fn(async () => {}),
    } as any;
    const handler = new SPSEventHandler({
      taskBackend, notifier,
      runtimeStore: new RuntimeStore({ paths: { stateFile: join(dir, 'state.json') }, maxWorkers: 1 } as any),
      project: 'test',
      pipelineAdapter: makePipelineAdapter(qaStage),
    });

    handler.handle(makeCompletedEvent());
    await new Promise((r) => setTimeout(r, 50));

    expect(move).toHaveBeenCalledWith('42', 'QA');  // stage's onCompleteState
  });
});
