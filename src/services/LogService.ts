/**
 * @module        services/LogService
 * @description   日志 tail + 聚合 service
 *
 * @layer         services
 *
 * 职责：
 *   - 单项目 tail（可选 worker 过滤、since 过滤、limit 截断）
 *   - 跨项目聚合 tail
 *   - 解析 log 行 → 结构化 LogLine（ts / level / worker / msg）
 *
 * 注意：SSE 流式 tail 是 Delivery 层职责（route 用 fs.watch），Service 只做一次性查询。
 */
import { createReadStream, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { FileSystem } from '../infra/filesystem.js';
import { type DomainError, domainError } from '../shared/errors.js';
import { err, ok, type Result } from '../shared/result.js';
import { home, logsDir, projectsDir, workerLogLineTag } from '../shared/runtimePaths.js';

const MAX_SCAN_BYTES = 4 * 1024 * 1024;

export interface LogLine {
  readonly ts: string | null;
  readonly worker: number | null;
  readonly level: 'debug' | 'info' | 'warn' | 'error' | 'trace';
  readonly msg: string;
  readonly raw: string;
  readonly project?: string;
}

export interface LogQueryOpts {
  project: string;
  worker?: number;
  limit?: number;
  /** ISO datetime string —— 只返时间 >= since 的行 */
  since?: string;
}

export interface LogQueryResult {
  readonly data: LogLine[];
  readonly file: string | null;
  readonly files: string[];
}

export interface AggregateOpts {
  worker?: number;
  limit?: number;
  since?: string;
}

export interface AggregateResult {
  readonly data: LogLine[];
  readonly files: string[];
}

// v0.50.17：Worker 详情页的两个 tail——从 Delivery 层（routes/workers.ts）搬下来。

export interface WorkerLogLine {
  readonly ts: string | null;
  readonly level: string;
  readonly msg: string;
}

export interface AcpSessionLine {
  readonly ts: string | null;
  readonly kind: string; // assistant | tool:<kind> | tool_update | usage | raw
  readonly text: string;
}

export interface LogServiceDeps {
  readonly fs: FileSystem;
}

export class LogService {
  constructor(private readonly deps: LogServiceDeps) {}

  /** 单项目 tail。 */
  async tail(opts: LogQueryOpts): Promise<Result<LogQueryResult, DomainError>> {
    const limit = clampLimit(opts.limit);
    const files = this.findLogFiles(opts.project, opts.worker);
    if (files.length === 0) {
      return ok({ data: [], file: null, files: [] });
    }
    const file = files[0]!;
    try {
      const lines = await readTailLines(file, limit);
      const filtered = opts.since ? filterSince(lines, opts.since) : lines;
      return ok({
        data: filtered,
        file: rel(file),
        files: files.map(rel),
      });
    } catch (cause) {
      return err(domainError('internal', 'LOG_READ_FAIL', 'failed to read logs', { cause }));
    }
  }

  /** 跨项目聚合 tail。 */
  async aggregate(opts: AggregateOpts = {}): Promise<Result<AggregateResult, DomainError>> {
    const limit = clampLimit(opts.limit);
    const root = projectsDir();
    if (!this.deps.fs.exists(root)) {
      return ok({ data: [], files: [] });
    }
    let projects: string[];
    try {
      projects = this.deps.fs.readDir(root).filter((e) => e.isDirectory).map((e) => e.name);
    } catch (cause) {
      return err(domainError('internal', 'PROJECTS_READ_FAIL', 'failed to read projects directory', { cause }));
    }
    // 每项目最新 log
    const picked: Array<{ project: string; file: string }> = [];
    for (const p of projects) {
      const files = this.findLogFiles(p, opts.worker);
      if (files.length > 0) picked.push({ project: p, file: files[0]! });
    }
    const perLimit = Math.max(50, Math.floor(limit / Math.max(picked.length, 1)) * 2);
    const merged: LogLine[] = [];
    for (const { project, file } of picked) {
      try {
        const lines = await readTailLines(file, perLimit);
        for (const l of lines) merged.push({ ...l, project });
      } catch {
        /* 跳过读不了的，不一票否决 */
      }
    }
    // 按 ts 升序（老的在前，新的在末），取末尾 limit
    merged.sort((a, b) => {
      const at = a.ts ? Date.parse(a.ts) : 0;
      const bt = b.ts ? Date.parse(b.ts) : 0;
      return at - bt;
    });
    const filtered = opts.since ? filterSince(merged, opts.since) : merged;
    return ok({
      data: filtered.slice(-limit),
      files: picked.map((p) => rel(p.file)),
    });
  }

  /**
   * v0.50.17：Worker 详情面板专用 tail——读 pipeline-<date>.log 里带 [worker-N] 标签
   * 的行，结构化出来。原来在 `routes/workers.ts:readWorkerLogTail`，违反层级，搬到这。
   */
  async tailWorkerSupervisorLog(
    project: string,
    slot: number,
    limit: number = 20,
  ): Promise<WorkerLogLine[]> {
    const dir = logsDir(project);
    if (!this.deps.fs.exists(dir)) return [];
    let entries;
    try {
      entries = this.deps.fs.readDir(dir);
    } catch {
      return [];
    }
    const candidates = entries
      .filter((e) => e.isFile && e.name.endsWith('.log'))
      .map((e) => ({
        name: e.name,
        full: resolve(dir, e.name),
        mtime: this.deps.fs.stat(resolve(dir, e.name))?.mtimeMs ?? 0,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    const pipeline = candidates.find((c) => c.name.startsWith('pipeline-'));
    const file = pipeline?.full ?? candidates[0]?.full;
    if (!file) return [];

    const slotTag = workerLogLineTag(slot);
    const maxBytes = 4 * 1024 * 1024;
    const matches: WorkerLogLine[] = [];
    await streamLines(file, maxBytes, (raw) => {
      if (!raw.includes(slotTag)) return;
      const parsed = parseSupervisorLogLine(raw);
      matches.push(parsed);
      if (matches.length > limit * 3) matches.splice(0, matches.length - limit * 3);
    });
    return matches.slice(-limit);
  }

  /**
   * v0.50.17：Claude 实际输出 tail——读 `sps-acp-<project>-worker-<N>-acp-<ts>.log`
   * 里 SessionUpdateAccumulator.appendLog 写的结构化行。原来在 `routes/workers.ts:
   * readAcpSessionLogTail`，搬到这。
   */
  async tailAcpSession(
    project: string,
    slot: number,
    limit: number = 500,
  ): Promise<AcpSessionLine[]> {
    const dir = logsDir(project);
    if (!this.deps.fs.exists(dir)) return [];
    let entries;
    try {
      entries = this.deps.fs.readDir(dir);
    } catch {
      return [];
    }
    const prefix = `sps-acp-${project}-worker-${slot}-acp-`;
    const files = entries
      .filter((e) => e.isFile && e.name.startsWith(prefix) && e.name.endsWith('.log'))
      .map((e) => ({
        name: e.name,
        full: resolve(dir, e.name),
        mtime: this.deps.fs.stat(resolve(dir, e.name))?.mtimeMs ?? 0,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    const file = files[0]?.full;
    if (!file) return [];

    const maxBytes = 8 * 1024 * 1024;
    const lines: AcpSessionLine[] = [];
    await streamLines(file, maxBytes, (raw) => {
      if (!raw) return;
      lines.push(parseAcpSessionLine(raw));
      if (lines.length > limit * 3) lines.splice(0, lines.length - limit * 3);
    });
    return lines.slice(-limit);
  }

  /**
   * v0.50.17：聚合页单条 "lastLogLine"——找最近一条带 [worker-N] 标签的日志。
   * 比 tailWorkerSupervisorLog 轻量，只要 1 条，扫描 512KB 尾部就够。
   */
  async latestWorkerLogLine(
    project: string,
    slot: number,
  ): Promise<{ ts: string | null; msg: string } | null> {
    const dir = logsDir(project);
    if (!this.deps.fs.exists(dir)) return null;
    let entries;
    try {
      entries = this.deps.fs.readDir(dir);
    } catch {
      return null;
    }
    const candidates = entries
      .filter((e) => e.isFile && e.name.endsWith('.log'))
      .map((e) => ({
        name: e.name,
        full: resolve(dir, e.name),
        mtime: this.deps.fs.stat(resolve(dir, e.name))?.mtimeMs ?? 0,
      }))
      .sort((a, b) => b.mtime - a.mtime);
    const pipeline = candidates.find((c) => c.name.startsWith('pipeline-'));
    const file = pipeline?.full ?? candidates[0]?.full;
    if (!file) return null;

    const slotTag = workerLogLineTag(slot);
    let latest: { ts: string | null; msg: string } | null = null;
    await streamLines(file, 512 * 1024, (raw) => {
      if (!raw.includes(slotTag)) return;
      const cleaned = raw.replace(/\[[0-9;]*m/g, '');
      const m = cleaned.match(/(\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)\s*(?:\[[^\]]+\]\s*)?(.*)$/);
      latest = { ts: m?.[1] ?? null, msg: (m?.[2] ?? cleaned).slice(0, 200) };
    });
    return latest;
  }

  // ─── 内部 ─────────────────────────────────────────────────────────

  private findLogFiles(project: string, worker?: number): string[] {
    const dir = logsDir(project);
    if (!this.deps.fs.exists(dir)) return [];
    let entries;
    try {
      entries = this.deps.fs.readDir(dir);
    } catch {
      return [];
    }
    const workerTag = worker !== undefined ? workerLogLineTag(worker) : null;
    const files = entries
      .filter((e) => e.isFile && e.name.endsWith('.log'))
      .filter((e) => {
        if (!workerTag) return true;
        return e.name.includes(workerTag) || e.name.includes(`-${worker}-`);
      })
      .map((e) => resolve(dir, e.name))
      .sort((a, b) => {
        const sa = this.deps.fs.stat(a);
        const sb = this.deps.fs.stat(b);
        return (sb?.mtimeMs ?? 0) - (sa?.mtimeMs ?? 0);
      });
    return files;
  }
}

// ─── helpers ──────────────────────────────────────────────────────

function clampLimit(input?: number): number {
  const n = input ?? 500;
  if (!Number.isFinite(n) || n <= 0) return 500;
  return Math.min(n, 2000);
}

function filterSince(lines: LogLine[], since: string): LogLine[] {
  const parsed = Date.parse(since);
  if (Number.isNaN(parsed)) return lines;
  return lines.filter((l) => {
    if (!l.ts) return true;
    const lt = Date.parse(l.ts);
    return Number.isNaN(lt) || lt >= parsed;
  });
}

function rel(path: string): string {
  try {
    return path.replace(home(), '~');
  } catch {
    return path;
  }
}

export function parseLogLine(raw: string): LogLine {
  const cleaned = raw.replace(/\[[0-9;]*m/g, '');
  const m = cleaned.match(
    /(\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)\s*(?:\[)?(DEBUG|INFO|WARN|WARNING|ERROR|TRACE)\]?\s*(?:\[?(worker-\d+|acp|claude|supervisor|event-handler|skill|console)\]?\s*)?(.*)$/i,
  );
  if (m) {
    const tsRaw = m[1] ?? '';
    const lvl = (m[2] ?? 'info').toLowerCase().replace('warning', 'warn') as LogLine['level'];
    const src = m[3] ?? '';
    const msg = m[4] ?? cleaned;
    let worker: number | null = null;
    const wm = src.match(/worker-(\d+)/);
    if (wm) worker = Number.parseInt(wm[1] ?? '', 10);
    return {
      ts: tsRaw.includes('T') ? tsRaw : `${tsRaw.replace(' ', 'T')}Z`,
      worker,
      level: lvl,
      msg: src && !src.startsWith('worker-') ? `[${src}] ${msg}` : msg,
      raw: cleaned,
    };
  }
  return { ts: null, worker: null, level: 'info', msg: cleaned, raw: cleaned };
}

async function readTailLines(filePath: string, limit: number): Promise<LogLine[]> {
  const stat = statSync(filePath);
  const start = Math.max(0, stat.size - MAX_SCAN_BYTES);
  const lines: LogLine[] = [];
  await new Promise<void>((resolveP) => {
    const stream = createReadStream(filePath, { start, encoding: 'utf-8' });
    const rl = createInterface({ input: stream });
    rl.on('line', (l) => {
      lines.push(parseLogLine(l));
      if (lines.length > limit * 3) lines.splice(0, lines.length - limit * 3);
    });
    rl.on('close', () => resolveP());
  });
  return lines.slice(-limit);
}

// v0.50.17：通用 tail 流——worker supervisor log + ACP session log 共用
async function streamLines(
  filePath: string,
  maxBytes: number,
  onLine: (raw: string) => void,
): Promise<void> {
  const stat = statSync(filePath);
  const start = Math.max(0, stat.size - maxBytes);
  await new Promise<void>((resolveP) => {
    const stream = createReadStream(filePath, { start, encoding: 'utf-8' });
    const rl = createInterface({ input: stream });
    rl.on('line', onLine);
    rl.on('close', () => resolveP());
    rl.on('error', () => resolveP());
  });
}

export function parseSupervisorLogLine(raw: string): WorkerLogLine {
  const cleaned = raw.replace(/\[[0-9;]*m/g, '');
  const m = cleaned.match(
    /(\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)\s*(?:\[)?(DEBUG|INFO|WARN|WARNING|ERROR|TRACE)\]?\s*(.*)$/i,
  );
  return {
    ts: m?.[1] ?? null,
    level: (m?.[2] ?? 'info').toLowerCase().replace('warning', 'warn'),
    msg: m?.[3] ?? cleaned,
  };
}

export function parseAcpSessionLine(raw: string): AcpSessionLine {
  const m = raw.match(/^(\d{2}:\d{2}:\d{2}\.\d{3})\s+\[([^\]]+)\]\s?(.*)$/);
  if (m) {
    return { ts: m[1]!, kind: m[2]!, text: m[3] ?? '' };
  }
  return { ts: null, kind: 'raw', text: raw };
}
