/**
 * Session Daemon — background process managing persistent ACP sessions.
 *
 * Spawned by `sps agent daemon start`. Listens on Unix domain socket.
 * Holds AcpSdkAdapter instances (ACP adapter child processes) that persist
 * across terminal sessions. CLI clients communicate via NDJSON RPC.
 *
 * Socket: ~/.coral/sessions/daemon.sock
 * PID:    ~/.coral/sessions/daemon.pid
 * State:  ~/.coral/sessions/state.json (shared with clients)
 */
import { createServer, type Socket, type Server } from 'node:net';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createSessionContext, type SessionContext } from '../core/sessionContext.js';
import { createSessionRuntime } from '../providers/registry.js';
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';
import type { ACPTool } from '../models/acp.js';

export interface DaemonRequest {
  id?: number;
  method: 'ensureSession' | 'startRun' | 'inspect' | 'stopSession' | 'clearRun' | 'shutdown';
  params: Record<string, unknown>;
}

export interface DaemonResponse {
  id?: number;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface DaemonEvent {
  event: 'output' | 'tool_call' | 'done' | 'status';
  [key: string]: unknown;
}

const DEFAULT_SOCKET = resolve(process.env.HOME || '/home/coral', '.coral', 'sessions', 'daemon.sock');
const DEFAULT_PID = resolve(process.env.HOME || '/home/coral', '.coral', 'sessions', 'daemon.pid');

export class SessionDaemon {
  private server: Server | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private runtime: AgentRuntime;
  private ctx: SessionContext;
  private clients = new Set<Socket>();

  constructor(
    private socketPath = DEFAULT_SOCKET,
    private pidFile = DEFAULT_PID,
  ) {
    this.ctx = createSessionContext();
    this.runtime = createSessionRuntime(this.ctx);
  }

  async start(): Promise<void> {
    mkdirSync(dirname(this.socketPath), { recursive: true });

    // Clean stale socket
    if (existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* noop */ }
    }

    // Write PID file
    writeFileSync(this.pidFile, String(process.pid));

    // Start Unix socket server
    this.server = createServer((socket) => this.handleClient(socket));
    this.server.listen(this.socketPath, () => {
      this.log(`Daemon listening on ${this.socketPath} (pid ${process.pid})`);
    });

    // Poll sessions every 2s to keep state.json fresh
    this.pollTimer = setInterval(() => this.pollSessions(), 2_000);

    // Graceful shutdown
    process.on('SIGINT', () => this.shutdown());
    process.on('SIGTERM', () => this.shutdown());
  }

  private handleClient(socket: Socket): void {
    this.clients.add(socket);
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        this.handleMessage(socket, line).catch((err) => {
          this.log(`Client error: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    });

    socket.on('close', () => { this.clients.delete(socket); });
    socket.on('error', () => { this.clients.delete(socket); });
  }

  private async handleMessage(socket: Socket, raw: string): Promise<void> {
    let req: DaemonRequest;
    try {
      req = JSON.parse(raw);
    } catch {
      this.send(socket, { ok: false, error: 'Invalid JSON' });
      return;
    }

    try {
      const res = await this.dispatch(req);
      this.send(socket, { id: req.id, ...res });
    } catch (err) {
      this.send(socket, {
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async dispatch(req: DaemonRequest): Promise<DaemonResponse> {
    const p = req.params;

    switch (req.method) {
      case 'ensureSession': {
        const session = await this.runtime.ensureSession(
          p.slot as string,
          p.tool as ACPTool | undefined,
          p.cwd as string | undefined,
        );
        return { ok: true, data: session };
      }

      case 'startRun': {
        const session = await this.runtime.startRun(
          p.slot as string,
          p.prompt as string,
          p.tool as ACPTool | undefined,
          p.cwd as string | undefined,
        );
        return { ok: true, data: session };
      }

      case 'inspect': {
        const state = await this.runtime.inspect(p.slot as string | undefined);
        return { ok: true, data: state };
      }

      case 'stopSession': {
        await this.runtime.stopSession(p.slot as string);
        return { ok: true };
      }

      case 'clearRun': {
        const { readState, writeState } = await import('../core/state.js');
        const state = readState(this.ctx.paths.stateFile, 0);
        const s = state.sessions?.[p.slot as string];
        if (s?.currentRun) {
          s.currentRun = null;
          s.status = 'idle';
          writeState(this.ctx.paths.stateFile, state, 'daemon-clear-run');
        }
        return { ok: true };
      }

      case 'shutdown': {
        this.shutdown();
        return { ok: true };
      }

      default:
        return { ok: false, error: `Unknown method: ${req.method}` };
    }
  }

  private async pollSessions(): Promise<void> {
    try {
      const state = await this.runtime.inspect();
      // TTL cleanup: stop sessions idle longer than SESSION_TTL_MS
      const ttlMs = parseInt(process.env.SPS_SESSION_TTL_HOURS || '4', 10) * 3_600_000;
      const now = Date.now();
      for (const [slot, session] of Object.entries(state.sessions)) {
        if (!session.currentRun && session.lastSeenAt) {
          const idleMs = now - Date.parse(session.lastSeenAt);
          if (idleMs > ttlMs) {
            this.log(`TTL expired for ${slot} (idle ${Math.round(idleMs / 60000)}min) — stopping`);
            try { await this.runtime.stopSession(slot); } catch { /* best effort */ }
          }
        }
      }
    } catch (err) {
      this.log(`Poll error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async shutdown(): Promise<void> {
    this.log('Shutting down...');

    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.server) this.server.close();

    // Stop all sessions
    try {
      const state = await this.runtime.inspect();
      for (const slot of Object.keys(state.sessions)) {
        try { await this.runtime.stopSession(slot); } catch { /* best effort */ }
      }
    } catch { /* noop */ }

    // Clean up files
    try { unlinkSync(this.socketPath); } catch { /* noop */ }
    try { unlinkSync(this.pidFile); } catch { /* noop */ }

    process.exit(0);
  }

  private send(socket: Socket, msg: DaemonResponse | DaemonEvent): void {
    try {
      if (!socket.destroyed) {
        socket.write(JSON.stringify(msg) + '\n');
      }
    } catch { /* client disconnected */ }
  }

  private log(msg: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    process.stderr.write(`[daemon ${ts}] ${msg}\n`);
  }
}

// Direct execution entry point
const isDirectRun = process.argv[1]?.endsWith('sessionDaemon.js');
if (isDirectRun) {
  const daemon = new SessionDaemon();
  daemon.start().catch((err) => {
    process.stderr.write(`Daemon failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
