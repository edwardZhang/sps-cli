/**
 * @module        console-server/routes/cards
 * @description   卡片相关 REST 路由
 */
import { Hono } from 'hono';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { listCards, readCard } from '../lib/cardReader.js';
import { spawnCliSync } from '../lib/spawnCli.js';

const HOME = process.env.HOME || '/home/coral';

function projectDir(name: string): string {
  return resolve(HOME, '.coral', 'projects', name);
}

function notFound(c: { json: (v: unknown, s: number) => unknown }, name: string): unknown {
  return c.json(
    { type: 'not-found', title: 'Project not found', status: 404, detail: name },
    404,
  );
}

export function createCardsRoute(): Hono {
  const app = new Hono();

  app.get('/:project/cards', (c) => {
    const project = c.req.param('project');
    const dir = projectDir(project);
    if (!existsSync(dir)) return notFound(c, project) as Response;
    const state = c.req.query('state');
    let cards = listCards(dir);
    if (state) cards = cards.filter((card) => card.state === state);
    return c.json({ data: cards });
  });

  app.get('/:project/cards/:seq', (c) => {
    const project = c.req.param('project');
    const seq = Number.parseInt(c.req.param('seq'), 10);
    const dir = projectDir(project);
    if (!existsSync(dir)) return notFound(c, project) as Response;
    const detail = readCard(dir, seq);
    if (!detail) {
      return c.json(
        {
          type: 'not-found',
          title: 'Card not found',
          status: 404,
          detail: `${project}/#${seq}`,
        },
        404,
      );
    }
    return c.json(detail);
  });

  app.post('/:project/cards', async (c) => {
    const project = c.req.param('project');
    const body = (await c.req.json().catch(() => null)) as
      | { title?: string; description?: string; skills?: string[] }
      | null;
    if (!body || typeof body.title !== 'string' || !body.title.trim()) {
      return c.json(
        { type: 'validation', title: 'title required', status: 422 },
        422,
      );
    }
    // v0.49.6: 透传 description + skills 给 sps card add
    //   cmd: sps card add <project> "<title>" ["description"] [--skill a,b]
    const args = ['card', 'add', project, body.title];
    if (body.description && body.description.trim()) {
      args.push(body.description);
    }
    if (Array.isArray(body.skills) && body.skills.length > 0) {
      const clean = body.skills
        .map((s) => String(s).trim())
        .filter((s) => /^[a-zA-Z0-9_-]+$/.test(s));
      if (clean.length > 0) {
        args.push('--skill', clean.join(','));
      }
    }
    const result = await spawnCliSync(args, { timeoutMs: 10_000 });
    if (result.exitCode !== 0) {
      return c.json(
        { type: 'cli-error', title: 'card add failed', status: 500, detail: result.stderr },
        500,
      );
    }
    return c.json({ ok: true, output: result.stdout.trim() });
  });

  /**
   * PATCH /api/projects/:project/cards/:seq
   *   Body: { state: "Backlog" | "Inprogress" | ... }
   *   用于看板拖拽换列。调 MarkdownTaskBackend.move 搬 md 文件到新 state 目录。
   */
  app.patch('/:project/cards/:seq', async (c) => {
    const project = c.req.param('project');
    const seq = c.req.param('seq');
    const body = (await c.req.json().catch(() => null)) as { state?: string } | null;
    if (!body?.state || typeof body.state !== 'string') {
      return c.json({ type: 'validation', title: 'state required', status: 422 }, 422);
    }
    // Canonical states 白名单，防手贱 / 注入
    const ALLOWED = ['Planning', 'Backlog', 'Todo', 'Inprogress', 'Review', 'QA', 'Done', 'Canceled'];
    if (!ALLOWED.includes(body.state)) {
      return c.json(
        { type: 'validation', title: 'invalid state', status: 422, detail: `allowed: ${ALLOWED.join(', ')}` },
        422,
      );
    }

    // 动态 import 避免顶层循环依赖
    try {
      const { ProjectContext } = await import('../../core/context.js');
      const { createTaskBackend } = await import('../../providers/registry.js');
      const ctx = ProjectContext.load(project);
      const backend = createTaskBackend(ctx.config);
      await backend.bootstrap();
      await backend.move(seq, body.state as 'Planning' | 'Backlog' | 'Todo' | 'Inprogress' | 'Review' | 'QA' | 'Done' | 'Canceled');
      return c.json({ ok: true, seq: Number(seq), state: body.state });
    } catch (err) {
      return c.json(
        {
          type: 'internal',
          title: 'move failed',
          status: 500,
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  app.post('/:project/cards/:seq/reset', async (c) => {
    const project = c.req.param('project');
    const seq = c.req.param('seq');
    const result = await spawnCliSync(['reset', project, '--card', seq], { timeoutMs: 30_000 });
    if (result.exitCode !== 0) {
      return c.json(
        { type: 'cli-error', title: 'card reset failed', status: 500, detail: result.stderr },
        500,
      );
    }
    return c.json({ ok: true });
  });

  app.post('/:project/cards/:seq/launch', async (c) => {
    const project = c.req.param('project');
    const seq = c.req.param('seq');
    const result = await spawnCliSync(['worker', 'launch', project, seq], { timeoutMs: 10_000 });
    if (result.exitCode !== 0) {
      return c.json(
        { type: 'cli-error', title: 'worker launch failed', status: 500, detail: result.stderr },
        500,
      );
    }
    return c.json({ ok: true });
  });

  return app;
}
