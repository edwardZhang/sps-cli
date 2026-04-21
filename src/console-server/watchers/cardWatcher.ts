/**
 * @module        console-server/watchers/cardWatcher
 * @description   chokidar 监听 cards 目录变化，推 card.created/updated/deleted 事件
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { resolve } from 'node:path';
import { readCard } from '../lib/cardReader.js';
import { eventBus } from '../sse/eventBus.js';

const HOME = process.env.HOME || '/home/coral';

function extractProjectAndSeq(path: string): { project: string; seq: number } | null {
  const match = path.match(/projects\/([^/]+)\/cards\/(\d+)(?:-[^/]*)?\.md$/);
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

export function startCardWatcher(coralRoot: string): FSWatcher {
  const pattern = `${coralRoot}/projects/*/cards/*.md`;
  const watcher = chokidar.watch(pattern, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  watcher
    .on('add', (path) => publishCardEvent('card.created', path))
    .on('change', (path) => publishCardEvent('card.updated', path))
    .on('unlink', (path) => publishCardEvent('card.deleted', path));
  return watcher;
}
