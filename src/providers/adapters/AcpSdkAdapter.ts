/**
 * @module        AcpSdkAdapter
 * @description   ACP SDK 适配器，通过 JSON-RPC over stdio 实现 Agent 客户端协议通信
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
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import type * as schema from '@agentclientprotocol/sdk';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type {
  ACPClient,
  EnsureSessionInput,
  EnsureSessionResult,
  InspectRunInput,
  InspectRunResult,
  InspectSessionInput,
  InspectSessionResult,
  StartRunInput,
  StartRunResult,
  StopSessionInput,
} from '../../interfaces/ACPClient.js';
import type { ACPRunStatus, ACPTool } from '../../models/acp.js';
import { FileSystemHandlers } from './acp-fs-handlers.js';
import { type PermissionMode, resolvePermission } from './acp-permissions.js';
import { SessionUpdateAccumulator } from './acp-session-accumulator.js';
import { TerminalManager } from './acp-terminal-manager.js';

export interface AgentRegistryEntry { command: string; args: string[] }

const BUILTIN_AGENTS: Record<string, AgentRegistryEntry> = {
  claude: { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
  codex: { command: 'npx', args: ['-y', '@zed-industries/codex-acp'] },
  gemini: { command: 'gemini', args: ['--acp'] },
};

/** Load custom agents from ~/.coral/agents.json, merge with builtins. */
export function loadAgentRegistry(): Record<string, AgentRegistryEntry> {
  const registry = { ...BUILTIN_AGENTS };
  try {
    const home = process.env.HOME || '/home/coral';
    const custom = JSON.parse(readFileSync(resolve(home, '.coral', 'agents.json'), 'utf-8'));
    if (custom && typeof custom === 'object') {
      for (const [name, entry] of Object.entries(custom)) {
        const e = entry as { command?: string; args?: string[] };
        if (e.command) {
          registry[name] = { command: e.command, args: e.args ?? [] };
        }
      }
    }
  } catch { /* no custom agents file */ }
  return registry;
}

interface ActiveSession {
  tool: ACPTool;
  sessionId: string;
  sessionName: string;
  cwd: string;
  child: ChildProcess;
  conn: ClientSideConnection;
  accumulator: SessionUpdateAccumulator;
  activePromise: Promise<schema.PromptResponse> | null;
  permissionMode: PermissionMode;
}

function isChildAlive(child: ChildProcess): boolean {
  return child.exitCode == null && child.signalCode == null && !child.killed;
}

