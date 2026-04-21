/**
 * @module        console-server
 * @description   Hono HTTP server + SSE + chokidar watchers —— SPS Console 后端
 *
 * @role          server
 * @layer         console-server
 * @boundedContext console
 *
 * 启动流程：
 *   1. 选端口（默认 4311，冲突自动递增）
 *   2. 注册路由（/api/*）+ SSE（/stream/*）+ 静态资源（dist/console-assets/）
 *   3. 启动 chokidar watchers → eventBus
 *   4. 返回 server handle + cleanup 函数
 */
import { serve, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { FSWatcher } from 'chokidar';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from '../core/logger.js';
import { createProjectsRoute } from './routes/projects.js';
import { createSystemRoute } from './routes/system.js';
import { eventBus } from './sse/eventBus.js';
import { startCardWatcher } from './watchers/cardWatcher.js';

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
  // npm install: dist/console-server/index.js → ../../console-assets
  const a = resolve(__dirname, '..', '..', 'console-assets');
  if (existsSync(resolve(a, 'index.html'))) return a;
  // dev build: workflow-cli/dist/console-server/index.js → ../console-assets
  const b = resolve(__dirname, '..', 'console-assets');
  if (existsSync(resolve(b, 'index.html'))) return b;
  // 源码运行：src/console-server → ../../console/dist (vite 输出)
  const c = resolve(__dirname, '..', '..', 'console', 'dist');
  if (existsSync(resolve(c, 'index.html'))) return c;
  return null;
}

export async function startConsoleServer(
  opts: ConsoleServerOptions,
): Promise<ConsoleServerHandle> {
  const { port, host, dev, version, log } = opts;
  const startedAt = new Date();

  const app = new Hono();

  // 中间件
  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    log.info(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms`);
  });

  // CORS：dev 模式允许 vite dev server (localhost:5173)
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

  // API 路由
  app.route('/api/projects', createProjectsRoute());
  app.route('/api/system', createSystemRoute(version, startedAt));

  // SSE heartbeat（占位，M3 加完整事件流）
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

  // 错误 handler
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

  // 静态资源 + SPA fallback（非 dev 模式）
  const assetsDir = dev ? null : findConsoleAssetsDir();
  if (!dev && assetsDir) {
    const relativeRoot = assetsDir.replace(process.cwd() + '/', './');
    app.use('/*', serveStatic({ root: relativeRoot }));
    // SPA fallback：任何未命中的路径返回 index.html
    app.get('/*', async (c) => {
      const indexPath = resolve(assetsDir, 'index.html');
      return c.html(readFileSync(indexPath, 'utf-8'));
    });
    log.info(`Serving static assets from ${assetsDir}`);
  } else if (!dev && !assetsDir) {
    app.get('/', (c) => c.text(
      '[sps console] Frontend not built. Run: cd console && npm run build',
      503,
    ));
  } else {
    // dev 模式：重定向到 vite dev server
    app.get('/', (c) => c.redirect('http://localhost:5173'));
  }

  // 启动 server
  const server = serve({ fetch: app.fetch, port, hostname: host });

  // 启动 watchers
  const watchers: FSWatcher[] = [];
  try {
    watchers.push(startCardWatcher(CORAL_ROOT));
    log.info(`cardWatcher started (${CORAL_ROOT}/projects/*/cards/*.md)`);
  } catch (err) {
    log.warn(`cardWatcher failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const close = async (): Promise<void> => {
    // 关 watchers
    await Promise.all(watchers.map((w) => w.close()));
    // 关 server
    await new Promise<void>((r) => {
      server.close(() => r());
    });
    // 清 event history
    eventBus.clearHistory();
  };

  return { server, close };
}
