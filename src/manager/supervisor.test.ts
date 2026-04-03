import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProcessSupervisor, type WorkerHandle, type SpawnOpts } from './supervisor.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sps-sup-test-'));
}

function makeSupervisor(): ProcessSupervisor {
  return new ProcessSupervisor();
}

/** Create a handle suitable for registerAcpHandle (transport omitted, added by normalize) */
function makeHandle(id: string, overrides?: Record<string, unknown>) {
  return {
    id,
    pid: 12345,
    outputFile: '/tmp/output.jsonl',
    project: 'test',
    seq: '1',
    slot: 'worker-1',
    branch: 'feat-1',
    worktree: '/tmp/wt',
    tool: 'claude' as const,
    exitCode: null,
    sessionId: null,
    runId: null,
    sessionState: null,
    remoteStatus: null,
    lastEventAt: null,
    startedAt: '2026-01-01T00:00:00.000Z',
    exitedAt: null,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('ProcessSupervisor', () => {
  let sup: ProcessSupervisor;

  beforeEach(() => {
    sup = makeSupervisor();
  });

  describe('get / getAll / getByProject / activeCount', () => {
    it('returns undefined for unknown handle', () => {
      expect(sup.get('nonexistent')).toBeUndefined();
    });

    it('starts with zero active workers', () => {
      expect(sup.activeCount).toBe(0);
      expect(sup.getAll()).toEqual([]);
    });

    it('registerAcpHandle adds a handle', () => {
      const handle = makeHandle('test:worker-1:5', { transport: 'acp-sdk' as any });
      sup.registerAcpHandle(handle);
      expect(sup.activeCount).toBe(1);
      expect(sup.get('test:worker-1:5')).toBeDefined();
      expect(sup.get('test:worker-1:5')!.transport).toBe('acp-sdk');
    });

    it('getByProject filters by project', () => {
      sup.registerAcpHandle(makeHandle('proj-a:w1:1', { project: 'proj-a' }));
      sup.registerAcpHandle(makeHandle('proj-b:w1:2', { project: 'proj-b' }));
      sup.registerAcpHandle(makeHandle('proj-a:w2:3', { project: 'proj-a' }));

      const projA = sup.getByProject('proj-a');
      expect(projA).toHaveLength(2);
      expect(projA.every(h => h.project === 'proj-a')).toBe(true);

      const projB = sup.getByProject('proj-b');
      expect(projB).toHaveLength(1);
    });

    it('getAll returns all handles', () => {
      sup.registerAcpHandle(makeHandle('a:w1:1'));
      sup.registerAcpHandle(makeHandle('b:w1:2'));
      expect(sup.getAll()).toHaveLength(2);
    });
  });

  describe('remove', () => {
    it('removes a handle by id', () => {
      sup.registerAcpHandle(makeHandle('test:w1:1'));
      expect(sup.activeCount).toBe(1);
      sup.remove('test:w1:1');
      expect(sup.activeCount).toBe(0);
      expect(sup.get('test:w1:1')).toBeUndefined();
    });

    it('does nothing for unknown id', () => {
      sup.remove('nonexistent');
      expect(sup.activeCount).toBe(0);
    });
  });

  describe('updateAcpHandle', () => {
    it('patches an existing handle', () => {
      sup.registerAcpHandle(makeHandle('test:w1:1'));
      const updated = sup.updateAcpHandle('test:w1:1', {
        sessionId: 'sess-abc',
        remoteStatus: 'running',
        exitCode: null,
      });
      expect(updated).toBeDefined();
      expect(updated!.sessionId).toBe('sess-abc');
      expect(updated!.remoteStatus).toBe('running');
    });

    it('returns undefined for unknown handle', () => {
      const result = sup.updateAcpHandle('nonexistent', { exitCode: 0 });
      expect(result).toBeUndefined();
    });

    it('patches exitCode and exitedAt', () => {
      sup.registerAcpHandle(makeHandle('test:w1:1'));
      const updated = sup.updateAcpHandle('test:w1:1', {
        exitCode: 0,
        exitedAt: '2026-01-02T00:00:00.000Z',
      });
      expect(updated!.exitCode).toBe(0);
      expect(updated!.exitedAt).toBe('2026-01-02T00:00:00.000Z');
    });

    it('patches lastEventAt', () => {
      sup.registerAcpHandle(makeHandle('test:w1:1'));
      const updated = sup.updateAcpHandle('test:w1:1', {
        lastEventAt: '2026-01-02T12:00:00.000Z',
      });
      expect(updated!.lastEventAt).toBe('2026-01-02T12:00:00.000Z');
    });
  });

  describe('drainPendingActions', () => {
    it('resolves immediately when no pending actions', async () => {
      await expect(sup.drainPendingActions()).resolves.toBeUndefined();
    });
  });

  describe('registerAcpHandle / normalizeAcpHandle', () => {
    it('normalizes transport to acp', () => {
      const handle = makeHandle('test:w1:1');
      const registered = sup.registerAcpHandle(handle);
      expect(registered.transport).toBe('acp-sdk');
      expect(registered.pid).toBeNull();
    });

    it('preserves sessionId and runId', () => {
      const handle = makeHandle('test:w1:1', {
        sessionId: 'sess-xyz',
        runId: 'run-123',
      });
      const registered = sup.registerAcpHandle(handle);
      expect(registered.sessionId).toBe('sess-xyz');
      expect(registered.runId).toBe('run-123');
    });

    it('defaults nullable fields to null', () => {
      const handle = makeHandle('test:w1:1');
      // Remove optional fields
      delete (handle as any).runId;
      delete (handle as any).sessionState;
      delete (handle as any).remoteStatus;
      delete (handle as any).lastEventAt;
      delete (handle as any).outputFile;

      const registered = sup.registerAcpHandle(handle);
      expect(registered.runId).toBeNull();
      expect(registered.sessionState).toBeNull();
      expect(registered.remoteStatus).toBeNull();
      expect(registered.lastEventAt).toBeNull();
      expect(registered.outputFile).toBeNull();
    });
  });

  describe('kill', () => {
    it('does nothing for unknown handle', async () => {
      await expect(sup.kill('nonexistent')).resolves.toBeUndefined();
    });

    it('removes handle after kill (ACP handle, no real PID)', async () => {
      sup.registerAcpHandle(makeHandle('test:w1:1', { pid: null }));
      expect(sup.activeCount).toBe(1);
      await sup.kill('test:w1:1');
      expect(sup.activeCount).toBe(0);
    });
  });

  describe('reloadGlobalEnv', () => {
    it('reloads without error', () => {
      expect(() => sup.reloadGlobalEnv()).not.toThrow();
    });
  });

  describe('monitorOrphanPid', () => {
    it('registers orphan handle and tracks it', () => {
      const handle = { ...makeHandle('test:w1:1', { pid: 99999 }), transport: 'acp-sdk' as const };
      sup.monitorOrphanPid(
        'test:w1:1',
        99999,
        handle,
        () => {},
      );
      expect(sup.get('test:w1:1')).toBeDefined();
      expect(sup.activeCount).toBe(1);
      sup.remove('test:w1:1');
    });

    it('calls onDead when PID dies (dead PID detected on first poll)', async () => {
      const deadPid = 4_000_000;
      const handle = { ...makeHandle('test:w1:dead', { pid: deadPid }), transport: 'acp-sdk' as const };

      const deadPromise = new Promise<number>((resolve) => {
        sup.monitorOrphanPid(
          'test:w1:dead',
          deadPid,
          handle,
          (exitCode) => resolve(exitCode),
        );
      });

      // The 5s poll interval will detect the dead PID on first tick
      const exitCode = await deadPromise;
      expect(typeof exitCode).toBe('number');
      sup.remove('test:w1:dead');
    }, 10_000);
  });

  describe('multiple handle upserts', () => {
    it('upsert replaces existing handle with same id', () => {
      sup.registerAcpHandle(makeHandle('test:w1:1', { sessionId: 'old' }));
      sup.registerAcpHandle(makeHandle('test:w1:1', { sessionId: 'new' }));

      expect(sup.activeCount).toBe(1);
      expect(sup.get('test:w1:1')!.sessionId).toBe('new');
    });
  });
});
