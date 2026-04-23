/**
 * @module        console/routes/cards
 * @description   Card REST —— 全走 CardService
 *
 * @layer         console
 *
 * 响应 shape 保持和 v0.49.16 一致（Phase 0 的 E2E 验证过）：
 *   GET /cards            → { data: Card[] }
 *   GET /cards/:seq       → Card detail
 *   POST /cards           → { ok, output }（仍跟 CLI 风格）
 *   PATCH /cards/:seq     → { ok, seq }
 *   DELETE /cards/:seq    → { ok, seq }
 *   POST /cards/:seq/reset → { ok }
 *   POST /cards/:seq/launch → { ok }
 */
import { Hono } from 'hono';
import type { CardService } from '../../services/CardService.js';
import type { PipelineService } from '../../services/PipelineService.js';
import type { WorkerService } from '../../services/WorkerService.js';
import { toHttpStatus, toProblemJson } from '../../shared/errors.js';
import { sendResult } from '../lib/resultToJson.js';

export interface CardsRouteDeps {
  cards: CardService;
  workers: WorkerService;
  pipelines: PipelineService;
}

export function createCardsRoute(deps: CardsRouteDeps): Hono {
  const app = new Hono();

  app.get('/:project/cards', async (c) => {
    const state = c.req.query('state') ?? undefined;
    const r = await deps.cards.list(c.req.param('project'), state ? { state } : {});
    if (!r.ok) return sendResult(c, r);
    return c.json({ data: r.value });
  });

  app.get('/:project/cards/:seq', async (c) => {
    const seq = Number.parseInt(c.req.param('seq'), 10);
    return sendResult(c, await deps.cards.get(c.req.param('project'), seq));
  });

  app.post('/:project/cards', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { title?: string; description?: string; skills?: string[]; labels?: string[] }
      | null;
    if (!body || typeof body.title !== 'string' || !body.title.trim()) {
      return c.json(
        { type: 'validation', title: 'title required', status: 422 },
        422,
      );
    }
    const skills = Array.isArray(body.skills)
      ? body.skills.filter((s) => typeof s === 'string' && /^[a-zA-Z0-9_-]+$/.test(s))
      : undefined;
    const labels = Array.isArray(body.labels)
      ? body.labels.filter((l) => typeof l === 'string' && l.trim().length > 0)
      : undefined;
    const r = await deps.cards.create(c.req.param('project'), {
      title: body.title,
      description: body.description,
      skills,
      labels,
    });
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    return c.json({ ok: true, output: `Created card #${r.value.seq}` });
  });

  app.patch('/:project/cards/:seq', async (c) => {
    const seq = Number.parseInt(c.req.param('seq'), 10);
    const body = (await c.req.json().catch(() => null)) as
      | {
          state?: string;
          title?: string;
          description?: string;
          skills?: string[];
          labels?: string[];
        }
      | null;
    if (!body || Object.keys(body).length === 0) {
      return c.json({ type: 'validation', title: 'no fields to update', status: 422 }, 422);
    }
    const r = await deps.cards.update(c.req.param('project'), seq, body);
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    return c.json({ ok: true, seq });
  });

  app.delete('/:project/cards/:seq', async (c) => {
    const seq = Number.parseInt(c.req.param('seq'), 10);
    const r = await deps.cards.delete(c.req.param('project'), seq);
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    return c.json({ ok: true, seq });
  });

  app.post('/:project/cards/:seq/reset', async (c) => {
    const seq = Number.parseInt(c.req.param('seq'), 10);
    // Card-level reset：不启 pipeline，只做 card 状态重置。
    // Phase 0 E2E 锁定：一张 Done 卡 reset → 回 Planning；所以走 CardService.reset。
    const r = await deps.cards.reset(c.req.param('project'), seq);
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    return c.json({ ok: true });
  });

  app.post('/:project/cards/:seq/launch', async (c) => {
    const seq = Number.parseInt(c.req.param('seq'), 10);
    const r = await deps.workers.launch(c.req.param('project'), seq);
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    return c.json({ ok: true });
  });

  return app;
}