/** Cross-process PID liveness check (signal 0) */
function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class AcpSdkAdapter implements ACPClient {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly defaultPermissionMode: PermissionMode;

  constructor(permissionMode?: PermissionMode) {
    this.defaultPermissionMode =
      permissionMode ?? (process.env.ACP_PERMISSION_MODE as PermissionMode) ?? 'approve-all';
  }

  async ensureSession(input: EnsureSessionInput): Promise<EnsureSessionResult> {
    const existing = this.sessions.get(input.sessionName);

    if (existing && !input.resetExisting && isChildAlive(existing.child)) {
      return {
        sessionId: existing.sessionId,
        sessionState: existing.activePromise ? 'busy' : 'ready',
        paneText: existing.accumulator.getRecentText(),
        lastSeenAt: new Date().toISOString(),
        pid: existing.child.pid ?? null,
      };
    }

    if (existing) {
      await this.destroySession(existing);
      this.sessions.delete(input.sessionName);
    }

    // Resolve adapter command
    const allAgents = loadAgentRegistry();
    const registry = allAgents[input.tool];
    if (!registry) throw new Error(`Unknown ACP tool: ${input.tool}`);

    // Spawn ACP adapter child process
    const child = spawn(registry.command, registry.args, {
      cwd: input.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Capture stderr to log file for crash diagnosis
    const stderrLogFile = input.logsDir
      ? resolve(input.logsDir, `acp-stderr-${input.tool}-${Date.now()}.log`)
      : null;
    let stderrFd: number | null = null;
    if (stderrLogFile) {
      try {
        const { openSync, writeSync, closeSync } = await import('node:fs');
        stderrFd = openSync(stderrLogFile, 'a');
        child.stderr?.on('data', (chunk: Buffer) => {
          try { writeSync(stderrFd!, chunk); } catch { /* non-fatal */ }
        });
        child.once('exit', (code, signal) => {
          const exitInfo = `\n[acp-stderr] Process exited: code=${code}, signal=${signal}, pid=${child.pid}\n`;
          try { writeSync(stderrFd!, Buffer.from(exitInfo)); } catch { /* non-fatal */ }
          if (stderrFd != null) try { closeSync(stderrFd); } catch { /* noop */ }
        });
      } catch {
        // Fallback: discard stderr if log file can't be opened
        child.stderr?.on('data', () => { /* discard */ });
      }
    } else {
      child.stderr?.on('data', () => { /* discard */ });
    }

    // Spawn with 60s timeout to prevent indefinite hang if adapter binary is stuck
    const spawnTimeout = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
    }, 60_000);
    spawnTimeout.unref();

    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', (err) => reject(new Error(`Failed to spawn ${input.tool} ACP adapter: ${err.message}`)));
      });
    } catch (err) {
      clearTimeout(spawnTimeout);
      throw err;
    }
    // Spawn succeeded — clear the timeout so it doesn't kill the daemon later
    clearTimeout(spawnTimeout);

    // Establish JSON-RPC connection over stdio
    const stream = ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );

    const accumulator = new SessionUpdateAccumulator();
    const permissionMode = this.defaultPermissionMode;
    // Set up log file for sps logs compatibility
    if (input.logsDir) {
      const logFileName = `${input.sessionName}-acp-${Date.now()}.log`;
      accumulator.setLogFile(`${input.logsDir}/${logFileName}`);
    }

    const fsHandlers = new FileSystemHandlers({ cwd: input.cwd, permissionMode });
    const terminalMgr = new TerminalManager({ cwd: input.cwd, permissionMode });

    const conn = new ClientSideConnection(
      () => ({
        sessionUpdate: async (params: schema.SessionNotification) => {
          accumulator.handleUpdate(params.update as any);
        },
        requestPermission: async (params: schema.RequestPermissionRequest) => {
          accumulator.hasPendingPermission = true;
          const result = resolvePermission(params as any, permissionMode);
          accumulator.hasPendingPermission = false;
          return result as schema.RequestPermissionResponse;
        },
        readTextFile: async (params: schema.ReadTextFileRequest) => {
          return fsHandlers.readTextFile(params as any) as Promise<schema.ReadTextFileResponse>;
        },
        writeTextFile: async (params: schema.WriteTextFileRequest) => {
          return fsHandlers.writeTextFile(params as any) as Promise<schema.WriteTextFileResponse>;
        },
        createTerminal: async (params: schema.CreateTerminalRequest) => {
          return terminalMgr.createTerminal(params as any) as Promise<schema.CreateTerminalResponse>;
        },
        terminalOutput: async (params: schema.TerminalOutputRequest) => {
          return terminalMgr.terminalOutput(params as any) as Promise<schema.TerminalOutputResponse>;
        },
        waitForTerminalExit: async (params: schema.WaitForTerminalExitRequest) => {
          return terminalMgr.waitForTerminalExit(params as any) as Promise<schema.WaitForTerminalExitResponse>;
        },
        killTerminal: async (params: schema.KillTerminalRequest) => {
          return terminalMgr.killTerminal(params as any) as Promise<schema.KillTerminalResponse>;
        },
        releaseTerminal: async (params: schema.ReleaseTerminalRequest) => {
          return terminalMgr.releaseTerminal(params as any) as Promise<schema.ReleaseTerminalResponse>;
        },
      }),
      stream,
    );

    // Protocol initialization
    const initResult = await conn.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    });

    // Create new session
    const sessionResult = await conn.newSession({
      cwd: input.cwd,
      mcpServers: (input.mcpServers ?? []).map(s => ({
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        env: s.env ?? [],
      })),
    });

    const session: ActiveSession = {
      tool: input.tool,
      sessionId: sessionResult.sessionId,
      sessionName: input.sessionName,
      cwd: input.cwd,
      child,
      conn,
      accumulator,
      activePromise: null,
      permissionMode,
    };
    this.sessions.set(input.sessionName, session);

    return {
      sessionId: sessionResult.sessionId,
      sessionState: 'ready',
      paneText: '',
      lastSeenAt: new Date().toISOString(),
      pid: child.pid ?? null,
    };
  }

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    const session = this.sessions.get(input.sessionName);
    if (!session) throw new Error(`ACP session not found: ${input.sessionName}`);
    if (session.activePromise) throw new Error(`Session ${input.sessionName} already has active run`);

    session.accumulator.reset();

    // Non-blocking prompt — store promise but don't await
    session.activePromise = session.conn.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: 'text', text: input.prompt }],
    });

    session.activePromise
      .then((result) => {
        session.accumulator.stopReason = result.stopReason ?? 'end_turn';
        session.activePromise = null;
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[acp] Prompt failed for ${input.sessionName}: ${msg}\n`);
        session.accumulator.stopReason = 'failed';
        session.activePromise = null;
      });

    return {
      runId: `acp-${Date.now()}`,
      runState: 'running',
      paneText: '',
      lastSeenAt: new Date().toISOString(),
      pid: session.child.pid ?? null,
    };
  }

  async inspectSession(input: InspectSessionInput): Promise<InspectSessionResult> {
    const session = this.sessions.get(input.sessionName);

    // In-process session: direct check
    if (session && isChildAlive(session.child)) {
      return {
        sessionState: session.activePromise ? 'busy' : 'ready',
        paneText: session.accumulator.getRecentText(),
        lastSeenAt: new Date().toISOString(),
      };
    }

    // Cross-process fallback: check persisted PID liveness
    if (input.pid && isPidAlive(input.pid)) {
      return {
        sessionState: 'busy',  // PID alive but not our process — assume busy
        paneText: '',
        lastSeenAt: new Date().toISOString(),
      };
    }

    return { sessionState: 'offline', paneText: '', lastSeenAt: new Date().toISOString() };
  }

  async inspectRun(input: InspectRunInput): Promise<InspectRunResult> {
    if (!input.activeRun) {
      return { runState: null, paneText: '', lastSeenAt: new Date().toISOString() };
    }
    const session = this.sessions.get(input.sessionName);

    // In-process session: detailed status from accumulator
    if (session && isChildAlive(session.child)) {
      // (handled below)
    } else if (input.pid && isPidAlive(input.pid)) {
      // Cross-process fallback: PID alive = running
      return { runState: 'running', paneText: '', lastSeenAt: new Date().toISOString() };
    } else {
      return { runState: 'lost', paneText: '', lastSeenAt: new Date().toISOString() };
    }

    const acc = session.accumulator;
    let runState: ACPRunStatus;

    if (!session.activePromise) {
      // Prompt has returned
      runState = acc.stopReason === 'end_turn' ? 'completed'
        : acc.stopReason === 'cancelled' ? 'cancelled'
        : 'failed';
    } else if (acc.hasPendingPermission) {
      runState = 'needs_confirmation';
    } else if (acc.lastUpdateAt && acc.getRecentText().length > 0) {
      // Idle detection: if agent has produced output but no updates for 60s,
      // treat as completed. Some ACP adapters (e.g. codex-acp) may not
      // resolve the prompt() call even after the agent finishes.
      const idleMs = Date.now() - new Date(acc.lastUpdateAt).getTime();
      if (idleMs > 60_000) {
        acc.stopReason = 'end_turn';
        session.activePromise = null;
        runState = 'completed';
      } else {
        runState = 'running';
      }
    } else {
      runState = 'running';
    }

    return {
      runState,
      paneText: acc.getRecentText(),
      lastSeenAt: new Date().toISOString(),
    };
  }

  async stopSession(input: StopSessionInput): Promise<void> {
    const session = this.sessions.get(input.sessionName);
    if (!session) return;

    if (session.activePromise) {
      try {
        await session.conn.cancel({ sessionId: session.sessionId });
      } catch { /* Agent may already be dead */ }
    }

    await this.destroySession(session);
    this.sessions.delete(input.sessionName);
  }

  private async destroySession(session: ActiveSession): Promise<void> {
    const pid = session.child.pid;
    // Kill child + try to kill descendant processes
    try { session.child.kill('SIGTERM'); } catch { /* noop */ }
    if (pid) {
      // Kill descendants spawned by npx (sh → node child tree)
      try { process.kill(pid, 'SIGTERM'); } catch { /* noop */ }
      this.killDescendants(pid, 'SIGTERM');
    }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try { session.child.kill('SIGKILL'); } catch { /* noop */ }
        if (pid) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* noop */ }
          this.killDescendants(pid, 'SIGKILL');
        }
        resolve();
      }, 3_000);
      session.child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /** Kill all child processes of a given PID (Linux: pgrep -P). */
  private killDescendants(parentPid: number, signal: NodeJS.Signals): void {
    try {
      const out = execFileSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf-8', timeout: 2000 });
      for (const line of out.trim().split('\n')) {
        const childPid = parseInt(line, 10);
        if (childPid > 0) {
          try { process.kill(childPid, signal); } catch { /* noop */ }
          this.killDescendants(childPid, signal); // recursive
        }
      }
    } catch { /* pgrep not found or no children */ }
  }
}
