/**
 * @module        console/routes/workers
 * @description   Worker REST —— 全走 WorkerService
 *
 * @layer         console
 */
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Hono } from 'hono';
import type { WorkerService } from '../../services/WorkerService.js';
import {
  home,
  logsDir,
  workerLogLineTag,
  workerMarkerFile,
} from '../../shared/runtimePaths.js';
import { sendResult } from '../lib/resultToJson.js';

export function createWorkersRoute(workers: WorkerService): Hono {
  const app = new Hono();

  app.get('/:project/workers', async (c) => {
    const r = await workers.listByProject(c.req.param('project'));
    if (!r.ok) return sendResult(c, r);
    return c.json({ data: r.value });
  });

  app.get('/:project/workers/:slot', async (c) => {
    const slot = Number.parseInt(c.req.param('slot'), 10);
    const r = await workers.getBySlot(c.req.param('project'), slot);
    if (!r.ok) return sendResult(c, r);
    const project = c.req.param('project');
    const markerPath = workerMarkerFile(project, `worker-${slot}`);
    let markerData: unknown = null;
    try {
      markerData = JSON.parse(readFileSync(markerPath, 'utf-8'));
    } catch {
      /* ignore */
    }
    const recentLogs = await readWorkerLogTail(project, slot, 20);
    // v0.50.10：Claude code 实际输出走 sps-acp-<proj>-<slot>-acp-*.log
    // （SessionUpdateAccumulator.appendLog 写入）。tick 的 pipeline-*.log 里
    // 只有 supervisor 心跳，看不到 Claude 文本和工具调用。这里加一条独立 tail。
    const recentOutput = await readAcpSessionLogTail(project, slot, 500);
    return c.json({
      ...r.value,
      markerPath: markerPath.replace(home(), '~'),
      markerData,
      recentLogs,
      recentOutput,
    });
  });

  app.post('/:project/workers/:slot/kill', async (c) => {
    const slot = Number.parseInt(c.req.param('slot'), 10);
    return sendResult(c, await workers.kill(c.req.param('project'), slot));
  });

  app.post('/:project/workers/:slot/launch', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const seq = typeof body?.seq === 'number' ? body.seq : Number.parseInt(String(body?.seq ?? 0), 10);
    if (!Number.isInteger(seq) || seq <= 0) {
      return c.json({ type: 'validation', title: 'seq required', status: 422 }, 422);
    }
    return sendResult(c, await workers.launch(c.req.param('project'), seq));
  });

  return app;
}

export function createWorkersAggregateRoute(workers: WorkerService): Hono {
  const app = new Hono();

  app.get('/all', async (c) => {
    const r = await workers.aggregate();
    if (!r.ok) return sendResult(c, r);
    const enrich = async <T extends { project: string; slot: number }>(
      list: T[],
    ): Promise<Array<T & { lastLogLine: { ts: string | null; msg: string } | null }>> => {
      const out: Array<T & { lastLogLine: { ts: string | null; msg: string } | null }> = [];
      for (const w of list) {
        out.push({ ...w, lastLogLine: await readLatestLogLine(w.project, w.slot) });
      }
      return out;
    };
    return c.json({
      alerts: await enrich(r.value.alerts),
      active: await enrich(r.value.active),
      capacity: r.value.capacity,
    });
  });

  return app;
}

// ─── 日志 tail helpers（Delivery 专属） ──────────────────────────────

