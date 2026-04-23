/**
 * @module        infra/chokidarWatchers
 * @description   chokidar FS 监听 → DomainEventBus 事件翻译
 *
 * @layer         infra
 *
 * v0.50 重构：把原 console-server/watchers/* 三个分散模块统一成 port 驱动。
 * 输出不再是具体 eventBus 单例，而是注入的 DomainEventBus —— 测试可以用 FakeBus
 * 验证"FS 事件 → DomainEvent"翻译规则。
 *
 * 职责：
 *   - 卡片 md 文件变化 → card.created / updated / deleted
 *   - marker 文件变化 → worker.dispatched / updated / deleted
 *   - supervisor.pid 出现或消失（轮询，chokidar 对 pid 不敏感）→ pipeline.started / stopped
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import chokidar, { type FSWatcher } from 'chokidar';
import type { DomainEventBus } from '../shared/domainEvents.js';
import {
  projectsDir,
  supervisorPidFile,
  WorkerMarkerFilenameRe,
} from '../shared/runtimePaths.js';
import type { Clock } from './clock.js';
import type { FileSystem } from './filesystem.js';

export interface WatcherHandles {
  close(): Promise<void>;
}

// ─── Card watcher ──────────────────────────────────────────────────

/** 从绝对路径抽 project + seq —— 容忍顶层 cards/N.md 和 cards/<state>/N-slug.md */
function extractCardInfo(path: string): { project: string; seq: number } | null {
  const m = path.match(/projects\/([^/]+)\/cards\/(?:[^/]+\/)?(\d+)(?:-[^/]*)?\.md$/);
  if (!m) return null;
  const seq = Number.parseInt(m[2] ?? '', 10);
  return Number.isFinite(seq) && seq >= 0 ? { project: m[1] ?? '', seq } : null;
}

/** 从 marker 文件路径抽 project + slot 字符串名 */
function extractMarkerInfo(path: string): { project: string; slot: string } | null {
  const m = path.match(/projects\/([^/]+)\/runtime\/([^/]+)$/);
  if (!m) return null;
  const filename = m[2]!;
  if (!WorkerMarkerFilenameRe.test(filename)) return null;
  // 从文件名抽 slotName（保持原字符串，可能是 "worker-1" 或 "1"）
  const slotMatch = filename.match(/^worker-(.+)-current\.json$/);
  if (!slotMatch) return null;
  return { project: m[1] ?? '', slot: slotMatch[1]! };
}

// ─── 启动器 ────────────────────────────────────────────────────────

export interface StartWatchersOptions {
  /** SPS coral root（通常 $HOME/.coral） */
  coralRoot: string;
  /** 订阅 port */
  bus: DomainEventBus;
  /** 轮询 supervisor.pid 的间隔（ms），默认 2000 */
  pipelinePollMs?: number;
  /** 可选时钟（注 ts 用） */
  clock?: Clock;
  /** 可选 FS（测试注入） */
  fs?: FileSystem;
}

/**
 * 启动全部 watchers。返回一个 close() —— 调用后异步关闭 chokidar + clear interval。
 */
