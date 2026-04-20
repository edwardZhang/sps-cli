/**
 * @module        markerFile
 * @description   Per-slot "current card" marker file read/write utilities
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @role          core
 * @layer         core
 * @boundedContext agent-hooks
 *
 * 设计说明：
 * - 每次 SPS 派发卡到 worker slot 之前，原子写入 marker 文件
 * - 路径：<runtime-dir>/worker-<slot>-current.json
 * - 内容：{ cardId, stage, dispatchedAt }
 * - 原因：claude 子进程 env 在 spawn 时冻结；多卡复用时 env 会 stale。hook
 *   脚本必须通过文件反查当前卡，不能信 env。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface CurrentCardMarker {
  cardId: string;
  stage: string;
  dispatchedAt: string;
  /** ACP session ID — set after spawn succeeds (optional for backward compat). */
  sessionId?: string;
  /** Claude-agent-acp PID — set after spawn succeeds (optional for backward compat). */
  pid?: number;
}

/**
 * Build the marker file path from project + slot name.
 * Reads HOME fresh each call so tests can override via `process.env.HOME`.
 */
export function getMarkerPath(project: string, slot: string): string {
  const home = process.env.HOME || '';
  return resolve(home, '.coral', 'projects', project, 'runtime', `worker-${slot}-current.json`);
}

/**
 * Build the marker file path from an existing state file path (worker-manager usage).
 * Keeps all runtime artifacts in the same directory.
 */
export function getMarkerPathFromStateFile(stateFile: string, slot: string): string {
  const runtimeDir = dirname(stateFile);
  return resolve(runtimeDir, `worker-${slot}-current.json`);
}

/**
 * Atomically write the marker file. Uses tmp + rename so readers never see
 * a half-written file. Errors are non-fatal (logged via onError callback) —
 * hook downstream will fail closed (exit 2) rather than silently mis-mark.
 *
 * `extra` adds post-spawn metadata (sessionId, pid) via a second atomic write.
 */
export function writeCurrentCardFile(
  finalPath: string,
  cardId: string,
  stage: string,
  onError?: (err: unknown) => void,
  extra?: { sessionId?: string; pid?: number },
): void {
  try {
    const tmpPath = `${finalPath}.tmp`;
    const payload: CurrentCardMarker = {
      cardId,
      stage,
      dispatchedAt: new Date().toISOString(),
      ...(extra?.sessionId ? { sessionId: extra.sessionId } : {}),
      ...(extra?.pid !== undefined ? { pid: extra.pid } : {}),
    };
    writeFileSync(tmpPath, JSON.stringify(payload));
    renameSync(tmpPath, finalPath);
  } catch (err) {
    if (onError) onError(err);
  }
}

/**
 * Patch an existing marker file with post-spawn metadata (sessionId, pid).
 * Reads current contents → merges new fields → atomic rewrites. Preserves
 * `dispatchedAt` so the ACK-timeout clock is not reset.
 */
export function patchCurrentCardFile(
  finalPath: string,
  patch: { sessionId?: string; pid?: number },
  onError?: (err: unknown) => void,
): void {
  try {
    const existingRaw = readFileSync(finalPath, 'utf-8');
    const existing = JSON.parse(existingRaw) as CurrentCardMarker;
    const merged: CurrentCardMarker = {
      ...existing,
      ...(patch.sessionId ? { sessionId: patch.sessionId } : {}),
      ...(patch.pid !== undefined ? { pid: patch.pid } : {}),
    };
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(merged));
    renameSync(tmpPath, finalPath);
  } catch (err) {
    if (onError) onError(err);
  }
}

/**
 * Read the marker file. Returns null if missing or malformed — callers should
 * treat a null result as "no authoritative current card" and fail closed.
 */
export function readCurrentCardMarker(project: string, slot: string): CurrentCardMarker | null {
  const path = getMarkerPath(project, slot);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.cardId) return null;
    return {
      cardId: String(parsed.cardId),
      stage: String(parsed.stage ?? ''),
      dispatchedAt: String(parsed.dispatchedAt ?? ''),
      ...(parsed.sessionId ? { sessionId: String(parsed.sessionId) } : {}),
      ...(parsed.pid !== undefined ? { pid: Number(parsed.pid) } : {}),
    };
  } catch {
    return null;
  }
}
