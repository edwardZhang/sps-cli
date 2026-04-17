/**
 * @module        sessionCleanup.test
 * @description   孤儿 ACP session 清理的单元测试
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-04-17
 * @updated       2026-04-17
 *
 * @role          test
 * @layer         core
 * @boundedContext session-lifecycle
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectContext } from './context.js';
import { Logger } from './logger.js';
import { cleanupOrphanAcpSessions } from './sessionCleanup.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sps-session-cleanup-test-'));
}

function makeCtx(tempDir: string): ProjectContext {
  return {
    projectName: 'test',
    maxWorkers: 1,
    paths: { stateFile: join(tempDir, 'state.json') },
  } as unknown as ProjectContext;
}

function writeState(tempDir: string, sessions: Record<string, unknown>): void {
  const state = {
    version: 3,
    updatedAt: new Date().toISOString(),
    updatedBy: 'test-setup',
    workers: {},
    leases: {},
    activeCards: {},
    worktreeEvidence: {},
    pendingPMActions: [],
    sessions,
  };
  writeFileSync(join(tempDir, 'state.json'), JSON.stringify(state));
}

function readSessions(tempDir: string): Record<string, unknown> {
  const content = JSON.parse(readFileSync(join(tempDir, 'state.json'), 'utf-8'));
  return content.sessions ?? {};
}

/** Spawn a long-lived child process for use as a live orphan target. */
function spawnVictim(): { pid: number; kill: () => void } {
  const child = spawn('sleep', ['30'], { detached: false, stdio: 'ignore' });
  if (!child.pid) throw new Error('failed to spawn test victim');
  return {
    pid: child.pid,
    kill: () => { try { child.kill('SIGKILL'); } catch { /* noop */ } },
  };
}

describe('cleanupOrphanAcpSessions', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('clears stale session records whose pid is already dead', async () => {
    // Pid 1 (init) is always alive, but we want "already dead" — use a clearly
    // invalid pid (e.g. one that would fail isProcessAlive).
    // A PID so large it can't exist. Linux defaults cap at 4194304.
    const DEAD_PID = 9_999_999;
    writeState(tempDir, {
      'worker-1': {
        slot: 'worker-1', tool: 'claude', sessionId: 'old-session',
        sessionName: 'sps-acp-test-worker-1', pid: DEAD_PID, cwd: '/tmp',
        status: 'idle', sessionState: 'ready', currentRun: null, pendingInput: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        lastSeenAt: null, lastPaneText: '',
      },
    });

    const ctx = makeCtx(tempDir);
    const log = new Logger('test', 'test');
    const result = await cleanupOrphanAcpSessions(ctx, log);

    expect(result.cleaned).toBe(1);
    expect(result.killed).toBe(0);
    expect(readSessions(tempDir)).toEqual({});
  });

  it('kills live orphan process and clears its record', async () => {
    const victim = spawnVictim();
    try {
      writeState(tempDir, {
        'worker-1': {
          slot: 'worker-1', tool: 'claude', sessionId: 's1',
          sessionName: 'sps-acp-test-worker-1', pid: victim.pid, cwd: '/tmp',
          status: 'active', sessionState: 'busy', currentRun: null, pendingInput: null,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          lastSeenAt: null, lastPaneText: '',
        },
      });

      const ctx = makeCtx(tempDir);
      const log = new Logger('test', 'test');
      const result = await cleanupOrphanAcpSessions(ctx, log);

      expect(result.cleaned).toBe(1);
      expect(result.killed).toBe(1);
      expect(readSessions(tempDir)).toEqual({});

      // Give kill some time, then verify the victim is actually dead
      await new Promise((r) => setTimeout(r, 500));
      let alive = true;
      try { process.kill(victim.pid, 0); } catch { alive = false; }
      expect(alive).toBe(false);
    } finally {
      victim.kill();
    }
  });

  it('does NOT touch harness session-* slots', async () => {
    const harnessSession = {
      slot: 'session-my-chat', tool: 'claude', sessionId: 'chat-session',
      sessionName: 'sps-session-my-chat', pid: 9_999_999, cwd: '/tmp',
      status: 'idle', sessionState: 'ready', currentRun: null, pendingInput: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      lastSeenAt: null, lastPaneText: '',
    };
    writeState(tempDir, {
      'worker-1': {
        slot: 'worker-1', tool: 'claude', sessionId: 'old',
        sessionName: 'sps-acp-test-worker-1', pid: 9_999_999, cwd: '/tmp',
        status: 'idle', sessionState: 'ready', currentRun: null, pendingInput: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        lastSeenAt: null, lastPaneText: '',
      },
      'session-my-chat': harnessSession,
    });

    const ctx = makeCtx(tempDir);
    const log = new Logger('test', 'test');
    const result = await cleanupOrphanAcpSessions(ctx, log);

    expect(result.cleaned).toBe(1);  // only worker-1
    expect(result.killed).toBe(0);
    const remaining = readSessions(tempDir);
    expect(remaining['worker-1']).toBeUndefined();
    expect(remaining['session-my-chat']).toBeDefined();
  });

  it('returns zero counts when no pipeline sessions exist', async () => {
    writeState(tempDir, {});

    const ctx = makeCtx(tempDir);
    const log = new Logger('test', 'test');
    const result = await cleanupOrphanAcpSessions(ctx, log);

    expect(result.cleaned).toBe(0);
    expect(result.killed).toBe(0);
  });
});
