/**
 * @module        test/e2e/helpers/testServer
 * @description   E2E 用：构造 Hono app，挂载所有 /api 路由（通过 service container）
 *
 * 不启真 HTTP server —— 用 Hono 的 app.request() 直接驱动。
 */
import { Hono } from 'hono';
import { vi } from 'vitest';

export interface TestAppHandle {
  app: Hono;
  req: (
    path: string,
    init?: { method?: string; body?: unknown; headers?: Record<string, string> },
  ) => Promise<Response>;
}

export async function buildTestApp(): Promise<TestAppHandle> {
  vi.resetModules();

  const { createCardsRoute } = await import('../../../src/console/routes/cards.js');
  const { createProjectsRoute } = await import('../../../src/console/routes/projects.js');
  const { createWorkersRoute, createWorkersAggregateRoute } = await import(
    '../../../src/console/routes/workers.js'
  );
  const { createSkillsRoute } = await import('../../../src/console/routes/skills.js');
  const { createLogsRoute } = await import('../../../src/console/routes/logs.js');
  const { createPipelineRoute } = await import('../../../src/console/routes/pipeline.js');
  const { createSystemRoute } = await import('../../../src/console/routes/system.js');
  const { createContainer } = await import('../../../src/services/container.js');
  const { SseEventBus } = await import('../../../src/infra/sseBus.js');

  const bus = new SseEventBus();
  const services = createContainer({ events: bus });

  const app = new Hono();
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
  app.route('/api/projects', createWorkersRoute(services.workers, services.logs));
  app.route('/api/projects', createPipelineRoute(services.pipelines));
  app.route('/api/workers', createWorkersAggregateRoute(services.workers, services.logs));
  app.route('/api/skills', createSkillsRoute(services.skills));
  app.route('/api/logs', createLogsRoute(services.logs));
  app.route('/api/system', createSystemRoute(services.system));

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
