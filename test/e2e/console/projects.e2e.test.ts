/**
 * Phase 0 characterization — /api/projects 主线
 *
 * 锁定 v0.49.16 的对外行为。任何改动都要走重构路径，不允许在不更新这个测试的前提下改。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestProject, destroyTestProject, seedWorkerMarker, type TestProjectFixture } from '../helpers/testProject';
import { buildTestApp, type TestAppHandle } from '../helpers/testServer';

describe('E2E /api/projects', () => {
  let fx: TestProjectFixture;
  let prevHome: string | undefined;
  let app: TestAppHandle;

  beforeEach(async () => {
    prevHome = process.env.HOME;
    fx = createTestProject({ project: 'alpha' });
    process.env.HOME = fx.home;
    app = await buildTestApp();
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    destroyTestProject(fx);
  });

  it('GET / 返回项目列表（只有一个 alpha）', async () => {
    const res = await app.req('/api/projects');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ name: string; repoDir: string | null }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.name).toBe('alpha');
  });

  it('GET / 包含 cards/workers/pipelineStatus 字段 shape', async () => {
    const res = await app.req('/api/projects');
    const body = (await res.json()) as {
      data: Array<{
        name: string;
        cards: { total: number; inprogress: number; done: number };
        workers: { total: number; active: number };
        pipelineStatus: string;
      }>;
    };
    const p = body.data[0];
    expect(p?.cards).toEqual({ total: 0, inprogress: 0, done: 0 });
    expect(p?.workers).toEqual({ total: 0, active: 0 });
    expect(['idle', 'running', 'stopping', 'error']).toContain(p?.pipelineStatus);
  });

  it('GET / 把 marker 文件计入 workers.total', async () => {
    seedWorkerMarker(fx, 1, 'md-1', 'develop', { pid: 999999 });
    const res = await app.req('/api/projects');
    const body = (await res.json()) as { data: Array<{ workers: { total: number; active: number } }> };
    expect(body.data[0]?.workers.total).toBe(1);
  });

  it('GET /:name 返回单项目详情', async () => {
    const res = await app.req('/api/projects/alpha');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; pmBackend: string };
    expect(body.name).toBe('alpha');
    expect(body.pmBackend).toBe('markdown');
  });

  it('GET /:name 不存在返回 404 + problem shape', async () => {
    const res = await app.req('/api/projects/nonexistent');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { type: string; status: number };
    expect(body.type).toBe('not-found');
    expect(body.status).toBe(404);
  });

  it('GET /:name/conf 返回 content + etag', async () => {
    const res = await app.req('/api/projects/alpha/conf');
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBeTruthy();
    const body = (await res.json()) as { content: string; etag: string };
    expect(body.content).toContain('PROJECT_NAME="alpha"');
    expect(body.etag).toMatch(/^[0-9a-f]{16}$/);
  });

  it('PATCH /:name/conf 需要 etag', async () => {
    const res = await app.req('/api/projects/alpha/conf', {
      method: 'PATCH',
      body: { content: 'export PROJECT_NAME="alpha"\n' },
    });
    expect(res.status).toBe(422);
  });

  it('PATCH /:name/conf etag 不匹配返回 409', async () => {
    const res = await app.req('/api/projects/alpha/conf', {
      method: 'PATCH',
      body: { content: 'export X=1\n', etag: 'deadbeefdeadbeef' },
    });
    expect(res.status).toBe(409);
  });

  it('GET /:name/pipelines 返回 active + available', async () => {
    const res = await app.req('/api/projects/alpha/pipelines');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: string | null; available: unknown[] };
    expect(body).toHaveProperty('active');
    expect(body).toHaveProperty('available');
  });
});
