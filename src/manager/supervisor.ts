/**
 * @module        supervisor
 * @description   进程监管器，管理 Worker 句柄生命周期、终止与孤儿监控
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-25
 * @updated       2026-04-03
 *
 * @role          manager
 * @layer         manager
 * @boundedContext worker-lifecycle
 */
import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { parseShellConf, } from '../core/shellEnv.js';
import { extractLastAssistantText, isProcessAlive, killProcessGroup, parseClaudeSessionId } from '../providers/outputParser.js';

// ─── Types ──────────────────────────────────────────────────────

export interface SpawnOpts {
  /** Unique worker ID: `${project}:${slot}:${seq}` */
  id: string;
  project: string;
  seq: string;
  slot: string;
  worktree: string;
  branch: string;
  prompt: string;
  outputFile: string;
  tool: 'claude';
  resumeSessionId?: string;
  /** Called when child process exits. Return value is tracked as pending PostAction. */
  onExit: (exitCode: number) => Promise<void> | void;
}

/** An exit event waiting to be processed */
export interface ExitEvent {
  id: string;
  exitCode: number;
  handle: WorkerHandle;
}

export interface WorkerHandle {
  id: string;
  transport: 'acp-sdk';
  pid: number | null;
  child: ChildProcess | null;
  outputFile: string | null;
  project: string;
  seq: string;
  slot: string;
  branch: string;
  worktree: string;
  tool: 'claude';
  exitCode: number | null;
  sessionId: string | null;
  runId: string | null;
  sessionState: 'booting' | 'ready' | 'busy' | 'needs_confirmation' | 'draining' | 'offline' | null;
  remoteStatus: 'submitted' | 'running' | 'waiting_input' | 'needs_confirmation' | 'stalled_submit' | 'completed' | 'failed' | 'cancelled' | 'lost' | null;
  lastEventAt: string | null;
  startedAt: string;
  exitedAt: string | null;
}

// ─── Supervisor ─────────────────────────────────────────────────

export class ProcessSupervisor {
  /** Global env: process.env + ~/.coral/env (Layer 1+2) */
  private globalEnv: Record<string, string>;
  /** Active worker handles by ID */
  private readonly workers = new Map<string, WorkerHandle>();
  /** Orphan PID poll timers (for Recovery) */
  private readonly orphanTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** Pending PostAction promises (from exit callbacks) */
  private readonly pendingActions: Promise<void>[] = [];

  constructor() {
    this.globalEnv = this.loadGlobalEnv();
  }

  // ─── Spawn (removed — all workers use ACP transport via AgentRuntime) ──

  // ─── Kill / Query ───────────────────────────────────────────

  async kill(id: string): Promise<void> {
    const handle = this.workers.get(id);
    if (!handle) return;
    if (handle.pid && handle.pid > 0 && isProcessAlive(handle.pid)) {
      await killProcessGroup(handle.pid);
    }
    this.workers.delete(id);
  }

  get(id: string): WorkerHandle | undefined {
    return this.workers.get(id);
  }

  getByProject(project: string): WorkerHandle[] {
    return Array.from(this.workers.values()).filter(w => w.project === project);
  }

  getAll(): WorkerHandle[] {
    return Array.from(this.workers.values());
  }

  remove(id: string): void {
    this.workers.delete(id);
    const timer = this.orphanTimers.get(id);
    if (timer) {
      clearInterval(timer);
      this.orphanTimers.delete(id);
    }
  }

  get activeCount(): number {
    return this.workers.size;
  }

  registerAcpHandle(
    handle: Omit<WorkerHandle, 'child' | 'transport'> & { child?: ChildProcess | null; transport?: 'acp-sdk' },
  ): WorkerHandle {
    return this.upsertHandle(this.normalizeAcpHandle(handle));
  }

  updateAcpHandle(
    id: string,
    patch: Partial<Pick<WorkerHandle, 'sessionId' | 'runId' | 'sessionState' | 'remoteStatus' | 'lastEventAt' | 'exitCode' | 'exitedAt' | 'outputFile'>>,
  ): WorkerHandle | undefined {
    const current = this.workers.get(id);
    if (!current) return undefined;
    return this.upsertHandle(this.normalizeAcpHandle({ ...current, ...patch }));
  }

  /**
   * Wait for all pending PostAction promises to settle.
   * Called by tick after each cycle to ensure exit callbacks complete.
   */
  async drainPendingActions(): Promise<void> {
    if (this.pendingActions.length === 0) return;
    await Promise.allSettled(this.pendingActions);
    this.pendingActions.length = 0; // clear
  }

