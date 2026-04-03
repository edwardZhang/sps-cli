/**
 * @module        acp-terminal-manager
 * @description   ACP 终端管理器，处理子进程创建、输出捕获与优雅终止
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-31
 * @updated       2026-04-03
 *
 * @role          adapter
 * @layer         provider
 * @boundedContext acp
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { PermissionMode } from './acp-permissions.js';

const DEFAULT_OUTPUT_LIMIT_BYTES = 1024 * 1024; // 1MB
const KILL_GRACE_MS = 5_000;

interface CreateTerminalRequest {
  sessionId: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
  cwd?: string;
  outputByteLimit?: number;
}

interface TerminalOutputRequest {
  sessionId: string;
  terminalId: string;
}

interface WaitForTerminalExitRequest {
  sessionId: string;
  terminalId: string;
}

interface KillTerminalRequest {
  sessionId: string;
  terminalId: string;
}

interface ReleaseTerminalRequest {
  sessionId: string;
  terminalId: string;
}

interface ExitStatus {
  exitCode: number | null;
  signal: string | null;
}

interface ManagedTerminal {
  process: ChildProcess;
  output: Buffer;
  truncated: boolean;
  outputByteLimit: number;
  exitCode: number | null | undefined;
  signal: string | null | undefined;
  exitPromise: Promise<ExitStatus>;
}

function envArrayToRecord(env?: Array<{ name: string; value: string }>): Record<string, string> {
  if (!env) return {};
  const record: Record<string, string> = {};
  for (const { name, value } of env) {
    record[name] = value;
  }
  return record;
}

export class TerminalManager {
  private readonly cwd: string;
  private readonly permissionMode: PermissionMode;
  private readonly terminals = new Map<string, ManagedTerminal>();

  constructor(opts: { cwd: string; permissionMode: PermissionMode }) {
    this.cwd = opts.cwd;
    this.permissionMode = opts.permissionMode;
  }

  async createTerminal(params: CreateTerminalRequest): Promise<{ terminalId: string }> {
    if (this.permissionMode === 'deny-all') {
      throw new Error('Permission denied for terminal/create (deny-all)');
    }

    const outputByteLimit = params.outputByteLimit ?? DEFAULT_OUTPUT_LIMIT_BYTES;
    const proc = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? this.cwd,
      env: { ...process.env, ...envArrayToRecord(params.env) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolveExit!: (r: ExitStatus) => void;
    const exitPromise = new Promise<ExitStatus>((r) => { resolveExit = r; });

    const terminal: ManagedTerminal = {
      process: proc,
      output: Buffer.alloc(0),
      truncated: false,
      outputByteLimit,
      exitCode: undefined,
      signal: undefined,
      exitPromise,
    };

    const appendOutput = (chunk: Buffer) => {
      terminal.output = Buffer.concat([terminal.output, chunk]);
      if (terminal.output.length > terminal.outputByteLimit) {
        terminal.output = terminal.output.subarray(-terminal.outputByteLimit);
        terminal.truncated = true;
      }
    };

    proc.stdout!.on('data', appendOutput);
    proc.stderr!.on('data', appendOutput);

    proc.once('exit', (code, signal) => {
      terminal.exitCode = code;
      terminal.signal = signal;
      resolveExit({ exitCode: code ?? null, signal: signal ?? null });
    });

    const terminalId = randomUUID();
    this.terminals.set(terminalId, terminal);
    return { terminalId };
  }

  async terminalOutput(params: TerminalOutputRequest): Promise<{
    output: string;
    truncated: boolean;
    exitStatus?: ExitStatus;
  }> {
    const terminal = this.getTerminal(params.terminalId);
    const hasExit = terminal.exitCode !== undefined || terminal.signal !== undefined;
    return {
      output: terminal.output.toString('utf-8'),
      truncated: terminal.truncated,
      exitStatus: hasExit
        ? { exitCode: terminal.exitCode ?? null, signal: terminal.signal ?? null }
        : undefined,
    };
  }

  async waitForTerminalExit(params: WaitForTerminalExitRequest): Promise<ExitStatus> {
    return this.getTerminal(params.terminalId).exitPromise;
  }

  async killTerminal(params: KillTerminalRequest): Promise<Record<string, never>> {
    await this.killProcess(this.getTerminal(params.terminalId));
    return {};
  }

  async releaseTerminal(params: ReleaseTerminalRequest): Promise<Record<string, never>> {
    const terminal = this.terminals.get(params.terminalId);
    if (!terminal) return {};
    await this.killProcess(terminal);
    this.terminals.delete(params.terminalId);
    return {};
  }

  private async killProcess(terminal: ManagedTerminal): Promise<void> {
    if (terminal.exitCode !== undefined) return;
    try { terminal.process.kill('SIGTERM'); } catch { /* already dead */ }
    const exited = await Promise.race([
      terminal.exitPromise.then(() => true),
      new Promise<false>((r) => setTimeout(() => r(false), KILL_GRACE_MS)),
    ]);
    if (!exited) {
      try { terminal.process.kill('SIGKILL'); } catch { /* noop */ }
    }
  }

  private getTerminal(id: string): ManagedTerminal {
    const terminal = this.terminals.get(id);
    if (!terminal) throw new Error(`Unknown terminal: ${id}`);
    return terminal;
  }
}
