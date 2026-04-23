/**
 * @module        test/e2e/helpers/testServer
 * @description   Phase 0 characterization 用：构造 Hono app，挂载所有 /api 路由
 *
 * 不启真 HTTP server —— 用 Hono 的 app.request() 直接驱动，零网络、全同步。
 * E2E 要断言的是"路由接了哪些请求、返回什么 JSON"，和真端口行为等价。
 */
import { Hono } from 'hono';
import { vi } from 'vitest';

export interface TestAppHandle {
  app: Hono;
  /** fetch-like 接口，自动拼 /api 前缀 */
  req: (
    path: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ) => Promise<Response>;
}

/**
 * 构造含全部路由的测试 app。
 * 必须在调用前设置 process.env.HOME 到 fake 目录，因为路由模块里有 top-level HOME 常量。
 * 使用 vi.resetModules() + 动态 import 确保 HOME 被重读。
 */
export async function buildTestApp(): Promise<TestAppHandle> {
  vi.resetModules();

  const { createCardsRoute } = await import('../../../src/console-server/routes/cards.js');
  const { createProjectsRoute } = await import('../../../src/console-server/routes/projects.js');
  const { createWorkersRoute, createWorkersAggregateRoute } = await import(
    '../../../src/console-server/routes/workers.js'
  );
  const { createSkillsRoute } = await import('../../../src/console-server/routes/skills.js');
  const { createLogsRoute } = await import('../../../src/console-server/routes/logs.js');
  const { createPipelineRoute } = await import('../../../src/console-server/routes/pipeline.js');
  const { createSystemRoute } = await import('../../../src/console-server/routes/system.js');
  const { Logger } = await import('../../../src/core/logger.js');

  const log = new Logger('test');

  const app = new Hono();
  app.route('/api/projects', createProjectsRoute());
  app.route('/api/projects', createCardsRoute());
  app.route('/api/projects', createWorkersRoute());
  app.route('/api/projects', createPipelineRoute(log));
  app.route('/api/workers', createWorkersAggregateRoute());
  app.route('/api/skills', createSkillsRoute());
  app.route('/api/logs', createLogsRoute(log));
  app.route('/api/system', createSystemRoute('test-version', new Date()));

  const req: TestAppHandle['req'] = (path, init = {}) => {
    const method = init.method ?? 'GET';
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    let body: string | undefined;
    if (init.body !== undefined) {
      body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
      if (!headers['Content-Type'] && typeof init.body !== 'string') {
        headers['Content-Type'] = 'application/json';
      }
    }
    return app.request(path.startsWith('/') ? path : `/${path}`, { method, headers, body });
  };

  return { app, req };
}
