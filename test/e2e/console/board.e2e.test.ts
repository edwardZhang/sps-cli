/**
 * Phase 0 characterization — /api/projects/:project/cards 主线（Board 页）
 *
 * 锁定 v0.49.16 卡片 CRUD 行为。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  destroyTestProject,
  seedCard,
  type TestProjectFixture,
} from '../helpers/testProject';
import { buildTestApp, type TestAppHandle } from '../helpers/testServer';

describe('E2E /api/projects/:project/cards', () => {
  let fx: TestProjectFixture;
  let prevHome: string | undefined;
  let app: TestAppHandle;

  beforeEach(async () => {
    prevHome = process.env.HOME;
    fx = createTestProject({ project: 'board-test' });
    process.env.HOME = fx.home;
    app = await buildTestApp();
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    destroyTestProject(fx);
  });

  it('GET /cards 空项目返回空数组', async () => {
    const res = await app.req('/api/projects/board-test/cards');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it('GET /cards 返回 seed 过的卡片', async () => {
    await seedCard(fx, 'task A');
    await seedCard(fx, 'task B');
    const res = await app.req('/api/projects/board-test/cards');
    const body = (await res.json()) as { data: Array<{ title: string; state: string }> };
    expect(body.data).toHaveLength(2);
    const titles = body.data.map((c) => c.title).sort();
    expect(titles).toEqual(['task A', 'task B']);
  });

  it('GET /cards 支持 state 过滤', async () => {
    await seedCard(fx, 'in progress task', '', 'Inprogress');
    await seedCard(fx, 'done task', '', 'Done');
    const res = await app.req('/api/projects/board-test/cards?state=Done');
    const body = (await res.json()) as { data: Array<{ state: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.state).toBe('Done');
  });

  it('GET /cards 404 项目不存在', async () => {
    const res = await app.req('/api/projects/no-such-proj/cards');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { type: string };
    expect(body.type).toBe('not-found');
  });

  it('GET /cards/:seq 返回详情含 body + checklist', async () => {
    const seq = await seedCard(fx, 'with desc', 'some description\n\n## Checklist\n- [ ] step one');
    const res = await app.req(`/api/projects/board-test/cards/${seq}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      seq: number;
      title: string;
      body: string;
      checklist: { total: number; done: number };
    };
    expect(body.seq).toBe(seq);
    expect(body.title).toBe('with desc');
    expect(body.checklist.total).toBe(1);
  });

  /**
   * v0.50.2 回归防线：detail.body 必须含全部 section（描述 / 检查清单 / 日志），
   * 不能只是 `## 描述` 段。v0.50.0 Phase 3 曾把 body 错映射成 card.desc，前端
   * 看板卡片详情的"日志"和"检查清单"两框就失效了。
   */
  it('GET /cards/:seq body 返回完整 markdown（含所有 section）', async () => {
    const seq = await seedCard(fx, 'full body', 'my desc');
    const res = await app.req(`/api/projects/board-test/cards/${seq}`);
    const body = (await res.json()) as { body: string };
    expect(body.body).toContain('## Description');
    expect(body.body).toContain('my desc');
    expect(body.body).toContain('## Checklist');
    expect(body.body).toContain('## Log');
  });

  it('GET /cards/:seq 404 seq 不存在', async () => {
    const res = await app.req('/api/projects/board-test/cards/99999');
    expect(res.status).toBe(404);
  });

  it('PATCH /cards/:seq 无字段返回 422', async () => {
    const seq = await seedCard(fx, 'card');
    const res = await app.req(`/api/projects/board-test/cards/${seq}`, {
      method: 'PATCH',
      body: {},
    });
    expect(res.status).toBe(422);
  });

  it('PATCH /cards/:seq 更新 title 持久化', async () => {
    const seq = await seedCard(fx, 'old title');
    const patchRes = await app.req(`/api/projects/board-test/cards/${seq}`, {
      method: 'PATCH',
      body: { title: 'new title' },
    });
    expect(patchRes.status).toBe(200);
    const getRes = await app.req(`/api/projects/board-test/cards/${seq}`);
    const body = (await getRes.json()) as { title: string };
    expect(body.title).toBe('new title');
  });

  it('PATCH /cards/:seq 移动 state (Planning → Backlog)', async () => {
    const seq = await seedCard(fx, 'movable');
    const patchRes = await app.req(`/api/projects/board-test/cards/${seq}`, {
      method: 'PATCH',
      body: { state: 'Backlog' },
    });
    expect(patchRes.status).toBe(200);
    const getRes = await app.req(`/api/projects/board-test/cards/${seq}`);
    const body = (await getRes.json()) as { state: string };
    expect(body.state).toBe('Backlog');
  });

  it('PATCH /cards/:seq 非法 state 返回 422', async () => {
    const seq = await seedCard(fx, 'card');
    const res = await app.req(`/api/projects/board-test/cards/${seq}`, {
      method: 'PATCH',
      body: { state: 'NotAState' },
    });
    expect(res.status).toBe(422);
  });

  it('DELETE /cards/:seq 物理删除 md 文件', async () => {
    const seq = await seedCard(fx, 'doomed');
    const delRes = await app.req(`/api/projects/board-test/cards/${seq}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    const getRes = await app.req(`/api/projects/board-test/cards/${seq}`);
    expect(getRes.status).toBe(404);
  });

  it('DELETE /cards/:seq 项目不存在返回 404', async () => {
    const res = await app.req('/api/projects/no-such-proj/cards/1', { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
