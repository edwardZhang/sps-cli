/**
 * Phase 0 characterization — /api/projects/:project/workers + /api/workers/all 主线
 *
 * 锁定 v0.49.16 worker 查询行为，含 marker 文件名（worker-worker-N-current.json 双前缀）、
 * 状态机（idle / starting / running / stuck / crashed）、卡片反查。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  destroyTestProject,
  seedCard,
  seedWorkerMarker,
  type TestProjectFixture,
} from '../helpers/testProject';
import { buildTestApp, type TestAppHandle } from '../helpers/testServer';

describe('E2E /api/projects/:project/workers', () => {
  let fx: TestProjectFixture;
  let prevHome: string | undefined;
  let app: TestAppHandle;

  beforeEach(async () => {
    prevHome = process.env.HOME;
    fx = createTestProject({ project: 'worker-test' });
    process.env.HOME = fx.home;
    app = await buildTestApp();
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    destroyTestProject(fx);
  });

  it('GET /workers 空项目返回空数组', async () => {
    const res = await app.req('/api/projects/worker-test/workers');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it('GET /workers 读取 marker 文件（双前缀文件名）', async () => {
    const seq = await seedCard(fx, '某张卡');
    seedWorkerMarker(fx, 1, `md-${seq}`, 'develop', { pid: 999999 });
    const res = await app.req('/api/projects/worker-test/workers');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: Array<{ slot: number; state: string; card: { seq: number; title: string } | null }>;
    };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.slot).toBe(1);
    expect(body.data[0]?.card?.seq).toBe(seq);
    expect(body.data[0]?.card?.title).toBe('某张卡');
  });

  it('GET /workers pid 死 + 有 card → state=crashed', async () => {
    const seq = await seedCard(fx, 'crashed-card');
    seedWorkerMarker(fx, 1, `md-${seq}`, 'develop', { pid: 999999 });
    const res = await app.req('/api/projects/worker-test/workers');
    const body = (await res.json()) as { data: Array<{ state: string }> };
    expect(body.data[0]?.state).toBe('crashed');
  });

  it('GET /workers/:slot 返回 detail 含 markerData + recentLogs', async () => {
    const seq = await seedCard(fx, 'detail-card');
    seedWorkerMarker(fx, 1, `md-${seq}`, 'develop', { pid: 999999, sessionId: 'sess-abc' });
    const res = await app.req('/api/projects/worker-test/workers/1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      slot: number;
      markerPath: string;
      markerData: { cardId: string; stage: string };
      recentLogs: unknown[];
    };
    expect(body.slot).toBe(1);
    expect(body.markerData.cardId).toBe(`md-${seq}`);
    expect(body.markerData.stage).toBe('develop');
    expect(body.markerPath).toContain('worker-worker-1-current.json');
  });

  it('GET /workers/:slot 404 没 marker', async () => {
    const res = await app.req('/api/projects/worker-test/workers/1');
    expect(res.status).toBe(404);
  });

  it('GET /workers/:slot 422 非法 slot', async () => {
    const res = await app.req('/api/projects/worker-test/workers/0');
    expect(res.status).toBe(422);
  });
});

describe('E2E /api/workers/all (aggregate)', () => {
  let fx: TestProjectFixture;
  let prevHome: string | undefined;
  let app: TestAppHandle;

  beforeEach(async () => {
    prevHome = process.env.HOME;
    fx = createTestProject({ project: 'agg-test' });
    process.env.HOME = fx.home;
    app = await buildTestApp();
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    destroyTestProject(fx);
  });

  it('GET /all 空返回三段空', async () => {
    const res = await app.req('/api/workers/all');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      alerts: unknown[];
      active: unknown[];
      capacity: Array<{ project: string; total: number }>;
    };
    expect(body.alerts).toEqual([]);
    expect(body.active).toEqual([]);
    expect(body.capacity).toHaveLength(1);
    expect(body.capacity[0]?.project).toBe('agg-test');
    expect(body.capacity[0]?.total).toBe(0);
  });

  it('GET /all crashed worker 进入 alerts', async () => {
    const seq = await seedCard(fx, 'card-x');
    seedWorkerMarker(fx, 1, `md-${seq}`, 'develop', { pid: 999999 });
    const res = await app.req('/api/workers/all');
    const body = (await res.json()) as {
      alerts: Array<{ project: string; slot: number; state: string }>;
      capacity: Array<{ crashed: number }>;
    };
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0]?.project).toBe('agg-test');
    expect(body.alerts[0]?.state).toBe('crashed');
    expect(body.capacity[0]?.crashed).toBe(1);
  });
});
