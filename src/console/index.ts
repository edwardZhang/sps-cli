/**
 * @module        console
 * @description   Hono HTTP server + SSE + chokidar watchers —— SPS Console 后端
 *
 * @role          server
 * @layer         console
 * @boundedContext console
 *
 * 启动流程（v0.50+）：
 *   1. 选端口（默认 4311，冲突自动递增）
 *   2. 构造 ServiceContainer（注入 SseEventBus + NodeFileSystem + 各 Executor）
 *   3. 注册路由（/api/*） —— 每条 route 依赖 container 里的 service
 *   4. 启动 chokidar watchers（infra/chokidarWatchers）—— 发 DomainEvent 到 bus
 *   5. 返回 server handle + cleanup 函数
 *
 * v0.49 的 spawn CLI 逻辑全部移到 services/executors.ts 的 Default*Executor 里。
 * 本文件不再调 spawnCliSync。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type ServerType, serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Logger } from '../core/logger.js';
import { startChokidarWatchers, type WatcherHandles } from '../infra/chokidarWatchers.js';
import { SseEventBus } from '../infra/sseBus.js';
import { createContainer } from '../services/container.js';
import { createCardsRoute } from './routes/cards.js';
import { createChatRoute, createChatStreamRoute } from './routes/chat.js';
import { createLogsRoute, createLogsStreamRoute } from './routes/logs.js';
import { createPipelineRoute } from './routes/pipeline.js';
import { createProjectsRoute } from './routes/projects.js';
import { createSkillsRoute } from './routes/skills.js';
import { createSystemRoute } from './routes/system.js';
import { createWorkersAggregateRoute, createWorkersRoute } from './routes/workers.js';
import { createProjectStreamRoute } from './sse/projectStream.js';

const HOME = process.env.HOME || '/home/coral';
const CORAL_ROOT = resolve(HOME, '.coral');
const __dirname = dirname(fileURLToPath(import.meta.url));

export interface ConsoleServerOptions {
  port: number;
  host: string;
  dev: boolean;
  version: string;
  log: Logger;
}

export interface ConsoleServerHandle {
  server: ServerType;
  close: () => Promise<void>;
}

function findConsoleAssetsDir(): string | null {
  const a = resolve(__dirname, '..', '..', 'console-assets');
  if (existsSync(resolve(a, 'index.html'))) return a;
  const b = resolve(__dirname, '..', 'console-assets');
  if (existsSync(resolve(b, 'index.html'))) return b;
  const c = resolve(__dirname, '..', '..', 'console', 'dist');
  if (existsSync(resolve(c, 'index.html'))) return c;
  return null;
}

export async function startConsoleServer(
  opts: ConsoleServerOptions,
): Promise<ConsoleServerHandle> {
  const { port, host, dev, version, log } = opts;
  const startedAt = new Date();

  // ─── Service container ─────────────────────────────────────────────
  //  - SseEventBus 给所有 service 发 DomainEvent
  //  - Default*Executor 在 container 里默认装好（Phase 3a）
  const bus = new SseEventBus();
  const services = createContainer({
    events: bus,
    systemMeta: { version, startedAt },
  });

  const app = new Hono();

  // 中间件
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    log.info(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
  });

  if (dev) {
    app.use(
      '/api/*',
      cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }),
    );
    app.use(
      '/stream/*',
      cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }),
    );
  }

  // ─── API 路由（每条挂对应 service） ─────────────────────────────────
  app.route(
    '/api/projects',
    createProjectsRoute({ projects: services.projects, pipelines: services.pipelines }),
  );
  app.route(
    '/api/projects',
    createCardsRoute({
      cards: services.cards,
      workers: services.workers,
      pipelines: services.pipelines,
    }),
  );
  app.route('/api/projects', createPipelineRoute(services.pipelines));
  app.route('/api/projects', createWorkersRoute(services.workers));
  app.route('/api/workers', createWorkersAggregateRoute(services.workers));
  app.route('/api/logs', createLogsRoute(services.logs));
  app.route('/api/skills', createSkillsRoute(services.skills));
  app.route('/api/system', createSystemRoute(services.system));
  app.route('/api/chat', createChatRoute(log, services.chat));

  // ─── SSE ─────────────────────────────────────────────────────────────
  app.route('/stream/projects', createProjectStreamRoute(bus));
  app.route('/stream/logs', createLogsStreamRoute(log));
  app.route('/stream/chat', createChatStreamRoute());

  app.get('/stream/heartbeat', async (c) => {
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache');
    c.header('Connection', 'keep-alive');
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const send = () => {
          if (closed) return;
          controller.enqueue(
            enc.encode(
              `event: server.heartbeat\ndata: ${JSON.stringify({ ts: Date.now(), version })}\n\n`,
            ),
          );
        };
        send();
        const interval = setInterval(send, 10_000);
        c.req.raw.signal?.addEventListener('abort', () => {
          closed = true;
          clearInterval(interval);
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        });
      },
    });
    return new Response(stream);
  });

  app.onError((err, c) => {
    log.error(`Unhandled error: ${err.message}\n${err.stack || ''}`);
    return c.json(
      {
        type: 'internal',
        title: 'Internal Server Error',
        status: 500,
        detail: err.message,
      },
      500,
    );
  });

  // ─── Static assets + SPA fallback ──────────────────────────────────
  const assetsDir = dev ? null : findConsoleAssetsDir();
  if (!dev && assetsDir) {
    const relativeRoot = assetsDir.replace(process.cwd() + '/', './');
    app.use('/*', serveStatic({ root: relativeRoot }));
    app.get('/*', async (c) => {
      const indexPath = resolve(assetsDir, 'index.html');
      return c.html(readFileSync(indexPath, 'utf-8'));
    });
    log.info(`Serving static assets from ${assetsDir}`);
  } else if (!dev && !assetsDir) {
    app.get('/', (c) =>
      c.text('[sps console] Frontend not built. Run: cd console && npm run build', 503),
    );
  } else {
    app.get('/', (c) => c.redirect('http://localhost:5173'));
  }

  const server = serve({ fetch: app.fetch, port, hostname: host });

  // ─── Watchers —— 新 infra/chokidarWatchers，发 DomainEvent 到 bus ───
  let watcherHandles: WatcherHandles | null = null;
  try {
    watcherHandles = startChokidarWatchers({ coralRoot: CORAL_ROOT, bus });
    log.info('watchers started: cards + markers + pipeline-poller (via DomainEventBus)');
  } catch (err) {
    log.warn(`watcher setup failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const close = async (): Promise<void> => {
    if (watcherHandles) await watcherHandles.close();

    const s = server as unknown as {
      closeAllConnections?: () => void;
      closeIdleConnections?: () => void;
    };
    try {
      s.closeIdleConnections?.();
      s.closeAllConnections?.();
    } catch {
      /* ignore */
    }

    await Promise.race([
      new Promise<void>((r) => {
        server.close(() => r());
      }),
      new Promise<void>((r) => setTimeout(r, 2000)),
    ]);
    bus.clearHistory();
  };

  return { server, close };
}
