/**
 * @module        console/routes/pipeline
 * @description   Pipeline REST —— 全走 PipelineService
 *
 * @layer         console
 */
import { Hono } from 'hono';
import type { PipelineService } from '../../services/PipelineService.js';
import { toHttpStatus, toProblemJson } from '../../shared/errors.js';
import { sendResult } from '../lib/resultToJson.js';

export function createPipelineRoute(pipelines: PipelineService): Hono {
  const app = new Hono();

  app.post('/:project/pipeline/start', async (c) => {
    const r = await pipelines.start(c.req.param('project'));
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    return c.json({ ok: true, status: r.value.status, pid: r.value.pid });
  });

  app.post('/:project/pipeline/stop', async (c) => {
    const r = await pipelines.stop(c.req.param('project'));
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    return c.json({ ok: true });
  });

  app.post('/:project/pipeline/reset', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      all?: boolean;
      cards?: number[];
    };
    const r = await pipelines.reset(c.req.param('project'), {
      all: body.all,
      cards: Array.isArray(body.cards) ? body.cards : undefined,
    });
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    return c.json({ ok: true });
  });

  app.get('/:project/pipeline/status', async (c) => {
    return sendResult(c, await pipelines.status(c.req.param('project')));
  });

  return app;
}
