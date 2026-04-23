/**
 * @module        console/sse/projectStream
 * @description   /stream/projects/:name —— 单项目的 card / worker / pipeline 事件流
 *
 * @layer         console
 *
 * 订阅 SseEventBus，过滤 project 匹配的 DomainEvent，以 SSE 格式写给客户端。
 * 支持 Last-Event-ID 断线补偿。
 */
import { Hono } from 'hono';
import type { SseBusEvent, SseEventBus } from '../../infra/sseBus.js';

const HEARTBEAT_MS = 15_000;

function formatSse(id: number, event: string, data: unknown): string {
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function isProjectEvent(record: SseBusEvent, project: string): boolean {
  const d = record.data as { project?: string };
  return d?.project === project;
}

export function createProjectStreamRoute(bus: SseEventBus): Hono {
  const app = new Hono();

  app.get('/:project', (c) => {
    const project = c.req.param('project');
    const lastEventId = Number.parseInt(c.req.header('last-event-id') ?? '0', 10) || 0;

    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const safeWrite = (chunk: string): void => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(chunk));
          } catch {
            closed = true;
          }
        };

        // 1. 补发断线期间的历史事件
        if (lastEventId > 0) {
          const history = bus.since(lastEventId).filter((r) => isProjectEvent(r, project));
          for (const r of history) {
            safeWrite(formatSse(r.id, r.event, r.data));
          }
        }

        // 2. 订阅实时
        const cancel = bus.subscribeRaw((record) => {
          if (!isProjectEvent(record, project)) return;
          safeWrite(formatSse(record.id, record.event, record.data));
        });

        // 3. 心跳保活
        const heartbeat = setInterval(() => {
          safeWrite(`: heartbeat ${Date.now()}\n\n`);
        }, HEARTBEAT_MS);

        // 4. 客户端断开 → 清理
        c.req.raw.signal?.addEventListener('abort', () => {
          closed = true;
          cancel();
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
        'X-Accel-Buffering': 'no',
      },
    });
  });

  return app;
}
