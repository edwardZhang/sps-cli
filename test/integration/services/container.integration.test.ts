/**
 * Phase 2 集成 —— createContainer 连真 Domain（MarkdownTaskBackend + NodeFS + ProjectContext）
 * 验证整个 service graph 在 fake HOME 下工作正常。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTestProject,
  destroyTestProject,
  type TestProjectFixture,
} from '../../e2e/helpers/testProject.js';
import { createContainer } from '../../../src/services/container.js';

describe('Container integration —— 真 Domain 连通', () => {
  let fx: TestProjectFixture;
  let prev: string | undefined;

  beforeEach(() => {
    prev = process.env.HOME;
    fx = createTestProject({ project: 'integ' });
    process.env.HOME = fx.home;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = prev;
    destroyTestProject(fx);
  });

  it('ProjectService.list 返真项目', async () => {
    const c = createContainer();
    const r = await c.projects.list();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.map((p) => p.name)).toContain('integ');
    }
  });

  it('CardService.create → list 走真 MarkdownTaskBackend', async () => {
    const c = createContainer();
    const created = await c.cards.create('integ', { title: 'E2E card' });
    expect(created.ok).toBe(true);
    const listed = await c.cards.list('integ');
    if (listed.ok) {
      expect(listed.value).toHaveLength(1);
      expect(listed.value[0]?.title).toBe('E2E card');
    }
  });

  it('CardService.create + get + update + delete 全链路', async () => {
    const c = createContainer();
    const created = await c.cards.create('integ', { title: 'original', description: 'hello' });
    if (!created.ok) throw new Error('create failed');
    const seq = created.value.seq;

    const got = await c.cards.get('integ', seq);
    if (got.ok) {
      expect(got.value.title).toBe('original');
    }

    const updated = await c.cards.update('integ', seq, { title: 'new title' });
    if (updated.ok) expect(updated.value.title).toBe('new title');

    const del = await c.cards.delete('integ', seq);
    expect(del.ok).toBe(true);

    const gone = await c.cards.get('integ', seq);
    expect(gone.ok).toBe(false);
  });

  it('CardService.move 物理移动 md 文件', async () => {
    const c = createContainer();
    const created = await c.cards.create('integ', { title: 'movable' });
    if (!created.ok) throw new Error();
    const seq = created.value.seq;
    await c.cards.move('integ', seq, 'Todo');
    const r = await c.cards.get('integ', seq);
    if (r.ok) expect(r.value.state).toBe('Todo');
  });

  it('ProjectService.readConf 能读 fixture 的 conf', async () => {
    const c = createContainer();
    const r = await c.projects.readConf('integ');
    if (r.ok) {
      expect(r.value.content).toContain('PROJECT_NAME="integ"');
      expect(r.value.etag).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('PipelineService.status 空项目返 idle', async () => {
    const c = createContainer();
    const r = await c.pipelines.status('integ');
    if (r.ok) expect(r.value.status).toBe('idle');
  });

  it('PipelineService.listPipelines 列 fixture 的 project.yaml', async () => {
    const c = createContainer();
    const r = await c.pipelines.listPipelines('integ');
    if (r.ok) expect(r.value.active).toBe('project.yaml');
  });

  it('WorkerService.listByProject 空 runtime 返空', async () => {
    const c = createContainer();
    const r = await c.workers.listByProject('integ');
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('LogService.tail 无 log 返空', async () => {
    const c = createContainer();
    const r = await c.logs.tail({ project: 'integ' });
    if (r.ok) expect(r.value.data).toEqual([]);
  });

  it('SkillService.list 空 skills 返空', async () => {
    const c = createContainer();
    const r = await c.skills.list();
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('ChatService.create → list → delete 生命周期', async () => {
    const c = createContainer();
    const created = await c.chat.create({ title: 'chat integ' });
    if (!created.ok) throw new Error();
    const id = created.value.id;
    const listed = await c.chat.list();
    if (listed.ok) expect(listed.value.map((s) => s.id)).toContain(id);
    const del = await c.chat.delete(id);
    expect(del.ok).toBe(true);
    const after = await c.chat.list();
    if (after.ok) expect(after.value.map((s) => s.id)).not.toContain(id);
  });
});
