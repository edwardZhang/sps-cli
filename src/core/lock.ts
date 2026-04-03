/**
 * @module        lock
 * @description   Tick 级文件锁实现，防止并发调度冲突
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-19
 * @updated       2026-04-03
 *
 * @role          util
 * @layer         core
 * @boundedContext concurrency
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface LockInfo {
  pid: number;
  startedAt: string;
}

import { isProcessAlive as isPidAlive } from '../providers/outputParser.js';

export interface AcquireLockResult {
  acquired: boolean;
  reason?: 'another_tick_running' | 'stale_lock_reclaimed';
}

/**
 * Acquire a tick lock. Returns whether the lock was successfully acquired.
 * If a stale lock (dead PID or timed out) is found, it is reclaimed.
 */
export function acquireTickLock(lockFile: string, timeoutMinutes: number): AcquireLockResult {
  const dir = dirname(lockFile);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const hadExistingLock = existsSync(lockFile);

  if (hadExistingLock) {
    try {
      const content = readFileSync(lockFile, 'utf-8');
      const lock: LockInfo = JSON.parse(content);

      // Check if PID is still alive
      if (isPidAlive(lock.pid)) {
        // Check timeout
        const elapsed = (Date.now() - new Date(lock.startedAt).getTime()) / 60000;
        if (elapsed < timeoutMinutes) {
          return { acquired: false, reason: 'another_tick_running' };
        }
        // Timed out — force reclaim
      }
      // Dead PID or timed out — remove stale lock
      unlinkSync(lockFile);
    } catch {
      // Corrupt lock file — remove it
      try { unlinkSync(lockFile); } catch { /* ignore */ }
    }
  }

  // Write new lock atomically: temp file + rename
  const lock: LockInfo = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  const tmpFile = `${lockFile}.${process.pid}.tmp`;
  writeFileSync(tmpFile, JSON.stringify(lock) + '\n');
  renameSync(tmpFile, lockFile);
  return { acquired: true, reason: hadExistingLock ? 'stale_lock_reclaimed' : undefined };
}

/**
 * Release the tick lock. Safe to call even if lock doesn't exist.
 */
export function releaseTickLock(lockFile: string): void {
  try {
    if (existsSync(lockFile)) {
      unlinkSync(lockFile);
    }
  } catch {
    // Best effort
  }
}
