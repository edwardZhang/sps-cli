import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireTickLock, releaseTickLock } from './lock.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sps-lock-test-'));
}

describe('acquireTickLock', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('acquires lock when no lock file exists (reason undefined)', () => {
    const lockFile = join(tempDir, 'tick.lock');
    const result = acquireTickLock(lockFile, 30);

    expect(result.acquired).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(existsSync(lockFile)).toBe(true);

    const content = JSON.parse(readFileSync(lockFile, 'utf-8'));
    expect(content.pid).toBe(process.pid);
    expect(content.startedAt).toBeDefined();
  });

  it('rejects when another live process holds the lock', () => {
    const lockFile = join(tempDir, 'tick.lock');
    // Write a lock with current PID (which is alive)
    writeFileSync(lockFile, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }) + '\n');

    const result = acquireTickLock(lockFile, 30);
    expect(result.acquired).toBe(false);
    expect(result.reason).toBe('another_tick_running');
  });

  it('reclaims lock when PID is dead (reason stale_lock_reclaimed)', () => {
    const lockFile = join(tempDir, 'tick.lock');
    writeFileSync(lockFile, JSON.stringify({
      pid: 4_000_000,
      startedAt: new Date().toISOString(),
    }) + '\n');

    const result = acquireTickLock(lockFile, 30);
    expect(result.acquired).toBe(true);
    expect(result.reason).toBe('stale_lock_reclaimed');

    const content = JSON.parse(readFileSync(lockFile, 'utf-8'));
    expect(content.pid).toBe(process.pid);
  });

  it('reclaims lock when timed out even if PID is alive', () => {
    const lockFile = join(tempDir, 'tick.lock');
    // Write a lock from current process but started 60 minutes ago
    const pastTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writeFileSync(lockFile, JSON.stringify({
      pid: process.pid,
      startedAt: pastTime,
    }) + '\n');

    const result = acquireTickLock(lockFile, 30); // 30 min timeout, 60 min elapsed
    expect(result.acquired).toBe(true);
  });

  it('does not reclaim when within timeout', () => {
    const lockFile = join(tempDir, 'tick.lock');
    // Write lock from current process, started just now
    writeFileSync(lockFile, JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
    }) + '\n');

    const result = acquireTickLock(lockFile, 30);
    expect(result.acquired).toBe(false);
  });

  it('handles corrupt lock file', () => {
    const lockFile = join(tempDir, 'tick.lock');
    writeFileSync(lockFile, 'NOT VALID JSON\n');

    const result = acquireTickLock(lockFile, 30);
    expect(result.acquired).toBe(true);
  });

  it('creates parent directories if needed', () => {
    const lockFile = join(tempDir, 'deep', 'nested', 'tick.lock');
    const result = acquireTickLock(lockFile, 30);
    expect(result.acquired).toBe(true);
    expect(existsSync(lockFile)).toBe(true);
  });
});

describe('releaseTickLock', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('removes the lock file', () => {
    const lockFile = join(tempDir, 'tick.lock');
    acquireTickLock(lockFile, 30);
    expect(existsSync(lockFile)).toBe(true);

    releaseTickLock(lockFile);
    expect(existsSync(lockFile)).toBe(false);
  });

  it('does nothing when lock file does not exist', () => {
    const lockFile = join(tempDir, 'nonexistent.lock');
    expect(() => releaseTickLock(lockFile)).not.toThrow();
  });

  it('acquire then release then re-acquire works', () => {
    const lockFile = join(tempDir, 'tick.lock');
    acquireTickLock(lockFile, 30);
    releaseTickLock(lockFile);
    const result = acquireTickLock(lockFile, 30);
    expect(result.acquired).toBe(true);
  });
});
