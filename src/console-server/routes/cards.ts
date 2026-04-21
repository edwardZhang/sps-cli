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
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.title !== 'string' || !body.title.trim()) {
      return c.json(
        { type: 'validation', title: 'title required', status: 422 },
        422,
      );
    }
    const result = await spawnCliSync(['card', 'add', project, body.title], {
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0) {
      return c.json(
        { type: 'cli-error', title: 'card add failed', status: 500, detail: result.stderr },
        500,
      );
    }
    return c.json({ ok: true, output: result.stdout.trim() });
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
