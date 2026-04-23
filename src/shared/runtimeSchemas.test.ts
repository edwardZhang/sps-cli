import { describe, expect, it } from 'vitest';
import {
  CardFrontmatterSchema,
  PipelineYamlSchema,
  ProjectConfSchema,
  StateJsonSchema,
  WorkerMarkerSchema,
  WorkerSlotStateSchema,
} from './runtimeSchemas.js';

describe('WorkerMarkerSchema', () => {
  it('最小字段通过', () => {
    const r = WorkerMarkerSchema.safeParse({
      cardId: 'md-1',
      stage: 'develop',
      dispatchedAt: '2026-04-23T14:00:00.000Z',
    });
    expect(r.success).toBe(true);
  });

  it('完整字段通过', () => {
    const r = WorkerMarkerSchema.safeParse({
      cardId: 'md-1',
      stage: 'develop',
      dispatchedAt: '2026-04-23T14:00:00.000Z',
      sessionId: 'sess-xyz',
      pid: 99999,
    });
    expect(r.success).toBe(true);
  });

  it('缺 cardId 拒绝', () => {
    const r = WorkerMarkerSchema.safeParse({ stage: 'develop', dispatchedAt: '2026-04-23T14:00:00.000Z' });
    expect(r.success).toBe(false);
  });

  it('cardId 空字符串拒绝', () => {
    const r = WorkerMarkerSchema.safeParse({
      cardId: '',
      stage: 'develop',
      dispatchedAt: '2026-04-23T14:00:00.000Z',
    });
    expect(r.success).toBe(false);
  });

  it('pid 负数拒绝', () => {
    const r = WorkerMarkerSchema.safeParse({
      cardId: 'md-1',
      stage: 'develop',
      dispatchedAt: '2026-04-23T14:00:00.000Z',
      pid: -1,
    });
    expect(r.success).toBe(false);
  });

  it('dispatchedAt 非 ISO 拒绝', () => {
    const r = WorkerMarkerSchema.safeParse({
      cardId: 'md-1',
      stage: 'develop',
      dispatchedAt: 'yesterday',
    });
    expect(r.success).toBe(false);
  });
});

describe('CardFrontmatterSchema', () => {
  it('最小字段通过', () => {
    const r = CardFrontmatterSchema.safeParse({ seq: 1, title: '卡片' });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.labels).toEqual([]);
      expect(r.data.skills).toEqual([]);
    }
  });

  it('title 空拒绝', () => {
    expect(CardFrontmatterSchema.safeParse({ seq: 1, title: '' }).success).toBe(false);
  });

  it('seq 负数拒绝', () => {
    expect(CardFrontmatterSchema.safeParse({ seq: -1, title: 'x' }).success).toBe(false);
  });

  it('额外字段允许（不严格）', () => {
    expect(
      CardFrontmatterSchema.safeParse({
        seq: 1,
        title: 'x',
        meta: { foo: 'bar' },
        retry_count: 3,
      }).success,
    ).toBe(true);
  });
});

describe('ProjectConfSchema', () => {
  it('完整字段通过', () => {
    const r = ProjectConfSchema.safeParse({
      PROJECT_NAME: 'x',
      PROJECT_DIR: '/home/x',
      PM_TOOL: 'markdown',
      AGENT_PROVIDER: 'claude',
      MAX_WORKERS: '1',
      MERGE_BRANCH: 'main',
    });
    expect(r.success).toBe(true);
  });

  it('缺 PROJECT_NAME 拒绝', () => {
    expect(
      ProjectConfSchema.safeParse({ PROJECT_DIR: '/x' }).success,
    ).toBe(false);
  });

  it('PM_TOOL 非法值拒绝', () => {
    expect(
      ProjectConfSchema.safeParse({
        PROJECT_NAME: 'x',
        PROJECT_DIR: '/x',
        PM_TOOL: 'jira',
      }).success,
    ).toBe(false);
  });

  it('MAX_WORKERS 非数字字符串拒绝', () => {
    expect(
      ProjectConfSchema.safeParse({
        PROJECT_NAME: 'x',
        PROJECT_DIR: '/x',
        MAX_WORKERS: 'many',
      }).success,
    ).toBe(false);
  });
});

describe('StateJsonSchema', () => {
  it('空 workers map 通过', () => {
    expect(StateJsonSchema.safeParse({ workers: {} }).success).toBe(true);
  });

  it('含一个 worker-1 slot 通过', () => {
    const r = StateJsonSchema.safeParse({
      workers: {
        'worker-1': {
          status: 'idle',
          seq: null,
          branch: null,
          worktree: null,
          claimedAt: null,
          lastHeartbeat: null,
        },
      },
    });
    expect(r.success).toBe(true);
  });

  it('非法 status 拒绝', () => {
    expect(
      WorkerSlotStateSchema.safeParse({
        status: 'zombie',
        seq: null,
        branch: null,
        worktree: null,
        claimedAt: null,
        lastHeartbeat: null,
      }).success,
    ).toBe(false);
  });
});

describe('PipelineYamlSchema', () => {
  it('最小单阶段通过', () => {
    const r = PipelineYamlSchema.safeParse({
      mode: 'project',
      stages: [{ name: 'develop' }],
    });
    expect(r.success).toBe(true);
  });

  it('空 stages 拒绝', () => {
    expect(
      PipelineYamlSchema.safeParse({ mode: 'project', stages: [] }).success,
    ).toBe(false);
  });

  it('stage 缺 name 拒绝', () => {
    expect(
      PipelineYamlSchema.safeParse({ mode: 'project', stages: [{}] }).success,
    ).toBe(false);
  });

  it('mode 非法拒绝', () => {
    expect(
      PipelineYamlSchema.safeParse({ mode: 'turbo', stages: [{ name: 'x' }] }).success,
    ).toBe(false);
  });
});
