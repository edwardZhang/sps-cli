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
import { openSync, closeSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { isProcessAlive, killProcessGroup, parseClaudeSessionId, parseCodexSessionId } from '../providers/outputParser.js';
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
  /** Called immediately when child process exits */
  onExit: (exitCode: number) => void;
}

export interface WorkerHandle {
  id: string;
  pid: number;
  child: ChildProcess;
  outputFile: string;
  project: string;
  seq: string;
  slot: string;
  branch: string;
  worktree: string;
  tool: 'claude' | 'codex';
  exitCode: number | null;
  sessionId: string | null;
  startedAt: string;
  exitedAt: string | null;
}

// ─── Supervisor ─────────────────────────────────────────────────

export class ProcessSupervisor {
  /** Global env: process.env + ~/.jarvis.env (Layer 1+2) */
  private globalEnv: Record<string, string>;
  /** Active worker handles by ID */
  private readonly workers = new Map<string, WorkerHandle>();
  /** Orphan PID poll timers (for Recovery) */
  private readonly orphanTimers = new Map<string, ReturnType<typeof setInterval>>();

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

    const child = spawn(opts.tool === 'claude' ? 'claude' : 'codex', args, {
      cwd: opts.worktree,
      stdio: ['pipe', fd, fd],
      detached: true,
      env,
    });

    // Write prompt to stdin and close
    child.stdin!.write(opts.prompt);
    child.stdin!.end();

    // Close fd on Node side — child inherits it, OS guarantees write
    closeSync(fd);

    // DO NOT call child.unref() — tick process holds the handle
    // This ensures exit callback fires reliably

    const handle: WorkerHandle = {
      id: opts.id,
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
      startedAt: new Date().toISOString(),
      exitedAt: null,
    };

    this.workers.set(opts.id, handle);

    child.on('exit', (code) => {
      handle.exitCode = code ?? 1;
      handle.exitedAt = new Date().toISOString();

      // Extract session ID for potential --resume retry
      if (!handle.sessionId) {
        handle.sessionId = this.extractSessionId(handle);
      }

      // Trigger CompletionJudge → PostActions
      opts.onExit(handle.exitCode);
    });

    this.log(`Spawned ${opts.tool} for ${opts.id} (pid=${child.pid}), output=${opts.outputFile}`);
    return handle;
  }

  // ─── Kill / Query ───────────────────────────────────────────

  async kill(id: string): Promise<void> {
    const handle = this.workers.get(id);
    if (!handle) return;
    if (handle.pid > 0 && isProcessAlive(handle.pid)) {
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

  // ─── Orphan PID Monitoring (Recovery mode) ──────────────────

  /**
   * Monitor a PID that we don't have a child handle for (tick restarted).
   * Polls every 5s; when PID dies, calls onDead.
   */
  monitorOrphanPid(
    id: string,
    pid: number,
    handle: Omit<WorkerHandle, 'child'>,
    onDead: (exitCode: number) => void,
  ): void {
    // Store handle without child reference
    const orphanHandle = { ...handle, child: null as unknown as ChildProcess };
    this.workers.set(id, orphanHandle);

    const timer = setInterval(() => {
      if (!isProcessAlive(pid)) {
        clearInterval(timer);
        this.orphanTimers.delete(id);
        orphanHandle.exitCode = 1; // Unknown exit code for orphan
        orphanHandle.exitedAt = new Date().toISOString();

        // Try to extract session ID
        if (!orphanHandle.sessionId) {
          orphanHandle.sessionId = this.extractSessionId(orphanHandle);
        }

        this.log(`Orphan PID ${pid} (${id}) is dead, triggering completion check`);
        onDead(1);
      }
    }, 5_000);

    this.orphanTimers.set(id, timer);
    this.log(`Monitoring orphan PID ${pid} for ${id} (5s poll)`);
  }

  // ─── Environment Loading ────────────────────────────────────

  private loadGlobalEnv(): Record<string, string> {
    const env = { ...process.env } as Record<string, string>;
    const envPath = resolve(homedir(), '.jarvis.env');
    if (existsSync(envPath)) {
      const parsed = this.parseShellFile(envPath);
      Object.assign(env, parsed);
    }
    return env;
  }

  private loadProjectEnv(project: string): RawConfig {
    const confPath = resolve(homedir(), '.projects', project, 'conf');
    if (!existsSync(confPath)) return {};

    // Source both files in one bash context so conf can reference jarvis.env vars
    const envPath = resolve(homedir(), '.jarvis.env');
    try {
      const { execSync } = require('node:child_process');
      const sources: string[] = [];
      if (existsSync(envPath)) sources.push(`source "${envPath}" 2>/dev/null`);
      sources.push(`source "${confPath}" 2>/dev/null`);
      const output = execSync(
        `bash -c 'set -a; ${sources.join('; ')}; env'`,
        { encoding: 'utf-8', timeout: 5000 },
      ) as string;
      const result: RawConfig = {};
      for (const line of output.split('\n')) {
        const idx = line.indexOf('=');
        if (idx > 0) result[line.slice(0, idx)] = line.slice(idx + 1);
      }
      return result;
    } catch {
      return this.parseShellFile(confPath);
    }
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
    // codex
    const args = ['exec', '--json'];
    if (opts.resumeSessionId) args.push('--resume', opts.resumeSessionId);
    return args;
  }

  private extractSessionId(handle: WorkerHandle): string | null {
    if (!handle.outputFile) return null;
    if (handle.tool === 'claude') return parseClaudeSessionId(handle.outputFile);
    return parseCodexSessionId(handle.outputFile);
  }

  private parseShellFile(filePath: string): RawConfig {
    const result: RawConfig = {};
    try {
      const content = readFileSync(filePath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=["']?(.*?)["']?\s*$/);
        if (match) result[match[1]] = match[2];
      }
    } catch { /* ignore */ }
    return result;
  }

  private log(msg: string): void {
    process.stderr.write(`[supervisor] ${msg}\n`);
  }
}
