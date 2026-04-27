/**
 * @module        console/routes/projects
 * @description   Project REST —— 全走 ProjectService + PipelineService (yaml CRUD)
 *
 * @layer         console
 */
import { Hono } from 'hono';
import type { PipelineService } from '../../services/PipelineService.js';
import type { ProjectService } from '../../services/ProjectService.js';
import { toHttpStatus, toProblemJson } from '../../shared/errors.js';
import { sendNoContent, sendResult } from '../lib/resultToJson.js';

export interface ProjectsRouteDeps {
  projects: ProjectService;
  pipelines: PipelineService;
}

export function createProjectsRoute(deps: ProjectsRouteDeps): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const r = await deps.projects.list();
    if (!r.ok) return sendResult(c, r);
    return c.json({ data: r.value });
  });

  app.get('/:name', async (c) => {
    return sendResult(c, await deps.projects.get(c.req.param('name')));
  });

  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | {
          name?: string;
          projectDir?: string;
          enableGit?: boolean;
          enableWiki?: boolean;
          mergeBranch?: string;
          maxWorkers?: string;
          gitlabProject?: string;
          gitlabProjectId?: string;
          matrixRoomId?: string;
          ackTimeoutMin?: string;
        }
      | null;
    if (!body?.name || !/^[a-zA-Z0-9_-]+$/.test(body.name)) {
      return c.json(
        { type: 'validation', title: 'invalid name', status: 422, detail: 'name must match [a-zA-Z0-9_-]+' },
        422,
      );
    }
    if (!body.projectDir) {
      return c.json({ type: 'validation', title: 'projectDir required', status: 422 }, 422);
    }
    // v0.50.24：ackTimeoutMin (分钟) → ackTimeoutS (秒)
    const ackMin = Number.parseInt(body.ackTimeoutMin ?? '5', 10);
    const ackTimeoutS = Number.isFinite(ackMin) && ackMin > 0 ? ackMin * 60 : 300;
    const r = await deps.projects.create({
      name: body.name,
      projectDir: body.projectDir,
      enableGit: body.enableGit !== false, // 默认 true
      enableWiki: body.enableWiki === true, // 默认 false（v0.51.0）
      mergeBranch: body.mergeBranch || 'main',
      maxWorkers: body.maxWorkers || '1',
      gitlabProject: body.gitlabProject,
      gitlabProjectId: body.gitlabProjectId,
      matrixRoomId: body.matrixRoomId,
      ackTimeoutS,
    });
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    return c.json(r.value, 201);
  });

  app.delete('/:name', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { includeClaudeDir?: boolean }
      | null;
    const r = await deps.projects.delete(c.req.param('name'), {
      includeClaudeDir: body?.includeClaudeDir,
    });
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    return c.json(r.value);
  });

  // ─── conf ───────────────────────────────────────────────────────────

  app.get('/:name/conf', async (c) => {
    const r = await deps.projects.readConf(c.req.param('name'));
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    c.header('ETag', r.value.etag);
    return c.json(r.value);
  });

  app.patch('/:name/conf', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { content?: string; etag?: string }
      | null;
    if (!body || typeof body.content !== 'string') {
      return c.json({ type: 'validation', title: 'content required', status: 422 }, 422);
    }
    const etag = body.etag ?? c.req.header('If-Match');
    if (!etag) {
      return c.json({ type: 'validation', title: 'etag or If-Match required', status: 422 }, 422);
    }
    const r = await deps.projects.writeConf(c.req.param('name'), body.content, etag);
    if (!r.ok) {
      const problem = toProblemJson(r.error);
      if (r.error.code === 'CONF_ETAG_MISMATCH' && r.error.details?.currentEtag) {
        problem.currentEtag = r.error.details.currentEtag;
      }
      return c.json(problem, toHttpStatus(r.error) as 400);
    }
    c.header('ETag', r.value.etag);
    return c.json({ etag: r.value.etag });
  });

  // ─── pipelines yaml CRUD ─────────────────────────────────────────────

  app.get('/:name/pipelines', async (c) => {
    return sendResult(c, await deps.pipelines.listPipelines(c.req.param('name')));
  });

  app.get('/:name/pipelines/:file', async (c) => {
    const r = await deps.pipelines.readPipeline(c.req.param('name'), c.req.param('file'));
    if (!r.ok) return sendResult(c, r);
    c.header('ETag', r.value.etag);
    return c.json(r.value);
  });

  app.patch('/:name/pipelines/:file', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { content?: string; etag?: string }
      | null;
    if (!body || typeof body.content !== 'string') {
      return c.json({ type: 'validation', title: 'content required', status: 422 }, 422);
    }
    const etag = body.etag ?? c.req.header('If-Match');
    if (!etag) {
      return c.json({ type: 'validation', title: 'etag required', status: 422 }, 422);
    }
    const r = await deps.pipelines.writePipeline(
      c.req.param('name'),
      c.req.param('file'),
      body.content,
      etag,
    );
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    return c.json({ etag: r.value.etag });
  });

  app.post('/:name/pipelines', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { name?: string; template?: 'blank' | 'sample' | 'active' }
      | null;
    if (!body?.name) {
      return c.json({ type: 'validation', title: 'name required', status: 422 }, 422);
    }
    const r = await deps.pipelines.createPipeline(c.req.param('name'), {
      name: body.name,
      template: body.template,
    });
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    return c.json(r.value, 201);
  });

  app.delete('/:name/pipelines/:file', async (c) => {
    return sendNoContent(
      c,
      await deps.pipelines.deletePipeline(c.req.param('name'), c.req.param('file')),
    );
  });

  app.put('/:name/pipeline', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { pipeline?: string } | null;
    if (!body?.pipeline) {
      return c.json({ type: 'validation', title: 'pipeline required', status: 422 }, 422);
    }
    const r = await deps.pipelines.switchActive(c.req.param('name'), body.pipeline);
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    return c.json(r.value);
  });

  return app;
}
