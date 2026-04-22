/**
 * @module        console-server/watchers/cardWatcher
 * @description   chokidar 监听 cards 目录变化，推 card.created/updated/deleted 事件
 *
 * v0.49.8：chokidar v4+ 删除了 glob 支持（官方 breaking change）。
 *   所以 v0.44.0 写的 `projects/.../cards/*.md` glob 一直不工作，
 *   SSE 实时更新从上线就是假的。改为 watch 项目根目录递归 + 事件过滤。
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { resolve } from 'node:path';
import { readCard } from '../lib/cardReader.js';
import { eventBus } from '../sse/eventBus.js';

const HOME = process.env.HOME || '/home/coral';

function extractProjectAndSeq(path: string): { project: string; seq: number } | null {
  // 允许可选的 state 子目录层级（cards/<state>/N-title.md）+ 兼容顶层 cards/N.md
  const match = path.match(/projects\/([^/]+)\/cards\/(?:[^/]+\/)?(\d+)(?:-[^/]*)?\.md$/);
  if (!match) return null;
  const seq = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isFinite(seq)) return null;
  return { project: match[1] ?? '', seq };
}

function publishCardEvent(event: string, path: string): void {
  const info = extractProjectAndSeq(path);
  if (!info) return;
  const projectDir = resolve(HOME, '.coral', 'projects', info.project);
  if (event === 'card.deleted') {
    eventBus.publish('card.deleted', info);
    return;
  }
  const card = readCard(projectDir, info.seq);
  eventBus.publish(event, {
    project: info.project,
    seq: info.seq,
    card: card ?? null,
  });
}

/**
 * Chokidar v4+ 没 glob 了，只能 watch 绝对路径（文件或目录）。
 * 策略：watch `${coralRoot}/projects` 根，让 chokidar 递归监听所有子目录。
 * 进 event handler 后用 extractProjectAndSeq 正则挑出卡片 md 文件。
 * 其它 md 文件（conf、pipeline.yaml 等不是 md、自动过滤掉）。
 */
export function startCardWatcher(coralRoot: string): FSWatcher {
  const root = resolve(coralRoot, 'projects');
  const watcher = chokidar.watch(root, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    // Depth 4 够：projects/<name>/cards/<state>/<file>.md
    depth: 4,
    // 忽略 node_modules / .git / 隐藏文件
    ignored: (path: string) => /\/(node_modules|\.git|\.DS_Store)(\/|$)/.test(path),
  });

  const handle = (event: string, path: string): void => {
    if (!path.endsWith('.md')) return;
    publishCardEvent(event, path);
  };

  watcher
    .on('add', (path) => handle('card.created', path))
    .on('change', (path) => handle('card.updated', path))
    .on('unlink', (path) => handle('card.deleted', path));
  return watcher;
}
