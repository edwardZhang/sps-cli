/**
 * @module        orphanRecovery.test
 * @description   v0.50.17：从 DefaultPipelineExecutor.recoverOrphans 抽出的纯函数
 *                planner 测试，锁住 v0.50.8 的启动前自愈行为。
 */
import { describe, expect, it } from 'vitest';
import {
  planOrphanRecovery,
  resetWorkerSlot,
  type PipelineAdapterLike,
  type RuntimeStateLike,
} from './orphanRecovery.js';

const adapter: PipelineAdapterLike = {
  states: { ready: 'Todo', planning: 'Planning', done: 'Done' },
  stages: [
    { name: 'develop', triggerState: 'Todo', activeState: 'Inprogress', onCompleteState: 'Done' },
  ],
};

describe('planOrphanRecovery', () => {
  it('returns empty orphan list when all slots idle', () => {
    const state: RuntimeStateLike = {
      workers: {
        'worker-1': { status: 'idle', seq: null },
      },
    };
    const plan = planOrphanRecovery(state, adapter);
    expect(plan.orphans).toEqual([]);
  });

  it('detects active slot with seq as orphan', () => {
    const state: RuntimeStateLike = {
      workers: {
        'worker-1': { status: 'active', seq: 17 },
      },
    };
    const plan = planOrphanRecovery(state, adapter);
    expect(plan.orphans).toEqual([{ seq: '17', slotName: 'worker-1' }]);
  });

  it('detects resolving / merging slots too', () => {
    const state: RuntimeStateLike = {
      workers: {
        'worker-1': { status: 'resolving', seq: 5 },
        'worker-2': { status: 'merging', seq: 8 },
        'worker-3': { status: 'idle', seq: null },
      },
    };
    const plan = planOrphanRecovery(state, adapter);
    expect(plan.orphans.map((o) => o.slotName).sort()).toEqual(['worker-1', 'worker-2']);
  });

  it('skips slots with null seq even if status != idle (corrupt state)', () => {
    const state: RuntimeStateLike = {
      workers: {
        'worker-1': { status: 'active', seq: null },
      },
    };
    const plan = planOrphanRecovery(state, adapter);
    expect(plan.orphans).toEqual([]);
  });

  it('computes triggerState from first stage', () => {
    const plan = planOrphanRecovery({ workers: {} }, adapter);
    expect(plan.triggerState).toBe('Todo');
  });

  it('falls back to states.ready when first stage has no triggerState', () => {
    const plan = planOrphanRecovery(
      { workers: {} },
      { states: { ready: 'Backlog' }, stages: [{ name: 'x' }] },
    );
    expect(plan.triggerState).toBe('Backlog');
  });

  it('falls back to Todo when neither stage nor states has hints', () => {
    const plan = planOrphanRecovery(
      { workers: {} },
      { states: {}, stages: [] },
    );
    expect(plan.triggerState).toBe('Todo');
  });

  it('builds transientLabels with per-stage STARTED-*/ACK-RETRIED-* + globals', () => {
    const multiStage: PipelineAdapterLike = {
      states: { ready: 'Todo' },
      stages: [
        { name: 'develop', triggerState: 'Todo', activeState: 'Inprogress' },
        { name: 'qa', triggerState: 'QA', activeState: 'QA' },
      ],
    };
    const plan = planOrphanRecovery({ workers: {} }, multiStage);
    // global transient
    expect(plan.transientLabels.has('CLAIMED')).toBe(true);
    expect(plan.transientLabels.has('STALE-RUNTIME')).toBe(true);
    expect(plan.transientLabels.has('ACK-TIMEOUT')).toBe(true);
    expect(plan.transientLabels.has('RACE-CANDIDATE')).toBe(true);
    // per-stage
    expect(plan.transientLabels.has('STARTED-develop')).toBe(true);
    expect(plan.transientLabels.has('STARTED-qa')).toBe(true);
    expect(plan.transientLabels.has('ACK-RETRIED-develop')).toBe(true);
    expect(plan.transientLabels.has('ACK-RETRIED-qa')).toBe(true);
  });

  // v0.50.17：COMPLETED-<stage> 不该被当瞬态清——它是完成信号，否则 race-recovery 之后
  // 卡片可能被下一轮误判未完成。
  it('does NOT include COMPLETED-<stage> as transient', () => {
    const plan = planOrphanRecovery({ workers: {} }, adapter);
    expect(plan.transientLabels.has('COMPLETED-develop')).toBe(false);
  });
});

describe('resetWorkerSlot', () => {
  it('clears all transient fields', () => {
    const slot = {
      status: 'active',
      seq: 17,
      branch: 'feature/foo',
      worktree: '/tmp/wt',
      claimedAt: '2026-04-23T16:30:35.507Z',
      lastHeartbeat: '2026-04-23T16:31:00.000Z',
      pid: 12345,
      sessionId: 'sess-abc',
    };
    resetWorkerSlot(slot);
    expect(slot.status).toBe('idle');
    expect(slot.seq).toBeNull();
    expect(slot.branch).toBeNull();
    expect(slot.worktree).toBeNull();
    expect(slot.claimedAt).toBeNull();
    expect(slot.lastHeartbeat).toBeNull();
    expect(slot.pid).toBeNull();
    expect(slot.sessionId).toBeNull();
  });

  it('only touches pid / sessionId when those keys already exist', () => {
    const slot: Record<string, unknown> = { status: 'active', seq: 5 };
    resetWorkerSlot(slot);
    expect('pid' in slot).toBe(false);
    expect('sessionId' in slot).toBe(false);
  });
});
