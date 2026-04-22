/**
 * @module        console-server/routes/workers
 * @description   Worker slot 列表 + kill/launch
 */
import { Hono } from 'hono';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { spawnCliSync } from '../lib/spawnCli.js';

const HOME = process.env.HOME || '/home/coral';

interface Worker {
  slot: number;
  pid: number | null;
  state: 'idle' | 'running' | 'stuck' | 'crashed';
  card: { seq: number; title: string } | null;
  stage: string | null;
  startedAt: string | null;
  runtimeMs: number | null;
  markerUpdatedAt: string | null;
}

const STUCK_THRESHOLD_MS = 5 * 60 * 1000; // 5 min 无 marker 更新 = stuck

function projectRuntimeDir(project: string): string {
  return resolve(HOME, '.coral', 'projects', project, 'runtime');
}

function isPidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseMarker(markerPath: string): { slot: number; data: Record<string, unknown> | null } | null {
  const basename = markerPath.split('/').pop() ?? '';
  const m = basename.match(/^worker-(\d+)-current\.json$/);
  if (!m) return null;
  const slot = Number.parseInt(m[1] ?? '', 10);
  if (!Number.isFinite(slot)) return null;
  try {
    const data = JSON.parse(readFileSync(markerPath, 'utf-8')) as Record<string, unknown>;
    return { slot, data };
  } catch {
    return { slot, data: null };
  }
}

function workerFromMarker(project: string, slot: number, markerPath: string): Worker {
  const now = Date.now();
  let pid: number | null = null;
  let card: Worker['card'] = null;
  let stage: string | null = null;
  let startedAt: string | null = null;
  let markerUpdatedAt: string | null = null;

  const parsed = parseMarker(markerPath);
  if (parsed?.data) {
    const d = parsed.data;
    if (typeof d.pid === 'number') pid = d.pid;
    if (typeof d.seq === 'number' && typeof d.title === 'string') {
      card = { seq: d.seq, title: d.title };
    } else if (typeof d.seq === 'number') {
      card = { seq: d.seq, title: `#${d.seq}` };
    }
    if (typeof d.stage === 'string') stage = d.stage;
    if (typeof d.startedAt === 'string') startedAt = d.startedAt;
    if (typeof d.startTime === 'string') startedAt = startedAt ?? d.startTime;
  }
  try {
    const stat = statSync(markerPath);
    markerUpdatedAt = new Date(stat.mtimeMs).toISOString();
  } catch {
    /* ignore */
  }

  const alive = isPidAlive(pid);
  const fresh = markerUpdatedAt ? now - new Date(markerUpdatedAt).getTime() < STUCK_THRESHOLD_MS : false;
  const state: Worker['state'] = alive
    ? fresh
      ? 'running'
      : 'stuck'
    : (card !== null)
      ? 'crashed'
      : 'idle';

  const runtimeMs = startedAt ? now - new Date(startedAt).getTime() : null;

  return { slot, pid, state, card, stage, startedAt, runtimeMs, markerUpdatedAt };
}

/**
 * Tail the most recent pipeline log, filter for lines tagged with worker-<slot>.
 * Used by the worker detail popover. Capped at 4MB scan + `limit` lines out.
 */
