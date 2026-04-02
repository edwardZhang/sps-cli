/**
 * ProcessSupervisor — manages worker process lifecycle.
 *
 * Replaces ClaudePrintProvider's spawn logic with:
 * - fd redirect (not Node pipe) for reliable output
 * - Held child handles (no unref) for reliable exit detection
 * - Three-layer env merge (system + global creds + project conf)
 * - Exit callbacks that fire immediately in the tick process
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { openSync, closeSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { isProcessAlive, killProcessGroup, parseClaudeSessionId, parseCodexSessionId, extractLastAssistantText } from '../providers/outputParser.js';
import { parseShellConf, sourceCombinedConf } from '../core/shellEnv.js';
import type { RawConfig } from '../core/config.js';

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
  tool: 'claude' | 'codex';
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
  transport: 'proc' | 'acp';
  pid: number | null;
  child: ChildProcess | null;
  outputFile: string | null;
  project: string;
  seq: string;
  slot: string;
  branch: string;
  worktree: string;
  tool: 'claude' | 'codex';
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

  // ─── Spawn ──────────────────────────────────────────────────

  spawn(opts: SpawnOpts): WorkerHandle {
    // Load project conf (Layer 3) and merge
    const projectEnv = this.loadProjectEnv(opts.project);
    const env = { ...this.globalEnv, ...projectEnv };

    // Build CLI args
    const args = this.buildArgs(opts);

    // Ensure output directory exists
    mkdirSync(dirname(opts.outputFile), { recursive: true });

    // fd redirect: OS kernel writes stdout/stderr directly to file
    const fd = openSync(opts.outputFile, 'a');
    let child: ChildProcess;

    try {
      child = spawn(opts.tool === 'claude' ? 'claude' : 'codex', args, {
        cwd: opts.worktree,
        stdio: ['pipe', fd, fd],
        detached: true,
        env,
      });

      // Write prompt to stdin and close
      child.stdin!.write(opts.prompt);
      child.stdin!.end();
    } finally {
      // Close fd on Node side — child inherits it, OS guarantees write
      // Always close to prevent fd leak even if spawn throws (H4 fix)
      closeSync(fd);
    }

    // DO NOT call child.unref() — tick process holds the handle
    // This ensures exit callback fires reliably

    const handle: WorkerHandle = {
      id: opts.id,
      transport: 'proc',
      pid: child.pid ?? 0,
      child,
      outputFile: opts.outputFile,
      project: opts.project,
      seq: opts.seq,
      slot: opts.slot,
      branch: opts.branch,
      worktree: opts.worktree,
      tool: opts.tool,
      exitCode: null,
      sessionId: opts.resumeSessionId || null,
      runId: null,
      sessionState: null,
      remoteStatus: null,
      lastEventAt: null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
    };

    this.upsertHandle(handle);

    child.on('exit', (code) => {
      handle.exitCode = code ?? 1;
      handle.exitedAt = new Date().toISOString();

      // Extract session ID for potential --resume retry
      if (!handle.sessionId) {
        handle.sessionId = this.extractSessionId(handle);
      }

      // Queue PostActions as tracked promise (not fire-and-forget)
      const result = opts.onExit(handle.exitCode);
      if (result && typeof (result as Promise<void>).then === 'function') {
        const promise = (result as Promise<void>).catch(err => {
          this.log(`PostActions error for ${opts.id}: ${err}`);
        });
        this.pendingActions.push(promise);
      }
    });

    this.log(`Spawned ${opts.tool} for ${opts.id} (pid=${child.pid}), output=${opts.outputFile}`);
    return handle;
  }

  // ─── Kill / Query ───────────────────────────────────────────

  async kill(id: string): Promise<void> {
    const handle = this.workers.get(id);
    if (!handle) return;
    if (handle.transport === 'proc' && handle.pid && handle.pid > 0 && isProcessAlive(handle.pid)) {
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
    handle: Omit<WorkerHandle, 'child' | 'transport'> & { child?: ChildProcess | null; transport?: 'acp' },
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
      transport: 'proc',
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

  private loadProjectEnv(project: string): RawConfig {
    const confPath = resolve(homedir(), '.coral', 'projects', project, 'conf');
    if (!existsSync(confPath)) return {};
    const envPath = resolve(homedir(), '.coral', 'env');
    return sourceCombinedConf([envPath, confPath]);
  }

  reloadGlobalEnv(): void {
    this.globalEnv = this.loadGlobalEnv();
    this.log('Global environment reloaded');
  }

  // ─── Helpers ────────────────────────────────────────────────

  private buildArgs(opts: SpawnOpts): string[] {
    if (opts.tool === 'claude') {
      const args = ['-p', '--verbose', '--output-format', 'stream-json', '--dangerously-skip-permissions'];
      if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
      return args;
    }

    // Codex workers need full local access in SPS worktrees.
    // `--full-auto` is still too restrictive for git worktrees because git
    // metadata lives under the source repo's .git/worktrees/... path, and some
    // local proxy setups also require localhost access from inside the worker.
    if (opts.resumeSessionId) {
      return ['exec', 'resume', opts.resumeSessionId, '-', '--json', '--sandbox', 'danger-full-access'];
    }
    return ['exec', '-', '--json', '--sandbox', 'danger-full-access'];
  }

  private extractSessionId(handle: WorkerHandle): string | null {
    if (!handle.outputFile) return null;
    if (handle.tool === 'claude') return parseClaudeSessionId(handle.outputFile);
    return parseCodexSessionId(handle.outputFile);
  }

  private log(msg: string): void {
    process.stderr.write(`[supervisor] ${msg}\n`);
  }

  private normalizeAcpHandle(
    handle: Omit<WorkerHandle, 'transport' | 'child'> & { child?: ChildProcess | null; transport?: 'acp' | 'proc' },
  ): WorkerHandle {
    return {
      ...handle,
      transport: 'acp',
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
