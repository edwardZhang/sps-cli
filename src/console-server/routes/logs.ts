/**
 * @module        console-server/routes/logs
 * @description   日志：历史查询 + SSE tail
 *
 * 策略：
 *   - 项目有个大 log 文件（~/.coral/projects/<name>/logs/*.log）
 *   - GET /api/logs?project=x[&worker=N]&since=<offset>&limit=500 → 读尾部
 *   - GET /stream/logs?project=x 打开 fs.watch，文件追加 → SSE 广播
 */
import { Hono } from 'hono';
import {
  createReadStream,
  existsSync,
  readdirSync,
  statSync,
  watch as fsWatch,
  type FSWatcher,
} from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Logger } from '../../core/logger.js';

const HOME = process.env.HOME || '/home/coral';
const LOG_LINE_BUDGET = 500;
const SSE_HEARTBEAT_MS = 15_000;
const MAX_SCAN_BYTES = 4 * 1024 * 1024; // 只读最近 4MB

function projectLogsDir(project: string): string {
  return resolve(HOME, '.coral', 'projects', project, 'logs');
}

function findLogFiles(project: string, worker?: string): string[] {
  const dir = projectLogsDir(project);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.log'))
    .filter((f) => (worker ? f.includes(`worker-${worker}`) || f.includes(`-${worker}-`) : true))
    .map((f) => resolve(dir, f))
    .sort((a, b) => {
      try {
        return statSync(b).mtimeMs - statSync(a).mtimeMs;
      } catch {
        return 0;
      }
    });
  return files;
}

interface LogLine {
  ts: string | null;
  worker: number | null;
  level: 'debug' | 'info' | 'warn' | 'error' | 'trace';
  msg: string;
  raw: string;
}

function parseLine(raw: string): LogLine {
  // 兼容几种：
  //   [2026-04-22 18:55:03.124] INFO worker-1  msg
  //   2026-04-22T18:55:03.124Z INFO [worker-1] msg
  //   普通 tsx 输出：任意字符串
  const cleaned = raw.replace(/\u001b\[[0-9;]*m/g, ''); // 去 ANSI 颜色
  const m = cleaned.match(/(\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?)\s*(?:\[)?(DEBUG|INFO|WARN|WARNING|ERROR|TRACE)\]?\s*(?:\[?(worker-\d+|acp|claude|supervisor|event-handler|skill|console)\]?\s*)?(.*)$/i);
  if (m) {
    const tsRaw = m[1] ?? '';
    const lvl = (m[2] ?? 'info').toLowerCase().replace('warning', 'warn');
    const src = m[3] ?? '';
    const msg = m[4] ?? cleaned;
    let worker: number | null = null;
    const wm = src.match(/worker-(\d+)/);
    if (wm) worker = Number.parseInt(wm[1] ?? '', 10);
    return {
      ts: tsRaw.includes('T') ? tsRaw : tsRaw.replace(' ', 'T') + 'Z',
      worker,
      level: lvl as LogLine['level'],
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
  await new Promise<void>((done) => {
    const stream = createReadStream(filePath, { start, encoding: 'utf-8' });
    const rl = createInterface({ input: stream });
    rl.on('line', (l) => {
      lines.push(parseLine(l));
      if (lines.length > limit * 3) lines.splice(0, lines.length - limit * 3);
    });
    rl.on('close', () => done());
  });
  return lines.slice(-limit);
}

export function createLogsRoute(log: Logger): Hono {
  const app = new Hono();

  app.get('/', async (c) => {
    const project = c.req.query('project');
    if (!project) {
      return c.json({ type: 'validation', title: 'project required', status: 422 }, 422);
    }
    const worker = c.req.query('worker') || undefined;
    const limit = Math.min(Number.parseInt(c.req.query('limit') ?? '500', 10) || 500, 2000);
    const since = c.req.query('since'); // ISO timestamp; filter ts >= since
    const files = findLogFiles(project, worker);
    if (files.length === 0) return c.json({ data: [], files: [] });

    const file = files[0]!;
    try {
      let lines = await readTailLines(file, limit);
      if (since) {
        const sinceParsed = Date.parse(since);
        if (!Number.isNaN(sinceParsed)) {
          lines = lines.filter((l) => {
            if (!l.ts) return true; // keep unparseable lines (conservative)
            const lt = Date.parse(l.ts);
            return Number.isNaN(lt) || lt >= sinceParsed;
          });
        }
      }
      return c.json({
        data: lines,
        file: file.replace(HOME, '~'),
        files: files.map((f) => f.replace(HOME, '~')),
      });
    } catch (err) {
      log.warn(`log read failed: ${err instanceof Error ? err.message : String(err)}`);
      return c.json({ data: [], file, files });
    }
  });

  return app;
}

// ── SSE: /stream/logs?project=x[&worker=N] ────────────────────────────
export function createLogsStreamRoute(log: Logger): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const project = c.req.query('project');
    if (!project) {
      return c.text('project required', 422);
    }
    const worker = c.req.query('worker') || undefined;
    const files = findLogFiles(project, worker);
    const file = files[0];

    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const send = (event: string, data: unknown): void => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };

        let watcher: FSWatcher | null = null;
        let lastSize = 0;
        if (file && existsSync(file)) {
          try {
            lastSize = statSync(file).size;
          } catch {
            lastSize = 0;
          }
          try {
            watcher = fsWatch(file, async () => {
              if (closed) return;
              try {
                const stat = statSync(file);
                if (stat.size <= lastSize) {
                  // 文件被截断或轮转，重新定位
                  lastSize = stat.size;
                  return;
                }
                const newChunk: string[] = [];
                await new Promise<void>((done) => {
                  const s = createReadStream(file, {
                    start: lastSize,
                    end: stat.size,
                    encoding: 'utf-8',
                  });
                  const rl = createInterface({ input: s });
                  rl.on('line', (l) => newChunk.push(l));
                  rl.on('close', () => done());
                });
                lastSize = stat.size;
                for (const l of newChunk) {
                  if (!l.trim()) continue;
                  send('log.line', parseLine(l));
                }
              } catch (err) {
                log.warn(`log watch failed: ${err instanceof Error ? err.message : String(err)}`);
              }
            });
          } catch (err) {
            log.warn(`fs.watch failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`: heartbeat ${Date.now()}\n\n`));
          } catch {
            closed = true;
          }
        }, SSE_HEARTBEAT_MS);

        send('log.init', { file: file?.replace(HOME, '~') ?? null });

        c.req.raw.signal?.addEventListener('abort', () => {
          closed = true;
          watcher?.close();
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  });

  return app;
}