async function readWorkerLogTail(
  project: string,
  slot: number,
  limit: number,
): Promise<Array<{ ts: string | null; level: string; msg: string }>> {
  const dir = logsDir(project);
  if (!existsSync(dir)) return [];
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ f, full: resolve(dir, f), mtime: statSync(resolve(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const pipeline = candidates.find((c) => c.f.startsWith('pipeline-'));
  const file = pipeline?.full ?? candidates[0]?.full;
  if (!file) return [];

  const MAX_BYTES = 4 * 1024 * 1024;
  const stat = statSync(file);
  const start = Math.max(0, stat.size - MAX_BYTES);
  const matches: Array<{ ts: string | null; level: string; msg: string }> = [];
  const slotTag = workerLogLineTag(slot);
  await new Promise<void>((done) => {
    const stream = createReadStream(file, { start, encoding: 'utf-8' });
    const rl = createInterface({ input: stream });
    rl.on('line', (raw) => {
      if (!raw.includes(slotTag)) return;
      const cleaned = raw.replace(/\[[0-9;]*m/g, '');
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

/**
 * v0.50.10：读 ACP session log 尾部 N 行 —— Claude Code 真正的输出流。
 *
 * 文件命名：sps-acp-<project>-<slot>-acp-<ts>.log（AcpSdkAdapter 写入，SessionUpdateAccumulator.appendLog）
 * 每行格式：`HH:mm:ss.SSS [assistant|tool:kind|tool_update|usage] <content>`
 *
 * 每次 run 会新建一个文件，所以列目录取当前 slot 匹配的最新一个。
 */
async function readAcpSessionLogTail(
  project: string,
  slot: number,
  limit: number,
): Promise<Array<{ ts: string | null; kind: string; text: string }>> {
  const dir = logsDir(project);
  if (!existsSync(dir)) return [];
  const prefix = `sps-acp-${project}-worker-${slot}-acp-`;
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.log'))
    .map((f) => ({ f, full: resolve(dir, f), mtime: statSync(resolve(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const file = files[0]?.full;
  if (!file) return [];

  // 最多读尾部 8 MB（ACP session 可能很长）
  const MAX_BYTES = 8 * 1024 * 1024;
  const stat = statSync(file);
  const start = Math.max(0, stat.size - MAX_BYTES);
  const lines: Array<{ ts: string | null; kind: string; text: string }> = [];
  await new Promise<void>((done) => {
    const stream = createReadStream(file, { start, encoding: 'utf-8' });
    const rl = createInterface({ input: stream });
    rl.on('line', (raw) => {
      if (!raw) return;
      // 格式：`HH:mm:ss.SSS [kind...] rest`
      const m = raw.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s+\[([^\]]+)\]\s?(.*)$/);
      if (m) {
        lines.push({ ts: m[1], kind: m[2], text: m[3] });
      } else {
        // 不匹配就原样保留（比如 assistant 多行 content 被 \n 截断后的续行）
        lines.push({ ts: null, kind: 'raw', text: raw });
      }
      if (lines.length > limit * 3) lines.splice(0, lines.length - limit * 3);
    });
    rl.on('close', () => done());
    rl.on('error', () => done());
  });
  return lines.slice(-limit);
}

async function readLatestLogLine(
  project: string,
  slot: number,
): Promise<{ ts: string | null; msg: string } | null> {
  const dir = logsDir(project);
  if (!existsSync(dir)) return null;
  const candidates = readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => ({ f, full: resolve(dir, f), mtime: statSync(resolve(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  const pipeline = candidates.find((c) => c.f.startsWith('pipeline-'));
  const file = pipeline?.full ?? candidates[0]?.full;
  if (!file) return null;

  const MAX_BYTES = 512 * 1024;
  const stat = statSync(file);
  const start = Math.max(0, stat.size - MAX_BYTES);
  const slotTag = workerLogLineTag(slot);
  let latest: { ts: string | null; msg: string } | null = null;
  await new Promise<void>((done) => {
    const stream = createReadStream(file, { start, encoding: 'utf-8' });
    const rl = createInterface({ input: stream });
    rl.on('line', (raw) => {
      if (!raw.includes(slotTag)) return;
      const cleaned = raw.replace(/\[[0-9;]*m/g, '');
      const m = cleaned.match(/(\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)\s*(?:\[[^\]]+\]\s*)?(.*)$/);
      latest = { ts: m?.[1] ?? null, msg: (m?.[2] ?? cleaned).slice(0, 200) };
    });
    rl.on('close', () => done());
    rl.on('error', () => done());
  });
  return latest;
}
