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
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import type { McpServerConfig } from '../interfaces/ACPClient.js';
import type { ACPSessionRecord, ACPState, ACPTool } from '../models/acp.js';
import type { DaemonEvent, DaemonRequest, DaemonResponse } from './sessionDaemon.js';

export interface EnsureSessionOpts {
  mcpServers?: McpServerConfig[];
  extraEnv?: Record<string, string>;
}

export interface StartRunOpts {
  extraEnv?: Record<string, string>;
}

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

  async ensureSession(
    slot: string,
    tool?: ACPTool,
    cwd?: string,
    opts?: EnsureSessionOpts,
  ): Promise<ACPSessionRecord> {
    return this.request('ensureSession', { slot, tool, cwd, opts });
  }

  async startRun(
    slot: string,
    prompt: string,
    tool?: ACPTool,
    cwd?: string,
    opts?: StartRunOpts,
  ): Promise<ACPSessionRecord> {
    return this.request('startRun', { slot, prompt, tool, cwd, opts });
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

  /**
   * Long-lived subscription: opens socket, sends subscribeRun, yields DaemonEvent
   * frames as async iterator. Terminates when daemon closes socket (run complete)
   * or when caller breaks out of loop (cancels via iterator.return).
   *
   * Usage:
   *   for await (const evt of client.subscribeRun(slot)) {
   *     if (evt.event === 'text') ...
   *     if (evt.event === 'complete') break;
   *   }
   */
  subscribeRun(slot: string): AsyncIterable<DaemonEvent> & { cancel: () => void } {
    const socket = createConnection(this.socketPath);
    const queue: DaemonEvent[] = [];
    const waiters: Array<(v: IteratorResult<DaemonEvent>) => void> = [];
    let done = false;
    let errored: Error | null = null;
    let buffer = '';

    const close = (): void => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* noop */ }
      // drain waiters
      while (waiters.length > 0) {
        waiters.shift()!({ value: undefined as unknown as DaemonEvent, done: true });
      }
    };

    socket.on('connect', () => {
      const req: DaemonRequest = { method: 'subscribeRun', params: { slot } };
      socket.write(JSON.stringify(req) + '\n');
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf-8');
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          // Skip the initial ack frame (which is a DaemonResponse, has `ok`, no `event` key)
          if ('ok' in parsed && !('event' in parsed)) {
            if (!parsed.ok) {
              errored = new Error(parsed.error ?? 'subscribe failed');
              close();
            }
            continue;
          }
          const evt = parsed as DaemonEvent;
          if (waiters.length > 0) {
            waiters.shift()!({ value: evt, done: false });
          } else {
            queue.push(evt);
          }
        } catch {
          /* malformed line */
        }
      }
    });

    socket.on('error', (err) => {
      errored = err;
      close();
    });
    socket.on('close', () => close());

    const iterator: AsyncIterator<DaemonEvent> = {
      next: () =>
        new Promise((resolve, reject) => {
          if (errored) return reject(errored);
          if (queue.length > 0) return resolve({ value: queue.shift()!, done: false });
          if (done) return resolve({ value: undefined as unknown as DaemonEvent, done: true });
          waiters.push(resolve);
        }),
      return: () => {
        close();
        return Promise.resolve({ value: undefined as unknown as DaemonEvent, done: true });
      },
    };

    return {
      [Symbol.asyncIterator]: () => iterator,
      cancel: close,
    };
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
      socket.setTimeout(30_000, () => finish(new Error('Daemon request timeout')));
    });
  }
}

/** Get the default daemon socket path. */
export function getDaemonSocketPath(): string {
  return DEFAULT_SOCKET;
}
