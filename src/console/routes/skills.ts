/**
 * @module        console/routes/skills
 * @description   Skill REST API —— 全走 SkillService
 *
 * @layer         console
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import type { SkillService } from '../../services/SkillService.js';
import { userSkillsDir } from '../../shared/runtimePaths.js';
import { sendNoContent, sendResult } from '../lib/resultToJson.js';

export function createSkillsRoute(skills: SkillService): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const project = c.req.query('project') ?? undefined;
    const r = await skills.list(project);
    if (!r.ok) return sendResult(c, r);
    return c.json({ data: r.value });
  });

  app.get('/:name', async (c) => {
    return sendResult(c, await skills.get(c.req.param('name')));
  });

  /**
   * reference 文件读取保留在 Delivery —— 不进 service，因为这是原始字节的透传，不是
   * 领域行为。Phase 3 这里直接读 userSkillsDir 下的文件。
   */
  app.get('/:name/references/:file', (c) => {
    const name = c.req.param('name');
    const file = c.req.param('file');
    if (!/^[a-zA-Z0-9_.-]+\.md$/.test(file)) {
      return c.json({ type: 'validation', title: 'invalid filename', status: 422 }, 422);
    }
    const refsDir = resolve(userSkillsDir(), name, 'references');
    if (!existsSync(refsDir)) {
      return c.json({ type: 'not-found', title: 'references dir not found', status: 404 }, 404);
    }
    const found = readdirSync(refsDir).find((f) => f === file);
    if (!found) {
      return c.json({ type: 'not-found', title: 'Reference not found', status: 404 }, 404);
    }
    try {
      const content = readFileSync(resolve(refsDir, file), 'utf-8');
      return c.json({ name: file, content });
    } catch (err) {
      return c.json(
        { type: 'internal', title: 'Read failed', status: 500, detail: String(err) },
        500,
      );
    }
  });

  app.post('/:name/link', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { project?: string };
    if (!body.project) {
      return c.json({ type: 'validation', title: 'project required', status: 422 }, 422);
    }
    return sendResult(c, await skills.link(c.req.param('name'), body.project));
  });

  app.delete('/:name/link', async (c) => {
    const project = c.req.query('project');
    if (!project) {
      return c.json({ type: 'validation', title: 'project required', status: 422 }, 422);
    }
    return sendNoContent(c, await skills.unlink(c.req.param('name'), project));
  });

  app.post('/:name/freeze', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { project?: string };
    if (!body.project) {
      return c.json({ type: 'validation', title: 'project required', status: 422 }, 422);
    }
    return sendResult(c, await skills.freeze(c.req.param('name'), body.project));
  });

  app.post('/:name/unfreeze', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { project?: string };
    if (!body.project) {
      return c.json({ type: 'validation', title: 'project required', status: 422 }, 422);
    }
    return sendResult(c, await skills.unfreeze(c.req.param('name'), body.project));
  });

  app.post('/sync', async (c) => {
    return sendResult(c, await skills.sync());
  });

  app.get('/links/:project', async (c) => {
    const r = await skills.list(c.req.param('project'));
    if (!r.ok) return sendResult(c, r);
    return c.json({
      data: r.value.filter((s) => s.stateInProject && s.stateInProject !== 'absent'),
    });
  });

  return app;
}
