import type { ProjectConfig } from '../core/config.js';
import type { Notifier } from '../interfaces/Notifier.js';

/** Level prefixes for formatted messages. */
const LEVEL_PREFIX: Record<string, string> = {
  info: 'ℹ️',
  success: '✅',
  warning: '⚠️',
  error: '❌',
};

export class MatrixNotifier implements Notifier {
  private readonly homeserver: string;
  private readonly accessToken: string;
  private readonly roomId: string;
  private readonly enabled: boolean;

  constructor(config: ProjectConfig) {
    this.homeserver = (config.raw.MATRIX_HOMESERVER ?? '').replace(/\/+$/, '');
    this.accessToken = config.raw.MATRIX_ACCESS_TOKEN ?? '';
    this.roomId = config.raw.MATRIX_ROOM_ID ?? '';
    this.enabled = !!(this.homeserver && this.accessToken && this.roomId);

    if (!this.enabled) {
      process.stderr.write(
        'MatrixNotifier: Missing MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN, or MATRIX_ROOM_ID — notifications disabled\n',
      );
    }
  }

  /**
   * Send a message to the configured Matrix room.
   * Optionally prefix with a level indicator.
   */
  async send(message: string, level?: 'info' | 'success' | 'warning' | 'error'): Promise<void> {
    const prefix = level ? LEVEL_PREFIX[level] : undefined;
    const body = prefix ? `${prefix} ${message}` : message;
    await this.sendToMatrix(body);
  }

  async sendSuccess(message: string): Promise<void> {
    await this.send(message, 'success');
  }

  async sendWarning(message: string): Promise<void> {
    await this.send(message, 'warning');
  }

  async sendError(message: string): Promise<void> {
    await this.send(message, 'error');
  }

  /**
   * Format items as a bulleted list and send as a single message.
   */
  async sendDigest(items: { title: string; status: string }[]): Promise<void> {
    if (items.length === 0) return;

    const lines = items.map((item) => `• [${item.status}] ${item.title}`);
    const body = `Digest (${items.length} items):\n${lines.join('\n')}`;
    await this.sendToMatrix(body);
  }

  /**
   * Send a raw text message to the Matrix room via the Client-Server API.
   * Errors are logged to stderr but never thrown — notifications are non-critical.
   */
  private async sendToMatrix(body: string): Promise<void> {
    if (!this.enabled) return;

    const txnId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const url = `${this.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(this.roomId)}/send/m.room.message/${txnId}`;

    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          msgtype: 'm.text',
          body,
        }),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '(no body)');
        process.stderr.write(
          `MatrixNotifier: HTTP ${response.status} — ${text}\n`,
        );
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`MatrixNotifier: Failed to send — ${msg}\n`);
    }
  }
}
