/**
 * @module        console/routes/logs
 * @description   日志 REST + SSE stream
 *
 * @layer         console
 *
 * v0.50 重构：query 路径走 LogService；SSE stream 仍用 fs.watch（Delivery 专属）。
 */

import {
  createReadStream,
  existsSync,
  type FSWatcher,
  watch as fsWatch,
  readdirSync,
  statSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Hono } from 'hono';
import type { Logger } from '../../core/logger.js';
import { type LogService, parseLogLine } from '../../services/LogService.js';
import { home, logsDir, workerLogLineTag } from '../../shared/runtimePaths.js';
import { sendResult } from '../lib/resultToJson.js';

const SSE_HEARTBEAT_MS = 15_000;

export function createLogsRoute(logs: LogService): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const project = c.req.query('project');
    const workerStr = c.req.query('worker');
    const limit = Number.parseInt(c.req.query('limit') ?? '500', 10) || undefined;
    const since = c.req.query('since');
    const worker = workerStr ? Number.parseInt(workerStr, 10) : undefined;

    if (!project) {
      return sendResult(c, await logs.aggregate({ worker, limit, since }));
    }
    return sendResult(c, await logs.tail({ project, worker, limit, since }));
  });

  return app;
}

/**
 * SSE stream —— 保留原 fs.watch 逻辑，属于 Delivery 专属（service 不做实时流）。
 */
export function createLogsStreamRoute(log: Logger): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const project = c.req.query('project');
    if (!project) {
      return c.text('project required', 422);
    }
    const workerStr = c.req.query('worker');
    const worker = workerStr ? Number.parseInt(workerStr, 10) : undefined;
    const files = findLogFilesRaw(project, worker);
    const file = files[0];

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const send = (event: string, data: unknown): void => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };

        let watcher: FSWatcher | null = null;
        let lastSize = 0;
        if (file && existsSync(file)) {
          try {
            lastSize = statSync(file).size;
          } catch {
            lastSize = 0;
          }
          try {
            watcher = fsWatch(file, async () => {
              if (closed) return;
              try {
                const stat = statSync(file);
                if (stat.size <= lastSize) {
                  lastSize = stat.size;
                  return;
                }
                const newChunk: string[] = [];
                await new Promise<void>((done) => {
                  const s = createReadStream(file, {
                    start: lastSize,
                    end: stat.size,
                    encoding: 'utf-8',
                  });
                  const rl = createInterface({ input: s });
                  rl.on('line', (l) => newChunk.push(l));
                  rl.on('close', () => done());
                });
                lastSize = stat.size;
                for (const l of newChunk) {
                  if (!l.trim()) continue;
                  send('log.line', parseLogLine(l));
                }
              } catch (err) {
                log.warn(`log watch failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            });
          } catch (err) {
            log.warn(`fs.watch failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`: heartbeat ${Date.now()}\n\n`));
          } catch {
            closed = true;
          }
        }, SSE_HEARTBEAT_MS);

        send('log.init', { file: file?.replace(home(), '~') ?? null });

        c.req.raw.signal?.addEventListener('abort', () => {
          closed = true;
          watcher?.close();
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  });

  return app;
}

/** SSE 专属：扫 logs 目录找最新文件（LogService.tail 内部一样逻辑，这里 Delivery 层需要路径）。 */
function findLogFilesRaw(project: string, worker?: number): string[] {
  const dir = logsDir(project);
  if (!existsSync(dir)) return [];
  const tag = worker !== undefined ? workerLogLineTag(worker) : null;
  return readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .filter((f) => (tag ? f.includes(tag) || f.includes(`-${worker}-`) : true))
    .map((f) => resolve(dir, f))
    .sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
}