  // ─── Orphan PID Monitoring (Recovery mode) ──────────────────

  /**
   * Monitor a PID that we don't have a child handle for (tick restarted).
   * Polls every 5s; when PID dies, calls onDead.
   */
  monitorOrphanPid(
    id: string,
    pid: number,
    handle: Omit<WorkerHandle, 'child'>,
    onDead: (exitCode: number) => Promise<void> | void,
  ): void {
    // Clear any existing orphan timer for this ID to prevent stale polls
    const existingTimer = this.orphanTimers.get(id);
    if (existingTimer) {
      clearInterval(existingTimer);
      this.orphanTimers.delete(id);
    }

    // Store handle without child reference
    const orphanHandle: WorkerHandle = {
      ...handle,
      transport: 'acp-sdk',
      child: null,
      pid,
      outputFile: handle.outputFile ?? null,
      runId: handle.runId ?? null,
      sessionState: handle.sessionState ?? null,
      remoteStatus: handle.remoteStatus ?? null,
      lastEventAt: handle.lastEventAt ?? null,
    };
    this.upsertHandle(orphanHandle);

    const timer = setInterval(() => {
      if (!isProcessAlive(pid)) {
        clearInterval(timer);
        this.orphanTimers.delete(id);

        // Infer exit code from output file instead of hardcoding 1
        const inferredCode = this.inferExitCode(orphanHandle);
        orphanHandle.exitCode = inferredCode;
        orphanHandle.exitedAt = new Date().toISOString();

        // Try to extract session ID
        if (!orphanHandle.sessionId) {
          orphanHandle.sessionId = this.extractSessionId(orphanHandle);
        }

        this.log(`Orphan PID ${pid} (${id}) is dead (inferred exitCode=${inferredCode}), triggering completion check`);

        // Track the promise like spawn exit callbacks
        const result = onDead(inferredCode);
        if (result && typeof (result as Promise<void>).then === 'function') {
          const promise = (result as Promise<void>).catch(err => {
            this.log(`PostActions error for orphan ${id}: ${err}`);
          });
          this.pendingActions.push(promise);
        }
      }
    }, 5_000);

    this.orphanTimers.set(id, timer);
    this.log(`Monitoring orphan PID ${pid} for ${id} (5s poll)`);
  }

  /**
   * Infer exit code for an orphan worker by checking output file.
   * If output contains a successful result, assume exit code 0.
   */
  private inferExitCode(handle: { outputFile: string | null; tool: string }): number {
    if (!handle.outputFile) return 1;
    try {
      const lastText = extractLastAssistantText(handle.outputFile);
      // If worker produced meaningful output and said "done", likely succeeded
      if (/\b(done|完成|全部完成|已推送)\b|🎉/i.test(lastText)) {
        return 0;
      }
    } catch { /* can't read output */ }
    return 1; // default to failure if can't determine
  }

  // ─── Environment Loading ────────────────────────────────────

  private loadGlobalEnv(): Record<string, string> {
    const env = { ...process.env } as Record<string, string>;
    const envPath = resolve(homedir(), '.coral', 'env');
    if (existsSync(envPath)) {
      Object.assign(env, parseShellConf(envPath));
    }
    return env;
  }

  reloadGlobalEnv(): void {
    this.globalEnv = this.loadGlobalEnv();
    this.log('Global environment reloaded');
  }

  // ─── Helpers ────────────────────────────────────────────────

  private extractSessionId(handle: WorkerHandle): string | null {
    if (!handle.outputFile) return null;
    return parseClaudeSessionId(handle.outputFile);
  }

  private log(msg: string): void {
    process.stderr.write(`[supervisor] ${msg}\n`);
  }

  private normalizeAcpHandle(
    handle: Omit<WorkerHandle, 'transport' | 'child'> & { child?: ChildProcess | null; transport?: 'acp-sdk' },
  ): WorkerHandle {
    return {
      ...handle,
      transport: 'acp-sdk',
      pid: null,
      child: handle.child ?? null,
      outputFile: handle.outputFile ?? null,
      runId: handle.runId ?? null,
      sessionState: handle.sessionState ?? null,
      remoteStatus: handle.remoteStatus ?? null,
      lastEventAt: handle.lastEventAt ?? null,
    };
  }

  private upsertHandle(handle: WorkerHandle): WorkerHandle {
    this.workers.set(handle.id, handle);
    return handle;
  }
}
