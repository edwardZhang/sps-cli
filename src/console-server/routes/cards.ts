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
   *   Body: 任意字段组合（至少一个）
   *     { state?: CardState }        — 拖拽换列（搬 md 到新目录）
   *     { title?: string }           — 改标题 + 重命名文件
   *     { description?: string }     — 替换 body 的 "## 描述" 段
   *     { skills?: string[] }        — 全量替换 frontmatter.skills
   *     { labels?: string[] }        — 全量替换 frontmatter.labels
   *   按字段顺序依次应用；任何一步失败返回 500 + detail。
   */
  app.patch('/:project/cards/:seq', async (c) => {
    const project = c.req.param('project');
    const seq = c.req.param('seq');
    const body = (await c.req.json().catch(() => null)) as {
      state?: string;
      title?: string;
      description?: string;
      skills?: string[];
      labels?: string[];
    } | null;
    if (!body || Object.keys(body).length === 0) {
      return c.json({ type: 'validation', title: 'no fields to update', status: 422 }, 422);
    }

    const ALLOWED_STATES = ['Planning', 'Backlog', 'Todo', 'Inprogress', 'Review', 'QA', 'Done', 'Canceled'];
    if (body.state !== undefined && (typeof body.state !== 'string' || !ALLOWED_STATES.includes(body.state))) {
      return c.json(
        { type: 'validation', title: 'invalid state', status: 422, detail: `allowed: ${ALLOWED_STATES.join(', ')}` },
        422,
      );
    }
    if (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim())) {
      return c.json({ type: 'validation', title: 'title cannot be empty', status: 422 }, 422);
    }
    if (body.skills !== undefined && !Array.isArray(body.skills)) {
      return c.json({ type: 'validation', title: 'skills must be array', status: 422 }, 422);
    }
    if (body.labels !== undefined && !Array.isArray(body.labels)) {
      return c.json({ type: 'validation', title: 'labels must be array', status: 422 }, 422);
    }

    try {
      const { ProjectContext } = await import('../../core/context.js');
      const { createTaskBackend } = await import('../../providers/registry.js');
      const ctx = ProjectContext.load(project);
      const backend = createTaskBackend(ctx.config);
      await backend.bootstrap();

      // Apply in this order:
      //   1) title (renames file) — do early so subsequent reads find the new path
      //   2) description
      //   3) skills
      //   4) labels
      //   5) state (move, last so other edits write to the original location first)
      if (body.title !== undefined) {
        await backend.setTitle(seq, body.title);
      }
      if (body.description !== undefined) {
        await backend.setDescription(seq, body.description);
      }
      if (body.skills !== undefined) {
        await backend.setSkills(seq, body.skills.filter((s) => typeof s === 'string'));
      }
      if (body.labels !== undefined) {
        await backend.setLabels(seq, body.labels.filter((l) => typeof l === 'string'));
      }
      if (body.state !== undefined) {
        await backend.move(
          seq,
          body.state as 'Planning' | 'Backlog' | 'Todo' | 'Inprogress' | 'Review' | 'QA' | 'Done' | 'Canceled',
        );
      }
      return c.json({ ok: true, seq: Number(seq) });
    } catch (err) {
      return c.json(
        {
          type: 'internal',
          title: 'patch failed',
          status: 500,
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  app.delete('/:project/cards/:seq', async (c) => {
    const project = c.req.param('project');
    const seq = c.req.param('seq');
    const dir = projectDir(project);
    if (!existsSync(dir)) return notFound(c, project) as Response;
    try {
      const { ProjectContext } = await import('../../core/context.js');
      const { createTaskBackend } = await import('../../providers/registry.js');
      const ctx = ProjectContext.load(project);
      const backend = createTaskBackend(ctx.config);
      await backend.bootstrap();
      await backend.delete(seq);
      return c.json({ ok: true, seq: Number(seq) });
    } catch (err) {
      return c.json(
        {
          type: 'internal',
          title: 'delete failed',
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
