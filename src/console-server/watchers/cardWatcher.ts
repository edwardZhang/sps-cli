/**
 * @module        console-server/watchers/cardWatcher
 * @description   chokidar 监听 ~/.coral/cards 目录，变化推 eventBus
 *
 * 文件变化 → card.created / card.updated / card.deleted 事件
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { basename } from 'node:path';
import { eventBus } from '../sse/eventBus.js';

function extractProjectAndSeq(path: string): { project: string; seq: number } | null {
  // 路径形如 ~/.coral/projects/<project>/cards/<seq>-<slug>.md
  const match = path.match(/projects\/([^/]+)\/cards\/(\d+)(?:-[^/]*)?\.md$/);
  if (!match) return null;
  return { project: match[1], seq: Number.parseInt(match[2], 10) };
}

export function startCardWatcher(coralRoot: string): FSWatcher {
  const pattern = `${coralRoot}/cards 目录`;
  const watcher = chokidar.watch(pattern, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher
    .on('add', (path) => {
      const info = extractProjectAndSeq(path);
      if (info) eventBus.publish('card.created', { ...info, path: basename(path) });
    })
    .on('change', (path) => {
      const info = extractProjectAndSeq(path);
      if (info) eventBus.publish('card.updated', { ...info, path: basename(path) });
    })
    .on('unlink', (path) => {
      const info = extractProjectAndSeq(path);
      if (info) eventBus.publish('card.deleted', info);
    });

  return watcher;
}
