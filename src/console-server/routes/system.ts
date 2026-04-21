/**
 * @module        console-server/routes/system
 * @description   /api/system/info —— 版本、运行时、启动时间
 */
import { Hono } from 'hono';

export function createSystemRoute(version: string, startedAt: Date): Hono {
  const app = new Hono();

  app.get('/info', (c) => {
    return c.json({
      version,
      nodeVersion: process.version,
      startedAt: startedAt.toISOString(),
      uptimeMs: Date.now() - startedAt.getTime(),
      platform: process.platform,
    });
  });

  return app;
}
