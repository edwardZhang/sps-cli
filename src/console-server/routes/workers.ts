/**
 * @module        console-server/routes/workers
 * @description   Worker slot 列表 + kill/launch
 */
import { Hono } from 'hono';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { readCard } from '../lib/cardReader.js';
import { spawnCliSync } from '../lib/spawnCli.js';

const HOME = process.env.HOME || '/home/coral';

export type WorkerState = 'idle' | 'starting' | 'running' | 'stuck' | 'crashed';

interface Worker {
  slot: number;
  pid: number | null;
  state: WorkerState;
  card: { seq: number; title: string } | null;
  stage: string | null;
  startedAt: string | null;
  runtimeMs: number | null;
  markerUpdatedAt: string | null;
}

const STUCK_THRESHOLD_MS = 5 * 60 * 1000;   // 5 min 无 marker 更新 = stuck
const ACK_TIMEOUT_MS = 60 * 1000;            // 60s dispatch 但无 STARTED-* 标签 = 仍在 starting

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

  // v0.49.15：marker schema 是 { cardId: "md-<seq>", stage, dispatchedAt, pid, sessionId }
  // —— 以前按 seq/title/startedAt 读永远空，导致 UI 永远显示 idle。
  const parsed = parseMarker(markerPath);
  if (parsed?.data) {
    const d = parsed.data;
    if (typeof d.pid === 'number') pid = d.pid;
    if (typeof d.cardId === 'string') {
      const m = d.cardId.match(/^(?:md-)?(\d+)$/);
      if (m) {
        const seq = Number.parseInt(m[1] ?? '', 10);
        if (Number.isFinite(seq)) {
          let title = `#${seq}`;
          try {
            const detail = readCard(resolve(HOME, '.coral', 'projects', project), seq);
            if (detail?.title) title = detail.title;
          } catch { /* cardReader 失败就用 #seq */ }
          card = { seq, title };
        }
      }
    }
    if (typeof d.stage === 'string') stage = d.stage;
    if (typeof d.dispatchedAt === 'string') startedAt = d.dispatchedAt;
    // 兼容老字段（旧版 marker 可能有）
    if (typeof d.startedAt === 'string') startedAt = startedAt ?? d.startedAt;
  }
  try {
    const stat = statSync(markerPath);
    markerUpdatedAt = new Date(stat.mtimeMs).toISOString();
  } catch {
    /* ignore */
  }

  const alive = isPidAlive(pid);
  const fresh = markerUpdatedAt ? now - new Date(markerUpdatedAt).getTime() < STUCK_THRESHOLD_MS : false;
  const ageMs = markerUpdatedAt ? now - new Date(markerUpdatedAt).getTime() : null;

  // v0.49.9: 5 态模型
  //   crashed: PID 死但有卡片 → 掉线
  //   idle:    无卡片
  //   starting: 进程活 + marker 刚写 < 60s + 卡片无 STARTED-<stage> 标签（ACK 未到）
  //   stuck:   进程活 + marker 停滞 > 5min
  //   running: 其它健康情况
  let state: WorkerState;
  if (!alive) {
    state = card !== null ? 'crashed' : 'idle';
  } else if (card === null) {
    state = 'idle';
  } else {
    // 检查是否 starting：marker 很新 + 卡片没 STARTED-<stage> 标签
    const isStarting = (() => {
      if (ageMs === null || ageMs > ACK_TIMEOUT_MS) return false;
      if (!stage) return false;
      try {
        const cardDetail = readCard(resolve(HOME, '.coral', 'projects', project), card.seq);
        if (!cardDetail) return false;
        return !cardDetail.labels.includes(`STARTED-${stage}`);
      } catch {
        return false;
      }
    })();

    if (isStarting) state = 'starting';
    else if (!fresh) state = 'stuck';
    else state = 'running';
  }

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

// ─── v0.49.9 跨项目聚合视图 ────────────────────────────────────────

interface AggregateWorker extends Worker {
  project: string;
  lastLogLine: { ts: string | null; msg: string } | null;
}

