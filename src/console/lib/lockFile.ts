/**
 * @module        console/lib/lockFile
 * @description   单实例锁：~/.coral/console.lock 保存运行中 console 的 pid + port。
 *                stale lock (进程已死) 会被重建。
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LockPayload {
  pid: number;
  port: number;
  startedAt: string;
  version: string;
}

const HOME = process.env.HOME || '/home/coral';
export const LOCK_PATH = resolve(HOME, '.coral', 'console.lock');

export function readLock(): LockPayload | null {
  if (!existsSync(LOCK_PATH)) return null;
  try {
    return JSON.parse(readFileSync(LOCK_PATH, 'utf-8')) as LockPayload;
  } catch {
    return null;
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(pid: number, port: number, version: string): void {
  const payload: LockPayload = {
    pid,
    port,
    startedAt: new Date().toISOString(),
    version,
  };
  writeFileSync(LOCK_PATH, JSON.stringify(payload, null, 2));
}

export function releaseLock(): void {
  try {
    if (existsSync(LOCK_PATH)) unlinkSync(LOCK_PATH);
  } catch {
    /* ignore */
  }
}

/**
 * 检查已有 console 是否活着。
 * @returns payload if another console is running, null otherwise
 */
export function detectRunningConsole(): LockPayload | null {
  const lock = readLock();
  if (!lock) return null;
  if (isProcessAlive(lock.pid)) return lock;
  // stale lock —— 清理
  releaseLock();
  return null;
}
