/**
 * cards route tests — v0.49.6+ CRUD + PATCH。
 * 使用真实的 ProjectContext + MarkdownTaskBackend 链路（tmp HOME 隔离），
 * 避免 mock 与生产行为漂移。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

describe('cards route', () => {
  let tmpHome: string;
  let originalHome: string | undefined;
  const project = 'testproj';

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = mkdtempSync(resolve(tmpdir(), 'sps-cards-test-'));
    process.env.HOME = tmpHome;

    // 造一个最小化的 project 结构
    const pdir = resolve(tmpHome, '.coral', 'projects', project);
    mkdirSync(resolve(pdir, 'cards'), { recursive: true });
    mkdirSync(resolve(pdir, 'pipelines'), { recursive: true });
    mkdirSync(resolve(pdir, 'runtime'), { recursive: true });
    writeFileSync(resolve(pdir, 'cards', 'seq.txt'), '0\n');
    writeFileSync(
      resolve(pdir, 'conf'),
      `export PROJECT_NAME="${project}"\nexport PROJECT_DIR="${tmpHome}"\nexport PM_TOOL="markdown"\n`,
    );
    writeFileSync(
      resolve(pdir, 'pipelines', 'project.yaml'),
      `mode: project\nstages:\n  - name: develop\n    on_complete: "move_card Done"\n    on_fail:\n      action: "label NEEDS-FIX"\n      halt: true\n`,
    );
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  async function buildApp() {
    const { createCardsRoute } = await import('./cards.js');
    const { Hono } = await import('hono');
    const app = new Hono();
    app.route('/api/projects', createCardsRoute());
    return app;
  }

  // Helper: 用 MarkdownTaskBackend 直接造一张卡（避开 spawn）
  async function createCard(title: string, desc = ''): Promise<number> {
    const { ProjectContext } = await import('../../core/context.js');
    const { createTaskBackend } = await import('../../providers/registry.js');
    const ctx = ProjectContext.load(project);
    const backend = createTaskBackend(ctx.config);
    await backend.bootstrap();
    const card = await backend.create(title, desc, 'Planning');
    return Number(card.seq);
  }

  it('GET /:project/cards 返回卡片列表', async () => {
    await createCard('first card', 'desc 1');
    await createCard('second card');

    const app = await buildApp();
    const res = await app.request(`/api/projects/${project}/cards`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ seq: number; title: string; state: string }> };
    expect(body.data).toHaveLength(2);
    expect(body.data[0]?.state).toBe('Planning');
  });

  it('PATCH /:project/cards/:seq 422 当没有字段', async () => {
    const seq = await createCard('test');
    const app = await buildApp();
    const res = await app.request(`/api/projects/${project}/cards/${seq}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  it('PATCH state: Planning → Backlog 搬 md 文件', async () => {
    const seq = await createCard('move me');
    const app = await buildApp();
    const res = await app.request(`/api/projects/${project}/cards/${seq}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: 'Backlog' }),
    });
    expect(res.status).toBe(200);

    const planDir = resolve(tmpHome, '.coral', 'projects', project, 'cards', 'planning');
    const backlogDir = resolve(tmpHome, '.coral', 'projects', project, 'cards', 'backlog');
    // Old dir empty
    expect(existsSync(planDir) ? (await import('node:fs')).readdirSync(planDir).filter((f) => f.endsWith('.md')).length : 0).toBe(0);
    // New dir has the file
    const inBacklog = (await import('node:fs')).readdirSync(backlogDir);
    expect(inBacklog.some((f) => f.endsWith('.md'))).toBe(true);
  });

  it('PATCH state 拒绝非法值', async () => {
    const seq = await createCard('x');
    const app = await buildApp();
    const res = await app.request(`/api/projects/${project}/cards/${seq}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: '../etc/passwd' }),
    });
    expect(res.status).toBe(422);
  });

  it('PATCH title 改标题 + 重命名文件', async () => {
    const seq = await createCard('old title');
    const app = await buildApp();
    const res = await app.request(`/api/projects/${project}/cards/${seq}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'brand new title' }),
    });
    expect(res.status).toBe(200);
    const dir = resolve(tmpHome, '.coral', 'projects', project, 'cards', 'planning');
    const files = (await import('node:fs')).readdirSync(dir);
    // File should have new slug
    expect(files.some((f) => f.includes('brand-new-title'))).toBe(true);
    // Frontmatter updated
    const fname = files.find((f) => f.endsWith('.md'))!;
    const content = readFileSync(resolve(dir, fname), 'utf-8');
    expect(content).toContain('title: brand new title');
  });

  it('PATCH title 422 空字符串', async () => {
    const seq = await createCard('x');
    const app = await buildApp();
    const res = await app.request(`/api/projects/${project}/cards/${seq}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '   ' }),
    });
    expect(res.status).toBe(422);
  });

  it('PATCH description 替换正文描述段', async () => {
    const seq = await createCard('with desc', 'old description');
    const app = await buildApp();
    const res = await app.request(`/api/projects/${project}/cards/${seq}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: 'new updated description\n跨多行' }),
    });
    expect(res.status).toBe(200);
    const dir = resolve(tmpHome, '.coral', 'projects', project, 'cards', 'planning');
    const fname = (await import('node:fs')).readdirSync(dir).find((f) => f.endsWith('.md'))!;
    const content = readFileSync(resolve(dir, fname), 'utf-8');
    expect(content).toContain('new updated description');
    expect(content).toContain('跨多行');
    expect(content).not.toContain('old description');
    // 检查清单 / 日志段仍在
    expect(content).toContain('## 检查清单');
    expect(content).toContain('## 日志');
  });

  it('PATCH skills + labels 全量替换', async () => {
    const seq = await createCard('with tags');
    const app = await buildApp();
    const res = await app.request(`/api/projects/${project}/cards/${seq}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        skills: ['frontend', 'backend'],
        labels: ['URGENT', 'epic'],
      }),
    });
    expect(res.status).toBe(200);
    const dir = resolve(tmpHome, '.coral', 'projects', project, 'cards', 'planning');
    const fname = (await import('node:fs')).readdirSync(dir).find((f) => f.endsWith('.md'))!;
    const content = readFileSync(resolve(dir, fname), 'utf-8');
    expect(content).toContain('- frontend');
    expect(content).toContain('- backend');
    expect(content).toContain('- URGENT');
    expect(content).toContain('- epic');
  });

  it('PATCH 多字段组合 title + description + state 一次性应用', async () => {
    const seq = await createCard('before', 'old desc');
    const app = await buildApp();
    const res = await app.request(`/api/projects/${project}/cards/${seq}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'after',
        description: 'new desc',
        state: 'Backlog',
      }),
    });
    expect(res.status).toBe(200);

    const backlogDir = resolve(tmpHome, '.coral', 'projects', project, 'cards', 'backlog');
    const files = (await import('node:fs')).readdirSync(backlogDir);
    expect(files.some((f) => f.includes('after'))).toBe(true);
    const fname = files.find((f) => f.endsWith('.md'))!;
    const content = readFileSync(resolve(backlogDir, fname), 'utf-8');
    expect(content).toContain('title: after');
    expect(content).toContain('new desc');
  });
});