interface ProjectCapacity {
  project: string;
  total: number;
  running: number;
  starting: number;
  stuck: number;
  crashed: number;
  idle: number;
}

/**
 * GET /api/workers/all
 *   扫描 ~/.coral/projects/* 的 runtime/worker-N-current.json，聚合所有 worker。
 *   返回 {alerts: Worker[], active: Worker[], capacity: ProjectCapacity[]}。
 *   - alerts: state === 'stuck' 或 'crashed'
 *   - active: state === 'running' 或 'starting'
 *   - capacity: 按项目统计各状态数量
 *   Active 的每个 worker 带 lastLogLine（尾 pipeline log 最近一行带 worker-N 的）。
 */
export function createWorkersAggregateRoute(): Hono {
  const app = new Hono();

  app.get('/all', async (c) => {
    const projectsDir = resolve(HOME, '.coral', 'projects');
    if (!existsSync(projectsDir)) {
      return c.json({ alerts: [], active: [], capacity: [] });
    }
    const projectNames = readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    const alerts: AggregateWorker[] = [];
    const active: AggregateWorker[] = [];
    const capacity: ProjectCapacity[] = [];

    for (const project of projectNames) {
      const markers = listWorkerMarkerPaths(project);
      const stat: ProjectCapacity = {
        project,
        total: markers.length,
        running: 0,
        starting: 0,
        stuck: 0,
        crashed: 0,
        idle: 0,
      };
      for (const m of markers) {
        const w = workerFromMarker(project, m.slot, m.path);
        stat[w.state]++;

        if (w.state === 'stuck' || w.state === 'crashed') {
          alerts.push({ ...w, project, lastLogLine: await readLatestLogLine(project, m.slot) });
        } else if (w.state === 'running' || w.state === 'starting') {
          active.push({ ...w, project, lastLogLine: await readLatestLogLine(project, m.slot) });
        }
      }
      capacity.push(stat);
    }

    // 按 state 严重度 + runtime 倒序（stuck 比 crashed 更需看；old runtime 先看）
    alerts.sort((a, b) => {
      if (a.state !== b.state) return a.state === 'stuck' ? -1 : 1;
      return (b.runtimeMs ?? 0) - (a.runtimeMs ?? 0);
    });
    active.sort((a, b) => (b.runtimeMs ?? 0) - (a.runtimeMs ?? 0));

    return c.json({ alerts, active, capacity });
  });

  return app;
}

/** Read only the latest log line tagged with worker-<slot>. Same file selection as readWorkerLogTail. */
async function readLatestLogLine(
  project: string,
  slot: number,
): Promise<{ ts: string | null; msg: string } | null> {
  const logsDir = resolve(HOME, '.coral', 'projects', project, 'logs');
  if (!existsSync(logsDir)) return null;
  const candidates = readdirSync(logsDir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ f, full: resolve(logsDir, f), mtime: statSync(resolve(logsDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const pipeline = candidates.find((c) => c.f.startsWith('pipeline-'));
  const file = pipeline?.full ?? candidates[0]?.full;
  if (!file) return null;

  const MAX_BYTES = 512 * 1024; // 只扫尾 512KB — 聚合视图优先速度
  const stat = statSync(file);
  const start = Math.max(0, stat.size - MAX_BYTES);
  const slotTag = `worker-${slot}`;
  let latest: { ts: string | null; msg: string } | null = null;

  await new Promise<void>((done) => {
    const stream = createReadStream(file, { start, encoding: 'utf-8' });
    const rl = createInterface({ input: stream });
    rl.on('line', (raw) => {
      if (!raw.includes(slotTag)) return;
      const cleaned = raw.replace(/\[[0-9;]*m/g, '');
      const m = cleaned.match(/(\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)\s*(?:\[[^\]]+\]\s*)?(.*)$/);
      latest = {
        ts: m?.[1] ?? null,
        msg: (m?.[2] ?? cleaned).slice(0, 200),
      };
    });
    rl.on('close', () => done());
    rl.on('error', () => done());
  });
  return latest;
}