export function startChokidarWatchers(opts: StartWatchersOptions): WatcherHandles {
  const now = (): number => opts.clock?.now() ?? Date.now();
  const watchers: FSWatcher[] = [];
  const cleanups: Array<() => void> = [];

  // 1. cards watcher
  watchers.push(
    chokidar
      .watch(`${opts.coralRoot}/projects`, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
        depth: 4,
        ignored: (p: string) => /\/(node_modules|\.git|\.DS_Store)(\/|$)/.test(p),
      })
      .on('add', (path) => {
        if (!path.endsWith('.md')) return;
        const info = extractCardInfo(path);
        if (!info) return;
        // 注意：这里不反查 card 详情 —— 事件只携带 seq，订阅者需要时自己读。
        // 这样可以避免 watcher 层依赖 Service 层，保持层依赖干净。
        opts.bus.emit({
          type: 'card.created',
          project: info.project,
          seq: info.seq,
          // watcher 不反查；fallback 一个最小 Card shape
          card: minimalCard(info.seq),
          ts: now(),
        });
      })
      .on('change', (path) => {
        if (!path.endsWith('.md')) return;
        const info = extractCardInfo(path);
        if (!info) return;
        opts.bus.emit({
          type: 'card.updated',
          project: info.project,
          seq: info.seq,
          patch: {},
          ts: now(),
        });
      })
      .on('unlink', (path) => {
        if (!path.endsWith('.md')) return;
        const info = extractCardInfo(path);
        if (!info) return;
        opts.bus.emit({
          type: 'card.deleted',
          project: info.project,
          seq: info.seq,
          ts: now(),
        });
      }),
  );

  // 2. marker watcher
  watchers.push(
    chokidar
      .watch(`${opts.coralRoot}/projects`, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 40 },
        depth: 3,
        ignored: (p: string) => /\/(node_modules|\.git|\.DS_Store)(\/|$)/.test(p),
      })
      .on('add', (path) => {
        const info = extractMarkerInfo(path);
        if (!info) return;
        opts.bus.emit({ type: 'worker.updated', project: info.project, slot: info.slot, ts: now() });
      })
      .on('change', (path) => {
        const info = extractMarkerInfo(path);
        if (!info) return;
        opts.bus.emit({ type: 'worker.updated', project: info.project, slot: info.slot, ts: now() });
      })
      .on('unlink', (path) => {
        const info = extractMarkerInfo(path);
        if (!info) return;
        opts.bus.emit({ type: 'worker.deleted', project: info.project, slot: info.slot, ts: now() });
      }),
  );

  // 3. pipeline poller
  cleanups.push(startPipelinePoller(opts));

  return {
    async close() {
      for (const c of cleanups) c();
      await Promise.all(watchers.map((w) => w.close().catch(() => undefined)));
    },
  };
}

function minimalCard(seq: number): import('../shared/types.js').Card {
  return {
    id: `md-${seq}`,
    seq: String(seq),
    title: `#${seq}`,
    desc: '',
    state: '',
    labels: [],
    meta: {},
  };
}

// ─── Pipeline poller —— 轮询 supervisor.pid ─────────────────────────

interface PollState {
  pid: number | null;
  running: boolean;
}

function readSupervisorState(
  fs: FileSystem | undefined,
  pidPath: string,
): PollState {
  const exists = fs ? fs.exists(pidPath) : existsSync(pidPath);
  if (!exists) return { pid: null, running: false };
  try {
    const raw = fs ? fs.readFile(pidPath) : readFileSync(pidPath, 'utf-8');
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return { pid: null, running: false };
    try {
      process.kill(pid, 0);
      return { pid, running: true };
    } catch {
      return { pid: null, running: false };
    }
  } catch {
    return { pid: null, running: false };
  }
}

function startPipelinePoller(opts: StartWatchersOptions): () => void {
  const intervalMs = opts.pipelinePollMs ?? 2000;
  const previous = new Map<string, PollState>();

  const tick = (): void => {
    const projDir = projectsDir();
    // 读目录需要 real fs —— pipelinePoller 总是对真实磁盘扫
    let names: string[] = [];
    try {
      names = readdirSync(projDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return;
    }
    for (const name of names) {
      const state = readSupervisorState(opts.fs, supervisorPidFile(name));
      const prev = previous.get(name);
      if (!prev || prev.running !== state.running || prev.pid !== state.pid) {
        if (state.running && state.pid !== null) {
          opts.bus.emit({
            type: 'pipeline.started',
            project: name,
            pid: state.pid,
            ts: opts.clock?.now() ?? Date.now(),
          });
        } else {
          opts.bus.emit({
            type: 'pipeline.stopped',
            project: name,
            ts: opts.clock?.now() ?? Date.now(),
          });
        }
        previous.set(name, state);
      }
    }
  };

  const id = setInterval(tick, intervalMs);
  tick();
  return () => clearInterval(id);
}

