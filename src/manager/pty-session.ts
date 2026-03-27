/**
 * PTYSession — wraps a single persistent Worker process (Claude/Codex) in a
 * pseudoterminal. Provides real-time streaming output, direct stdin injection,
 * and event-driven state detection.
 *
 * Replaces tmux send-keys/capture-pane with direct PTY read/write.
 */
import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';

// ─── Types ──────────────────────────────────────────────────────

export type SessionState = 'booting' | 'ready' | 'busy' | 'waiting_input' | 'offline';

export interface WaitingInputEvent {
  type: 'trust' | 'permission' | 'confirmation' | 'unknown';
  prompt: string;
  options?: string[];
  dangerous?: boolean;
  timestamp: string;
}

export interface PTYSessionEvents {
  'state-change': (state: SessionState, prev: SessionState) => void;
  'waiting-input': (event: WaitingInputEvent) => void;
  'run-completed': (runId: string) => void;
  'run-failed': (runId: string, error: string) => void;
  'output': (chunk: string) => void;
  'exit': (code: number) => void;
}

/**
 * OutputParser — tool-specific stream parser. Fed every chunk from PTY stdout.
 * Responsible for detecting state transitions by analyzing the output stream.
 */
export interface OutputParser {
  feed(chunk: string, session: PTYSession): void;
  reset(): void;
}

// ─── Constants ──────────────────────────────────────────────────

const MAX_BUFFER_LINES = 500;
const STRIP_ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b\[[\?]?[0-9;]*[hlm]/g;

function stripAnsi(text: string): string {
  return text.replace(STRIP_ANSI_RE, '');
}

// ─── PTYSession ─────────────────────────────────────────────────

export class PTYSession extends EventEmitter {
  private terminal: pty.IPty;
  private state: SessionState = 'booting';
  private buffer: string = '';
  private outputStream: WriteStream | null = null;
  private currentRunId: string | null = null;
  private _alive = true;

  readonly pid: number;
  readonly sessionId: string;
  readonly tool: 'claude' | 'codex';
  readonly cwd: string;

  constructor(
    tool: 'claude' | 'codex',
    cwd: string,
    outputPath: string | null,
    private readonly parser: OutputParser,
  ) {
    super();
    this.tool = tool;
    this.cwd = cwd;

    const cmd = tool === 'claude' ? 'claude' : 'codex';
    const args = tool === 'claude'
      ? ['--dangerously-skip-permissions']
      : ['--full-auto'];

    this.terminal = pty.spawn(cmd, args, {
      name: 'xterm-256color',
      cols: 200,
      rows: 50,
      cwd,
      env: { ...process.env },
    });

    this.pid = this.terminal.pid;
    this.sessionId = `pty-${tool}-${this.pid}-${Date.now()}`;

    if (outputPath) {
      this.outputStream = createWriteStream(outputPath, { flags: 'a' });
    }

    // ── Real-time stream processing ──
    this.terminal.onData((chunk: string) => {
      this.buffer += chunk;
      this.trimBuffer();
      if (this.outputStream) this.outputStream.write(chunk);
      this.emit('output', chunk);

      // Feed clean text to parser
      const clean = stripAnsi(chunk);
      this.parser.feed(clean, this);
    });

    this.terminal.onExit(({ exitCode }: { exitCode: number }) => {
      this._alive = false;
      this.setState('offline');
      if (this.outputStream) this.outputStream.end();
      this.emit('exit', exitCode);
    });
  }

  // ─── Write ────────────────────────────────────────────────────

  /** Write raw bytes to PTY stdin */
  write(data: string): void {
    if (!this._alive) return;
    this.terminal.write(data);
  }

  /** Send a prompt followed by Enter */
  sendPrompt(prompt: string): void {
    this.write(prompt + '\r');
  }

  /** Send Enter key (confirm) */
  confirm(): void {
    this.write('\r');
  }

  /** Send Escape key (cancel/reject) */
  reject(): void {
    this.write('\x1b');
  }

  /** Send Ctrl+C */
  interrupt(): void {
    this.write('\x03');
  }

  // ─── State ────────────────────────────────────────────────────

  getState(): SessionState {
    return this.state;
  }

  setState(state: SessionState): void {
    const prev = this.state;
    if (prev === state) return;
    this.state = state;
    this.emit('state-change', state, prev);
  }

  getRunId(): string | null {
    return this.currentRunId;
  }

  setRunId(runId: string | null): void {
    this.currentRunId = runId;
  }

  isAlive(): boolean {
    return this._alive;
  }

  // ─── Buffer ───────────────────────────────────────────────────

  /** Get recent buffer content (optionally limited to last N lines) */
  getBuffer(lines?: number): string {
    const clean = stripAnsi(this.buffer);
    if (!lines) return clean;
    const all = clean.split('\n');
    return all.slice(-lines).join('\n');
  }

  /** Get raw buffer including ANSI sequences */
  getRawBuffer(): string {
    return this.buffer;
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  resize(cols: number, rows: number): void {
    if (this._alive) this.terminal.resize(cols, rows);
  }

  kill(): void {
    this._alive = false;
    try { this.terminal.kill(); } catch { /* already dead */ }
    if (this.outputStream) this.outputStream.end();
  }

  // ─── Internal ─────────────────────────────────────────────────

  private trimBuffer(): void {
    const lines = this.buffer.split('\n');
    if (lines.length > MAX_BUFFER_LINES) {
      this.buffer = lines.slice(-MAX_BUFFER_LINES).join('\n');
    }
  }
}
