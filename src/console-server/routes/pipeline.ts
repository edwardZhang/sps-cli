/**
 * @module        console-server/routes/pipeline
 * @description   流水线控制：start / stop / reset / status
 */
import { Hono } from 'hono';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '../../core/logger.js';
import { spawnCliDetached, spawnCliSync } from '../lib/spawnCli.js';

const HOME = process.env.HOME || '/home/coral';

function projectDir(name: string): string {
  return resolve(HOME, '.coral', 'projects', name);
}

function supervisorPid(name: string): number | null {
  const pidFile = resolve(projectDir(name), 'runtime', 'supervisor.pid');
  if (!existsSync(pidFile)) return null;
  try {
    const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export function createPipelineRoute(log: Logger): Hono {
  const app = new Hono();

  app.post('/:project/pipeline/start', (c) => {
    const project = c.req.param('project');
    if (!existsSync(projectDir(project))) {
      return c.json(
        { type: 'not-found', title: 'Project not found', status: 404, detail: project },
        404,
      );
    }
    const existing = supervisorPid(project);
    if (existing) {
      return c.json({ ok: true, status: 'running', pid: existing });
    }
    // log 目录
    const logsDir = resolve(projectDir(project), 'logs');
    if (!existsSync(logsDir)) mkdirSync(logsDir, { recursive: true });
    const logPath = resolve(logsDir, `console-tick-${new Date().toISOString().slice(0, 10)}.log`);
    try {
      const child = spawnCliDetached(['tick', project], { logPath });
      log.ok(`Pipeline for "${project}" spawned (pid ${child.pid})`);
      return c.json({ ok: true, status: 'running', pid: child.pid ?? null });
    } catch (err) {
      return c.json(
        {
          type: 'spawn-error',
          title: 'Failed to start pipeline',
          status: 500,
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  });

  app.post('/:project/pipeline/stop', async (c) => {
    const project = c.req.param('project');
    const result = await spawnCliSync(['stop', project], { timeoutMs: 20_000 });
    if (result.exitCode !== 0) {
      return c.json(
        { type: 'cli-error', title: 'stop failed', status: 500, detail: result.stderr },
        500,
      );
    }
    return c.json({ ok: true, output: result.stdout.trim() });
  });

  app.post('/:project/pipeline/reset', async (c) => {
    const project = c.req.param('project');
    const body = await c.req.json().catch(() => ({}));
    const args = ['reset', project];
    if (body?.all) args.push('--all');
    else if (Array.isArray(body?.cards) && body.cards.length > 0) {
      args.push('--card', (body.cards as number[]).join(','));
    }
    const result = await spawnCliSync(args, { timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
      return c.json(
        { type: 'cli-error', title: 'reset failed', status: 500, detail: result.stderr },
        500,
      );
    }
    return c.json({ ok: true });
  });

  app.get('/:project/pipeline/status', (c) => {
    const project = c.req.param('project');
    const pid = supervisorPid(project);
    return c.json({
      status: pid ? 'running' : 'idle',
      pid,
    });
  });

  return app;
}
