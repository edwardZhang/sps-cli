/**
 * @module        console-server/routes/projects
 * @description   /api/projects[/:name] —— 读 ~/.coral/projects 下每个 conf，返回项目列表 / 详情
 *
 * @role          route
 * @layer         console-server
 * @boundedContext console
 */
import { Hono } from 'hono';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

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
    repoDir: conf.REPO_DIR || null,
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

  return app;
}
