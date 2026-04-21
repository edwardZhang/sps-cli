/**
 * @module        console-server/watchers/markerWatcher
 * @description   监听 runtime/worker-*-current.json，推 worker.updated 事件
 */
import chokidar, { type FSWatcher } from 'chokidar';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { eventBus } from '../sse/eventBus.js';

function extractProjectAndSlot(path: string): { project: string; slot: number } | null {
  const m = path.match(/projects\/([^/]+)\/runtime\/worker-(\d+)-current\.json$/);
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
  const pattern = `${coralRoot}/projects/*/runtime/worker-*-current.json`;
  const watcher = chokidar.watch(pattern, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 40 },
  });
  watcher
    .on('add', (path) => publishMarker('worker.added', path))
    .on('change', (path) => publishMarker('worker.updated', path))
    .on('unlink', (path) => publishMarker('worker.deleted', path));
  return watcher;
}
