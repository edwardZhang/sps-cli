/**
 * @module        console/routes/workers
 * @description   Worker REST —— 全走 WorkerService + LogService
 *
 * @layer         console
 *
 * v0.50.17：原版 readWorkerLogTail / readAcpSessionLogTail / readLatestLogLine 搬到
 * LogService.tailWorkerSupervisorLog / tailAcpSession / (aggregate enrich) 里。
 * 此文件现在只做 HTTP 适配，不再直接读 fs 或解析日志。
 */
import { readFileSync } from 'node:fs';
import { Hono } from 'hono';
import type { LogService } from '../../services/LogService.js';
import type { WorkerService } from '../../services/WorkerService.js';
import { home, workerMarkerFile } from '../../shared/runtimePaths.js';
import { sendResult } from '../lib/resultToJson.js';

export function createWorkersRoute(workers: WorkerService, logs: LogService): Hono {
  const app = new Hono();

  app.get('/:project/workers', async (c) => {
    const r = await workers.listByProject(c.req.param('project'));
    if (!r.ok) return sendResult(c, r);
    return c.json({ data: r.value });
  });

  app.get('/:project/workers/:slot', async (c) => {
    const slot = Number.parseInt(c.req.param('slot'), 10);
    const r = await workers.getBySlot(c.req.param('project'), slot);
    if (!r.ok) return sendResult(c, r);
    const project = c.req.param('project');
    const markerPath = workerMarkerFile(project, `worker-${slot}`);
    let markerData: unknown = null;
    try {
      markerData = JSON.parse(readFileSync(markerPath, 'utf-8'));
    } catch {
      /* marker 文件可选，丢了不阻塞 */
    }
    const recentLogs = await logs.tailWorkerSupervisorLog(project, slot, 20);
    const recentOutput = await logs.tailAcpSession(project, slot, 500);
    return c.json({
      ...r.value,
      markerPath: markerPath.replace(home(), '~'),
      markerData,
      recentLogs,
      recentOutput,
    });
  });

  app.post('/:project/workers/:slot/kill', async (c) => {
    const slot = Number.parseInt(c.req.param('slot'), 10);
    return sendResult(c, await workers.kill(c.req.param('project'), slot));
  });

  app.post('/:project/workers/:slot/launch', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const seq = typeof body?.seq === 'number' ? body.seq : Number.parseInt(String(body?.seq ?? 0), 10);
    if (!Number.isInteger(seq) || seq <= 0) {
      return c.json({ type: 'validation', title: 'seq required', status: 422 }, 422);
    }
    return sendResult(c, await workers.launch(c.req.param('project'), seq));
  });

  return app;
}

export function createWorkersAggregateRoute(workers: WorkerService, logs: LogService): Hono {
  const app = new Hono();

  app.get('/all', async (c) => {
    const r = await workers.aggregate();
    if (!r.ok) return sendResult(c, r);
    const enrich = async <T extends { project: string; slot: number }>(
      list: T[],
    ): Promise<Array<T & { lastLogLine: { ts: string | null; msg: string } | null }>> => {
      const out: Array<T & { lastLogLine: { ts: string | null; msg: string } | null }> = [];
      for (const w of list) {
        out.push({ ...w, lastLogLine: await logs.latestWorkerLogLine(w.project, w.slot) });
      }
      return out;
    };
    return c.json({
      alerts: await enrich(r.value.alerts),
      active: await enrich(r.value.active),
      capacity: r.value.capacity,
    });
  });

  return app;
}
