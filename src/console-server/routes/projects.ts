/**
 * @module        console-server/routes/projects
 * @description   /api/projects[/:name] —— 读 ~/.coral/projects 下每个 conf，返回项目列表 / 详情
 *
 * @role          route
 * @layer         console-server
 * @boundedContext console
 */
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import { executeProjectInit, type ProjectInitOpts } from '../../commands/projectInit.js';

const HOME = process.env.HOME || '/home/coral';
const PROJECTS_DIR = resolve(HOME, '.coral', 'projects');

interface ProjectSummary {
  name: string;
  repoDir: string | null;
  pmBackend: string;
  agentProvider: string;
  cards: { total: number; inprogress: number; done: number };
  workers: { total: number; active: number };
  pipelineStatus: 'idle' | 'running' | 'stopping' | 'error';
  lastActivityAt: string | null;
}

function parseConf(confPath: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(confPath)) return out;
  const text = readFileSync(confPath, 'utf-8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=["']?(.*?)["']?\s*$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function countCards(cardsDir: string): ProjectSummary['cards'] {
  if (!existsSync(cardsDir)) return { total: 0, inprogress: 0, done: 0 };
  let total = 0;
  let inprogress = 0;
  let done = 0;
  const entries = readdirSync(cardsDir).filter((f) => f.endsWith('.md'));
  for (const f of entries) {
    total++;
    try {
      const raw = readFileSync(resolve(cardsDir, f), 'utf-8');
      // 极简 frontmatter 解析：抓 state
      const stateMatch = raw.match(/^state:\s*(\w+)/m);
      if (stateMatch) {
        if (stateMatch[1] === 'Inprogress') inprogress++;
        else if (stateMatch[1] === 'Done') done++;
      }
    } catch {
      /* skip broken card */
    }
  }
  return { total, inprogress, done };
}

function countActiveWorkers(runtimeDir: string): ProjectSummary['workers'] {
  if (!existsSync(runtimeDir)) return { total: 0, active: 0 };
  const markers = readdirSync(runtimeDir).filter((f) => /^worker-\d+-current\.json$/.test(f));
  let active = 0;
  const now = Date.now();
  for (const f of markers) {
    try {
      const stat = statSync(resolve(runtimeDir, f));
      // marker 近期更新（< 5min）视为活跃
      if (now - stat.mtimeMs < 5 * 60 * 1000) active++;
    } catch {
      /* ignore */
    }
  }
  return { total: markers.length, active };
}

function readProject(name: string): ProjectSummary | null {
  const dir = resolve(PROJECTS_DIR, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return null;
  const conf = parseConf(resolve(dir, 'conf'));
  const cards = countCards(resolve(dir, 'cards'));
  const workers = countActiveWorkers(resolve(dir, 'runtime'));
  // 从 pipeline.pid 或 supervisor.pid 判活
  const pipelinePidFile = resolve(dir, 'runtime', 'supervisor.pid');
  let pipelineStatus: ProjectSummary['pipelineStatus'] = 'idle';
  if (existsSync(pipelinePidFile)) {
    try {
      const pid = Number.parseInt(readFileSync(pipelinePidFile, 'utf-8').trim(), 10);
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          pipelineStatus = 'running';
        } catch {
          pipelineStatus = 'idle';
        }
      }
    } catch {
      /* ignore */
    }
  }
  // 最近活动 = runtime 目录 mtime
  let lastActivityAt: string | null = null;
  try {
    const runtimeStat = statSync(resolve(dir, 'runtime'));
    lastActivityAt = new Date(runtimeStat.mtimeMs).toISOString();
  } catch {
    /* ignore */
  }

  return {
    name,
    // conf 里的标准字段是 PROJECT_DIR（projectInit.ts 生成）；REPO_DIR 保留给老配置
    repoDir: conf.PROJECT_DIR || conf.REPO_DIR || null,
    pmBackend: conf.PM_TOOL || 'markdown',
    agentProvider: conf.AGENT_PROVIDER || 'claude',
    cards,
    workers,
    pipelineStatus,
    lastActivityAt,
  };
}

