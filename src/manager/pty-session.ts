/**
 * PTYSession — wraps a single persistent Worker process (Claude/Codex) in a
 * pseudoterminal. Provides real-time streaming output, direct stdin injection,
 * and event-driven state detection.
 *
 * Replaces tmux send-keys/capture-pane with direct PTY read/write.
 */
import * as pty from 'node-pty';
import { EventEmitter } from 'node:events';
import { chmodSync, createWriteStream, existsSync, statSync, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// ─── Types ──────────────────────────────────────────────────────

export type SessionState = 'booting' | 'ready' | 'busy' | 'waiting_input' | 'needs_confirmation' | 'offline';

export interface WaitingInputEvent {
  type: 'input' | 'trust' | 'permission' | 'confirmation' | 'unknown';
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

const require = createRequire(import.meta.url);
let spawnHelpersVerified = false;

function ensureSpawnHelpersExecutable(): void {
  if (spawnHelpersVerified || process.platform !== 'darwin') return;

  const packageJsonPath = require.resolve('node-pty/package.json');
  const prebuildsDir = join(dirname(packageJsonPath), 'prebuilds');
  const candidates = Array.from(new Set([
    join(prebuildsDir, `darwin-${process.arch}`, 'spawn-helper'),
    join(prebuildsDir, 'darwin-arm64', 'spawn-helper'),
    join(prebuildsDir, 'darwin-x64', 'spawn-helper'),
  ]));

  for (const helperPath of candidates) {
    if (!existsSync(helperPath)) continue;
    const mode = statSync(helperPath).mode & 0o777;
    if ((mode & 0o111) === 0o111) continue;
    chmodSync(helperPath, mode | 0o111);
    process.stderr.write(`[pty-session] Restored execute permission on ${helperPath}\n`);
  }

  spawnHelpersVerified = true;
}

function wrapSpawnError(tool: 'claude' | 'codex', error: unknown): Error {
  const base = error instanceof Error ? error : new Error(String(error));
  if (process.platform !== 'darwin' || !base.message.includes('posix_spawnp failed')) {
    return base;
  }
  return new Error(
    `Failed to launch ${tool} PTY session: ${base.message}. ` +
    'On macOS this usually means node-pty spawn-helper is missing executable permissions.',
    { cause: base },
  );
}

// ─── PTYSession ─────────────────────────────────────────────────

export class PTYSession extends EventEmitter {
  private terminal: pty.IPty;
  private state: SessionState = 'booting';
  private buffer: string = '';
  private outputStream: WriteStream | null = null;
  private currentRunId: string | null = null;
  private _alive = true;
  private lastOutputAt: number | null = null;
  private submitAttempts = 0;
  private lastSubmitAt: number | null = null;
  private stalledReason: string | null = null;
  private promptPreview: string | null = null;
  private promptText: string | null = null;

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

    ensureSpawnHelpersExecutable();

    try {
      this.terminal = pty.spawn(cmd, args, {
        name: 'xterm-256color',
        cols: 200,
        rows: 50,
        cwd,
        env: { ...process.env },
      });
    } catch (error) {
      throw wrapSpawnError(tool, error);
    }

    this.pid = this.terminal.pid;
    this.sessionId = `pty-${tool}-${this.pid}-${Date.now()}`;

    if (outputPath) {
      this.outputStream = createWriteStream(outputPath, { flags: 'a' });
    }

    // ── Real-time stream processing ──
    this.terminal.onData((chunk: string) => {
      this.lastOutputAt = Date.now();
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

  /** Send prompt text without implicitly submitting it. */
  sendPrompt(prompt: string): void {
    this.write(prompt);
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
    if (state === 'busy' || state === 'waiting_input' || state === 'needs_confirmation') {
      this.stalledReason = null;
    }
    this.emit('state-change', state, prev);
  }

  getRunId(): string | null {
    return this.currentRunId;
  }

  setRunId(runId: string | null): void {
    this.currentRunId = runId;
  }

  beginRun(runId: string, promptText: string, promptPreview: string): void {
    this.currentRunId = runId;
    this.promptText = promptText;
    this.promptPreview = promptPreview;
    this.submitAttempts = 0;
    this.lastSubmitAt = null;
    this.stalledReason = null;
  }

  isAlive(): boolean {
    return this._alive;
  }

  getLastOutputAt(): number | null {
    return this.lastOutputAt;
  }

  getPromptPreview(): string | null {
    return this.promptPreview;
  }

  getPromptText(): string | null {
    return this.promptText;
  }

  getSubmitAttempts(): number {
    return this.submitAttempts;
  }

  getLastSubmitAt(): number | null {
    return this.lastSubmitAt;
  }

  markSubmitAttempt(): void {
    this.submitAttempts += 1;
    this.lastSubmitAt = Date.now();
  }

  getStalledReason(): string | null {
    return this.stalledReason;
  }

  setStalledReason(reason: string | null): void {
    this.stalledReason = reason;
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
