/**
 * @module        daemonClient
 * @description   守护进程客户端，通过 Unix 域套接字与 SessionDaemon 通信
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-31
 * @updated       2026-04-03
 *
 * @role          daemon
 * @layer         daemon
 * @boundedContext session-management
 */

import { existsSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { resolve } from 'node:path';
import type { ACPSessionRecord, ACPState, ACPTool } from '../models/acp.js';
import type { DaemonRequest, DaemonResponse } from './sessionDaemon.js';

const DEFAULT_SOCKET = process.env.SPS_DAEMON_SOCKET || resolve(process.env.HOME || '/home/coral', '.coral', 'sessions', 'daemon.sock');

export class DaemonClient {
  constructor(private socketPath = DEFAULT_SOCKET) {}

  /** Check if daemon is reachable. */
  async isRunning(): Promise<boolean> {
    if (!existsSync(this.socketPath)) return false;
    try {
      await this.request('inspect', {});
      return true;
    } catch {
      return false;
    }
  }

  async ensureSession(slot: string, tool?: ACPTool, cwd?: string): Promise<ACPSessionRecord> {
    return this.request('ensureSession', { slot, tool, cwd });
  }

  async startRun(slot: string, prompt: string, tool?: ACPTool, cwd?: string): Promise<ACPSessionRecord> {
    return this.request('startRun', { slot, prompt, tool, cwd });
  }

  async inspect(slot?: string): Promise<ACPState> {
    return this.request('inspect', { slot });
  }

  async stopSession(slot: string): Promise<void> {
    await this.request('stopSession', { slot });
  }

  async clearRun(slot: string): Promise<void> {
    await this.request('clearRun', { slot });
  }

  async shutdown(): Promise<void> {
    try { await this.request('shutdown', {}); } catch { /* daemon exits */ }
  }

  /** Send a single NDJSON request, wait for response. */
  private request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      let buffer = '';
      let settled = false;

      const finish = (err?: Error, data?: T) => {
        if (settled) return;
        settled = true;
        if (connectTimeout) clearTimeout(connectTimeout);
        socket.destroy();
        if (err) reject(err);
        else resolve(data as T);
      };

      // 5s connection timeout (separate from 30s request timeout)
      const connectTimeout = setTimeout(() => {
        finish(new Error('Daemon connection timeout (5s)'));
      }, 5_000);

      socket.on('connect', () => {
        clearTimeout(connectTimeout);
        const req: DaemonRequest = { method: method as DaemonRequest['method'], params };
        socket.write(JSON.stringify(req) + '\n');
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf-8');
        const idx = buffer.indexOf('\n');
        if (idx < 0) return;

        const line = buffer.slice(0, idx);
        try {
          const res: DaemonResponse = JSON.parse(line);
          if (res.ok) finish(undefined, res.data as T);
          else finish(new Error(res.error ?? 'Daemon error'));
        } catch {
          finish(new Error('Invalid daemon response'));
        }
      });

      socket.on('error', (err) => finish(err));
      // 90s timeout: ACP adapter first-run may need to download + initialize
      socket.setTimeout(90_000, () => finish(new Error('Daemon request timeout')));
    });
  }
}

/** Get the default daemon socket path. */
export function getDaemonSocketPath(): string {
  return DEFAULT_SOCKET;
}
