/**
 * @module        console/routes/system
 * @description   System REST —— 走 SystemService
 *
 * @layer         console
 */
import { Hono } from 'hono';
import type { SystemService } from '../../services/SystemService.js';
import { toHttpStatus, toProblemJson } from '../../shared/errors.js';
import { sendResult } from '../lib/resultToJson.js';

export function createSystemRoute(system: SystemService): Hono {
  const app = new Hono();

  app.get('/info', (c) => {
    return c.json(system.info());
  });

  app.get('/env', async (c) => {
    return sendResult(c, await system.readEnv());
  });

  app.get('/env/raw', async (c) => {
    return sendResult(c, await system.readEnvRaw());
  });

  app.patch('/env', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { content?: string; etag?: string }
      | null;
    if (!body || typeof body.content !== 'string') {
      return c.json({ type: 'validation', title: 'content required', status: 422 }, 422);
    }
    const etag = body.etag ?? c.req.header('If-Match');
    const r = await system.writeEnv(body.content, etag);
    if (!r.ok) {
      const problem = toProblemJson(r.error);
      if (r.error.code === 'ENV_ETAG_MISMATCH' && r.error.details?.currentEtag) {
        problem.currentEtag = r.error.details.currentEtag;
      }
      return c.json(problem, toHttpStatus(r.error) as 400);
    }
    return c.json(r.value);
  });

  app.get('/latest-version', async (c) => {
    return sendResult(c, await system.latestVersion());
  });

  app.post('/upgrade', async (c) => {
    const r = await system.upgrade();
    if (!r.ok) {
      const problem = toProblemJson(r.error);
      if (r.error.details?.projects) {
        problem.projects = r.error.details.projects;
      }
      return c.json(problem, toHttpStatus(r.error) as 400);
    }
    return c.json(r.value);
  });

  app.get('/doctor/all', async (c) => {
    const r = await system.doctorAll();
    if (!r.ok) return sendResult(c, r);
    return c.json({ data: r.value });
  });

  // v0.50.14：单项目真实 doctor
  app.post('/doctor/:project', async (c) => {
    const project = c.req.param('project');
    const fix = c.req.query('fix') === '1' || c.req.query('fix') === 'true';
    return sendResult(c, await system.doctorProject(project, { fix }));
  });

  /** 前端错误日志：服务 stderr only，不进 Service */
  app.post('/client-errors', async (c) => {
    const raw = await c.req.text().catch(() => '');
    if (raw.length > 8192) {
      return c.json({ type: 'validation', title: 'payload too large', status: 413 }, 413);
    }
    let body: { message?: string; stack?: string; url?: string; ua?: string; ts?: string };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ type: 'validation', title: 'invalid JSON', status: 422 }, 422);
    }
    const line = [
      `[client-error]`,
      body.ts ?? new Date().toISOString(),
      body.url ?? '-',
      body.message ?? '-',
    ].join(' ');
    process.stderr.write(line + '\n');
    if (body.stack) {
      process.stderr.write(body.stack.split('\n').map((l) => `  ${l}`).join('\n') + '\n');
    }
    return c.body(null, 204);
  });

  return app;
}
