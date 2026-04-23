/**
 * @module        console-server/watchers/markerWatcher
 * @description   监听 runtime/worker-*-current.json，推 worker.updated 事件
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { eventBus } from '../sse/eventBus.js';

function extractProjectAndSlot(path: string): { project: string; slot: number } | null {
  // v0.49.16：marker 文件真实格式 worker-worker-N-current.json（worker-manager 传 slot="worker-N"），
  // 兼容单前缀老格式。
  const m = path.match(/projects\/([^/]+)\/runtime\/worker-(?:worker-)?(\d+)-current\.json$/);
  if (!m) return null;
  const slot = Number.parseInt(m[2] ?? '', 10);
  if (!Number.isFinite(slot)) return null;
  return { project: m[1] ?? '', slot };
}

function publishMarker(event: string, path: string): void {
  const info = extractProjectAndSlot(path);
  if (!info) return;
  let marker: unknown = null;
  if (event !== 'worker.deleted' && existsSync(path)) {
    try {
      marker = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      // 写入中，下次再推
      return;
    }
  }
  eventBus.publish('worker.updated', {
    project: info.project,
    slot: info.slot,
    marker,
    markerFile: basename(path),
    deleted: event === 'worker.deleted',
  });
}

export function startMarkerWatcher(coralRoot: string): FSWatcher {
  // v0.49.8：chokidar v4+ 没 glob，改 watch 根目录 + 事件过滤（同 cardWatcher）
  const root = `${coralRoot}/projects`;
  const watcher = chokidar.watch(root, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 40 },
    depth: 3, // projects/<name>/runtime/worker-N-current.json
    ignored: (path: string) => /\/(node_modules|\.git|\.DS_Store)(\/|$)/.test(path),
  });

  const handle = (event: string, path: string): void => {
    if (!/worker-(?:worker-)?\d+-current\.json$/.test(path)) return;
    publishMarker(event, path);
  };

  watcher
    .on('add', (path) => handle('worker.added', path))
    .on('change', (path) => handle('worker.updated', path))
    .on('unlink', (path) => handle('worker.deleted', path));
  return watcher;
}
