/**
 * AcpSdkAdapter — Implements ACPClient using real ACP JSON-RPC over stdio.
 *
 * Replaces ClaudeACPAdapter + CodexACPAdapter (tmux screen-scraping) with
 * structured protocol communication via @agentclientprotocol/sdk.
 *
 * Architecture (aligned with OpenClaw/acpx):
 *   AcpSdkAdapter → spawn ACP adapter child process → stdio pipe → JSON-RPC
 *   Claude: npx @agentclientprotocol/claude-agent-acp (Anthropic official SDK)
 *   Codex:  npx @zed-industries/codex-acp (Rust native binary)
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type * as schema from '@agentclientprotocol/sdk';
import type {
  ACPClient,
  EnsureSessionInput,
  EnsureSessionResult,
  StartRunInput,
  StartRunResult,
  InspectSessionInput,
  InspectSessionResult,
  InspectRunInput,
  InspectRunResult,
  StopSessionInput,
} from '../../interfaces/ACPClient.js';
import type { ACPRunStatus, ACPTool } from '../../models/acp.js';
import { SessionUpdateAccumulator } from './acp-session-accumulator.js';
import { resolvePermission, type PermissionMode } from './acp-permissions.js';
import { FileSystemHandlers } from './acp-fs-handlers.js';
import { TerminalManager } from './acp-terminal-manager.js';

const ACP_ADAPTER_REGISTRY: Record<string, { command: string; args: string[] }> = {
  claude: { command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp'] },
  codex: { command: 'npx', args: ['-y', '@zed-industries/codex-acp'] },
};

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
    const registry = ACP_ADAPTER_REGISTRY[input.tool];
    if (!registry) throw new Error(`Unknown ACP tool: ${input.tool}`);

    // Spawn ACP adapter child process
    const child = spawn(registry.command, registry.args, {
      cwd: input.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Drain stderr (adapter debug output)
    child.stderr?.on('data', () => { /* discard */ });

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', () => resolve());
      child.once('error', (err) => reject(new Error(`Failed to spawn ${input.tool} ACP adapter: ${err.message}`)));
    });

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
      mcpServers: [],
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
      .catch(() => {
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
    try { session.child.kill('SIGTERM'); } catch { /* noop */ }
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        try { session.child.kill('SIGKILL'); } catch { /* noop */ }
        resolve();
      }, 3_000);
      session.child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}