export function createProjectsRoute(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    if (!existsSync(PROJECTS_DIR)) {
      return c.json({ data: [] });
    }
    const dirs = readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    const projects = dirs.map(readProject).filter((p): p is ProjectSummary => p !== null);
    return c.json({ data: projects });
  });

  app.get('/:name', (c) => {
    const name = c.req.param('name');
    const project = readProject(name);
    if (!project) {
      return c.json(
        {
          type: 'not-found',
          title: 'Project not found',
          status: 404,
          detail: `~/.coral/projects/${name} does not exist`,
        },
        404,
      );
    }
    return c.json(project);
  });

  /**
   * POST /api/projects — Create a new project.
   *
   * Body (all strings):
   *   name             (required) project name
   *   projectDir       (required) repo path
   *   mergeBranch      (required) default "main"
   *   maxWorkers       (required) default "1"
   *   gitlabProject    (optional) e.g. "user/repo"
   *   gitlabProjectId  (optional) GitLab numeric ID
   *   matrixRoomId     (optional)
   *
   * Calls executeProjectInit in non-interactive mode; throws on conflict.
   */
  app.post('/', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | {
          name?: string;
          projectDir?: string;
          mergeBranch?: string;
          maxWorkers?: string;
          gitlabProject?: string;
          gitlabProjectId?: string;
          matrixRoomId?: string;
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
    if (existsSync(resolve(PROJECTS_DIR, body.name))) {
      return c.json(
        { type: 'conflict', title: 'project exists', status: 409, detail: body.name },
        409,
      );
    }

    const opts: ProjectInitOpts = {
      projectDir: body.projectDir,
      mergeBranch: body.mergeBranch || 'main',
      maxWorkers: body.maxWorkers || '1',
      gitlabProject: body.gitlabProject,
      gitlabProjectId: body.gitlabProjectId,
      matrixRoomId: body.matrixRoomId,
    };
    try {
      await executeProjectInit(body.name, {}, opts);
    } catch (err) {
      return c.json(
        {
          type: 'internal',
          title: 'init failed',
          status: 500,
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
    const created = readProject(body.name);
    return c.json(created, 201);
  });

  /**
   * GET /api/projects/:name/conf — Return raw conf file content + etag.
   * Etag is a SHA-256 hash of content; client must echo it in PATCH If-Match.
   */
  app.get('/:name/conf', (c) => {
    const name = c.req.param('name');
    const confPath = resolve(PROJECTS_DIR, name, 'conf');
    if (!existsSync(confPath)) {
      return c.json({ type: 'not-found', title: 'conf not found', status: 404 }, 404);
    }
    const content = readFileSync(confPath, 'utf-8');
    const etag = createHash('sha256').update(content).digest('hex').slice(0, 16);
    c.header('ETag', etag);
    return c.json({ content, etag });
  });

  /**
   * PATCH /api/projects/:name/conf — Overwrite conf file with body.content.
   *   Optimistic lock: body.etag (or If-Match header) must match current hash;
   *   mismatch returns 409 so UI can prompt "someone else edited — reload?".
   *   File permission stays 0600 (env may contain secrets).
   */
  app.patch('/:name/conf', async (c) => {
    const name = c.req.param('name');
    const confPath = resolve(PROJECTS_DIR, name, 'conf');
    if (!existsSync(confPath)) {
      return c.json({ type: 'not-found', title: 'conf not found', status: 404 }, 404);
    }
    const body = (await c.req.json().catch(() => null)) as
      | { content?: string; etag?: string }
      | null;
    if (!body || typeof body.content !== 'string') {
      return c.json({ type: 'validation', title: 'content required', status: 422 }, 422);
    }
    const ifMatch = body.etag ?? c.req.header('If-Match');
    if (!ifMatch) {
      return c.json({ type: 'validation', title: 'etag or If-Match required', status: 422 }, 422);
    }
    const current = readFileSync(confPath, 'utf-8');
    const currentEtag = createHash('sha256').update(current).digest('hex').slice(0, 16);
    if (ifMatch !== currentEtag) {
      return c.json(
        {
          type: 'conflict',
          title: 'etag mismatch',
          status: 409,
          detail: 'conf changed since you loaded it; reload and try again',
          currentEtag,
        },
        409,
      );
    }
    writeFileSync(confPath, body.content);
    try { chmodSync(confPath, 0o600); } catch { /* best effort */ }
    const newEtag = createHash('sha256').update(body.content).digest('hex').slice(0, 16);
    c.header('ETag', newEtag);
    return c.json({ etag: newEtag });
  });

  /**
   * DELETE /api/projects/:name — Remove ~/.coral/projects/<name>/ tree.
   *   Also removes repo's <repoDir>/.claude/ by default (includeClaudeDir: true).
   *   Set includeClaudeDir: false to skip.
   *   Repo itself is never touched.
   *   Refuses to delete if a pipeline is currently running.
   */
  app.delete('/:name', async (c) => {
    const name = c.req.param('name');
    const dir = resolve(PROJECTS_DIR, name);
    if (!existsSync(dir)) {
      return c.json({ type: 'not-found', title: 'Project not found', status: 404 }, 404);
    }
    const body = (await c.req.json().catch(() => null)) as
      | { includeClaudeDir?: boolean }
      | null;
    const includeClaude = body?.includeClaudeDir !== false; // default true

    // Safety: refuse if pipeline is running
    const pidFile = resolve(dir, 'runtime', 'supervisor.pid');
    if (existsSync(pidFile)) {
      try {
        const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
        if (pid > 0) {
          try {
            process.kill(pid, 0);
            return c.json(
              {
                type: 'conflict',
                title: 'pipeline running',
                status: 409,
                detail: 'Stop the pipeline before deleting the project',
              },
              409,
            );
          } catch {
            /* dead pid, safe to proceed */
          }
        }
      } catch { /* unreadable pid, skip */ }
    }

    // Collect repo path BEFORE deleting project dir (conf lives there)
    let repoDir: string | null = null;
    if (includeClaude) {
      try {
        const conf = readFileSync(resolve(dir, 'conf'), 'utf-8');
        const match = conf.match(/export\s+PROJECT_DIR=["']?([^"'\n]+)/);
        repoDir = match?.[1]?.trim() || null;
      } catch { /* best effort */ }
    }

    // Remove project tree (~/.coral/projects/<name>/)
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      return c.json(
        {
          type: 'internal',
          title: 'delete failed',
          status: 500,
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }

    // Optionally remove repo's .claude/ directory (not the repo itself)
    const claudeRemoved: { path: string; ok: boolean; error?: string }[] = [];
    if (includeClaude && repoDir) {
      const claudePath = resolve(repoDir, '.claude');
      if (existsSync(claudePath)) {
        try {
          rmSync(claudePath, { recursive: true, force: true });
          claudeRemoved.push({ path: claudePath, ok: true });
        } catch (err) {
          claudeRemoved.push({
            path: claudePath,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    return c.json({ name, claudeRemoved });
  });

  /**
   * GET /api/projects/:name/pipelines — List available pipeline yaml files.
   *   Returns { active: "project.yaml content sha", available: [{ name, isActive }] }.
   *   Active = the current project.yaml (identified by content match).
   */
  app.get('/:name/pipelines', (c) => {
    const name = c.req.param('name');
    const pipelinesDir = resolve(PROJECTS_DIR, name, 'pipelines');
    if (!existsSync(pipelinesDir)) {
      return c.json({ active: null, available: [] });
    }
    // v0.49.3: 按字母序排，保证列表显示稳定（fs readdir 顺序不保证）
    const files = readdirSync(pipelinesDir)
      .filter((f) => f.endsWith('.yaml'))
      .sort();
    const activePath = resolve(pipelinesDir, 'project.yaml');
    const activeHash = existsSync(activePath)
      ? createHash('sha256').update(readFileSync(activePath, 'utf-8')).digest('hex')
      : null;
    const available = files
      .filter((f) => f !== 'project.yaml')
      .map((f) => {
        const full = resolve(pipelinesDir, f);
        const hash = createHash('sha256').update(readFileSync(full, 'utf-8')).digest('hex');
        return { name: f, isActive: activeHash !== null && hash === activeHash };
      });
    return c.json({ active: activeHash ? 'project.yaml' : null, available });
  });

  /**
   * PUT /api/projects/:name/pipeline — Switch active pipeline.
   *   Body: { pipeline: "<filename>.yaml" }
   *   Copies <pipelinesDir>/<filename>.yaml → <pipelinesDir>/project.yaml.
   *   Refuses if pipeline is running.
   */
  app.put('/:name/pipeline', async (c) => {
    const name = c.req.param('name');
    const pipelinesDir = resolve(PROJECTS_DIR, name, 'pipelines');
    if (!existsSync(pipelinesDir)) {
      return c.json({ type: 'not-found', title: 'Project has no pipelines dir', status: 404 }, 404);
    }
    const body = (await c.req.json().catch(() => null)) as { pipeline?: string } | null;
    if (!body?.pipeline || !/^[a-zA-Z0-9_.-]+\.yaml$/.test(body.pipeline)) {
      return c.json({ type: 'validation', title: 'invalid pipeline filename', status: 422 }, 422);
    }
    if (body.pipeline === 'project.yaml') {
      return c.json(
        { type: 'validation', title: 'cannot switch to project.yaml itself', status: 422 },
        422,
      );
    }
    const src = resolve(pipelinesDir, body.pipeline);
    if (!existsSync(src)) {
      return c.json({ type: 'not-found', title: 'pipeline file not found', status: 404 }, 404);
    }

    // Safety: refuse if pipeline is running
    const pidFile = resolve(PROJECTS_DIR, name, 'runtime', 'supervisor.pid');
    if (existsSync(pidFile)) {
      try {
        const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
        if (pid > 0) {
          try {
            process.kill(pid, 0);
            return c.json(
              {
                type: 'conflict',
                title: 'pipeline running',
                status: 409,
                detail: 'Stop the pipeline before switching',
              },
              409,
            );
          } catch { /* dead pid, safe */ }
        }
      } catch { /* unreadable, skip */ }
    }

    try {
      copyFileSync(src, resolve(pipelinesDir, 'project.yaml'));
    } catch (err) {
      return c.json(
        {
          type: 'internal',
          title: 'copy failed',
          status: 500,
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
    return c.json({ activePipeline: body.pipeline });
  });

  // ── v0.49.2 Pipeline 文件 CRUD（Console Pipelines tab 编辑用）──────────

  /**
   * GET /api/projects/:name/pipelines/:file
   *   返回 { content, etag, parsed, parseError }。
   *   parsed 是 YAML 解析后的结构化对象（供前端结构化表单使用）；
   *   parse 失败时 parsed=null + parseError 描述，前端退回纯 YAML 编辑。
   */
  app.get('/:name/pipelines/:file', (c) => {
    const name = c.req.param('name');
    const file = c.req.param('file');
    if (!/^[a-zA-Z0-9_.-]+\.yaml$/.test(file)) {
      return c.json({ type: 'validation', title: 'invalid filename', status: 422 }, 422);
    }
    const filePath = resolve(PROJECTS_DIR, name, 'pipelines', file);
    if (!existsSync(filePath)) {
      return c.json({ type: 'not-found', title: 'pipeline not found', status: 404 }, 404);
    }
    const content = readFileSync(filePath, 'utf-8');
    const etag = createHash('sha256').update(content).digest('hex').slice(0, 16);
    let parsed: unknown = null;
    let parseError: string | null = null;
    try {
      parsed = YAML.parse(content);
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
    return c.json({ content, etag, parsed, parseError, isActive: file === 'project.yaml' });
  });

  /**
   * PATCH /api/projects/:name/pipelines/:file
   *   写 YAML，etag 乐观锁。保存前用 yaml.parse 做语法校验（422 如果非法）。
   *   structural schema 校验不做（让 `sps tick` 层的 loadPipelineConfig 去报更精确的错）。
   */
  app.patch('/:name/pipelines/:file', async (c) => {
    const name = c.req.param('name');
    const file = c.req.param('file');
    if (!/^[a-zA-Z0-9_.-]+\.yaml$/.test(file)) {
      return c.json({ type: 'validation', title: 'invalid filename', status: 422 }, 422);
    }
    const filePath = resolve(PROJECTS_DIR, name, 'pipelines', file);
    if (!existsSync(filePath)) {
      return c.json({ type: 'not-found', title: 'pipeline not found', status: 404 }, 404);
    }
    const body = (await c.req.json().catch(() => null)) as
      | { content?: string; etag?: string }
      | null;
    if (!body || typeof body.content !== 'string') {
      return c.json({ type: 'validation', title: 'content required', status: 422 }, 422);
    }
    const ifMatch = body.etag ?? c.req.header('If-Match');
    if (!ifMatch) {
      return c.json({ type: 'validation', title: 'etag required', status: 422 }, 422);
    }
    const current = readFileSync(filePath, 'utf-8');
    const currentEtag = createHash('sha256').update(current).digest('hex').slice(0, 16);
    if (ifMatch !== currentEtag) {
      return c.json(
        { type: 'conflict', title: 'etag mismatch', status: 409, currentEtag },
        409,
      );
    }
    // 语法校验
    try {
      YAML.parse(body.content);
    } catch (err) {
      return c.json(
        {
          type: 'validation',
          title: 'yaml parse error',
          status: 422,
          detail: err instanceof Error ? err.message : String(err),
        },
        422,
      );
    }
    writeFileSync(filePath, body.content);
    const newEtag = createHash('sha256').update(body.content).digest('hex').slice(0, 16);
    return c.json({ etag: newEtag });
  });

  /**
   * POST /api/projects/:name/pipelines
   *   新建 pipeline 文件。body: { name: "<file>.yaml", template?: "blank" | "sample" | "active" }
   *   template: blank=最小化 stage / sample=copy sample.yaml.example / active=copy project.yaml
   */
  app.post('/:name/pipelines', async (c) => {
    const name = c.req.param('name');
    const body = (await c.req.json().catch(() => null)) as
      | { name?: string; template?: 'blank' | 'sample' | 'active' }
      | null;
    if (!body?.name || !/^[a-zA-Z0-9_.-]+\.yaml$/.test(body.name)) {
      return c.json({ type: 'validation', title: 'invalid filename', status: 422 }, 422);
    }
    const pipelinesDir = resolve(PROJECTS_DIR, name, 'pipelines');
    if (!existsSync(pipelinesDir)) {
      return c.json({ type: 'not-found', title: 'project has no pipelines dir', status: 404 }, 404);
    }
    const destPath = resolve(pipelinesDir, body.name);
    if (existsSync(destPath)) {
      return c.json({ type: 'conflict', title: 'pipeline already exists', status: 409 }, 409);
    }
    const template = body.template ?? 'blank';
    let content: string;
    if (template === 'sample') {
      const src = resolve(pipelinesDir, 'sample.yaml.example');
      if (!existsSync(src)) {
        return c.json({ type: 'not-found', title: 'sample not found', status: 404 }, 404);
      }
      content = readFileSync(src, 'utf-8');
    } else if (template === 'active') {
      const src = resolve(pipelinesDir, 'project.yaml');
      if (!existsSync(src)) {
        return c.json({ type: 'not-found', title: 'active pipeline not found', status: 404 }, 404);
      }
      content = readFileSync(src, 'utf-8');
    } else {
      // blank: minimal 1-stage project-mode pipeline
      content = `mode: project\n\nstages:\n  - name: develop\n    on_complete: "move_card Done"\n    on_fail:\n      action: "label NEEDS-FIX"\n      halt: true\n`;
    }
    writeFileSync(destPath, content);
    const etag = createHash('sha256').update(content).digest('hex').slice(0, 16);
    return c.json({ name: body.name, content, etag }, 201);
  });

  /**
   * DELETE /api/projects/:name/pipelines/:file
   *   删 pipeline 文件。拒绝 project.yaml（是活动 pipeline，切换 active 再删）。
   *   sample.yaml.example 也拒绝（教学模板，重装前别删）。
   */
  app.delete('/:name/pipelines/:file', (c) => {
    const name = c.req.param('name');
    const file = c.req.param('file');
    if (!/^[a-zA-Z0-9_.-]+\.yaml(\.example)?$/.test(file)) {
      return c.json({ type: 'validation', title: 'invalid filename', status: 422 }, 422);
    }
    if (file === 'project.yaml') {
      return c.json(
        {
          type: 'conflict',
          title: 'cannot delete active pipeline',
          status: 409,
          detail: '先切到别的 pipeline 再来删',
        },
        409,
      );
    }
    if (file === 'sample.yaml.example') {
      return c.json(
        {
          type: 'conflict',
          title: 'cannot delete sample',
          status: 409,
          detail: '这是教学模板，不要删',
        },
        409,
      );
    }
    const filePath = resolve(PROJECTS_DIR, name, 'pipelines', file);
    if (!existsSync(filePath)) {
      return c.json({ type: 'not-found', title: 'pipeline not found', status: 404 }, 404);
    }
    try {
      unlinkSync(filePath);
    } catch (err) {
      return c.json(
        {
          type: 'internal',
          title: 'delete failed',
          status: 500,
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
    return c.body(null, 204);
  });

  return app;
}