async function readWorkerLogTail(
  project: string,
  slot: number,
  limit: number,
): Promise<Array<{ ts: string | null; level: string; msg: string }>> {
  const logsDir = resolve(HOME, '.coral', 'projects', project, 'logs');
  if (!existsSync(logsDir)) return [];
  // Prefer pipeline-*.log (current pipeline run); fall back to any .log sorted by mtime
  const candidates = readdirSync(logsDir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ f, full: resolve(logsDir, f), mtime: statSync(resolve(logsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const pipeline = candidates.find((c) => c.f.startsWith('pipeline-'));
  const file = pipeline?.full ?? candidates[0]?.full;
  if (!file) return [];

  const MAX_BYTES = 4 * 1024 * 1024;
  const stat = statSync(file);
  const start = Math.max(0, stat.size - MAX_BYTES);
  const matches: Array<{ ts: string | null; level: string; msg: string }> = [];
  const slotTag = `worker-${slot}`;
  await new Promise<void>((done) => {
    const stream = createReadStream(file, { start, encoding: 'utf-8' });
    const rl = createInterface({ input: stream });
    rl.on('line', (raw) => {
      if (!raw.includes(slotTag)) return;
      const cleaned = raw.replace(/\[[0-9;]*m/g, '');
      const m = cleaned.match(
        /(\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)\s*(?:\[)?(DEBUG|INFO|WARN|WARNING|ERROR|TRACE)\]?\s*(.*)$/i,
      );
      matches.push({
        ts: m?.[1] ?? null,
        level: (m?.[2] ?? 'info').toLowerCase().replace('warning', 'warn'),
        msg: m?.[3] ?? cleaned,
      });
      if (matches.length > limit * 3) matches.splice(0, matches.length - limit * 3);
    });
    rl.on('close', () => done());
    rl.on('error', () => done());
  });
  return matches.slice(-limit);
}

function listWorkerMarkerPaths(project: string): { slot: number; path: string }[] {
  const dir = projectRuntimeDir(project);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^worker-\d+-current\.json$/.test(f))
    .map((f) => ({
      slot: Number.parseInt((f.match(/^worker-(\d+)-/) ?? ['', '0'])[1] ?? '0', 10),
      path: resolve(dir, f),
    }))
    .filter((m) => Number.isFinite(m.slot) && m.slot > 0)
    .sort((a, b) => a.slot - b.slot);
}

export function createWorkersRoute(): Hono {
  const app = new Hono();

  app.get('/:project/workers', (c) => {
    const project = c.req.param('project');
    if (!existsSync(projectRuntimeDir(project))) {
      return c.json({ data: [] });
    }
    const markers = listWorkerMarkerPaths(project);
    const workers = markers.map((m) => workerFromMarker(project, m.slot, m.path));
    return c.json({ data: workers });
  });

  /**
   * GET /api/projects/:project/workers/:slot
   *   Returns worker detail + last N log lines filtered for this worker.
   *   Used by the Console worker detail popover (v0.48).
   */
  app.get('/:project/workers/:slot', async (c) => {
    const project = c.req.param('project');
    const slot = Number.parseInt(c.req.param('slot'), 10);
    if (!Number.isFinite(slot) || slot < 1) {
      return c.json({ type: 'validation', title: 'invalid slot', status: 422 }, 422);
    }
    const runtimeDir = projectRuntimeDir(project);
    const markerPath = resolve(runtimeDir, `worker-${slot}-current.json`);
    if (!existsSync(markerPath)) {
      return c.json({ type: 'not-found', title: 'worker marker not found', status: 404 }, 404);
    }
    const worker = workerFromMarker(project, slot, markerPath);
    const markerData = parseMarker(markerPath)?.data ?? null;
    const recentLogs = await readWorkerLogTail(project, slot, 20);
    return c.json({
      ...worker,
      markerPath: markerPath.replace(HOME, '~'),
      markerData,
      recentLogs,
    });
  });

  app.post('/:project/workers/:slot/kill', async (c) => {
    const project = c.req.param('project');
    const slot = c.req.param('slot');
    const result = await spawnCliSync(['worker', 'kill', project, slot], { timeoutMs: 15_000 });
    if (result.exitCode !== 0) {
      return c.json(
        { type: 'cli-error', title: 'kill failed', status: 500, detail: result.stderr },
        500,
      );
    }
    return c.json({ ok: true });
  });

  app.post('/:project/workers/:slot/launch', async (c) => {
    const project = c.req.param('project');
    const slot = c.req.param('slot');
    const body = await c.req.json().catch(() => ({}));
    const args = ['worker', 'launch', project, slot];
    if (typeof body?.seq === 'number') args.push(String(body.seq));
    const result = await spawnCliSync(args, { timeoutMs: 15_000 });
    if (result.exitCode !== 0) {
      return c.json(
        { type: 'cli-error', title: 'launch failed', status: 500, detail: result.stderr },
        500,
      );
    }
    return c.json({ ok: true });
  });

  return app;
}
