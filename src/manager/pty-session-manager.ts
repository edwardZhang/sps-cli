/**
 * PTYSessionManager — manages multiple PTY sessions across projects and slots.
 *
 * Each worker slot gets one persistent PTYSession. Sessions are reused across
 * task cards within the same slot.
 *
 * Replaces LocalACPClient + acpTmux.ts for the PTY transport.
 */
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { PTYSession, type SessionState, type OutputParser } from './pty-session.js';
import { ClaudeOutputParser } from '../providers/parsers/claude-parser.js';
import { CodexOutputParser } from '../providers/parsers/codex-parser.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function previewPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

// ─── Types ──────────────────────────────────────────────────────

export interface EnsureSessionOpts {
  project: string;
  slot: string;
  tool: 'claude' | 'codex';
  cwd: string;
  logsDir: string;
  /** Timeout for waiting for ready state (ms). Default: 60000 */
  readyTimeoutMs?: number;
  /** Auto-confirm trust prompts. Default: true */
  autoTrust?: boolean;
}

export interface SessionInfo {
  sessionId: string;
  state: SessionState;
  pid: number;
  tool: 'claude' | 'codex';
  cwd: string;
  runId: string | null;
  buffer: string;
  alive: boolean;
  lastOutputAt: string | null;
  submitAttempts: number;
  stalledReason: string | null;
  promptPreview: string | null;
  executionEvidence: boolean;
}

// ─── Manager ────────────────────────────────────────────────────

export class PTYSessionManager {
  private sessions = new Map<string, PTYSession>();

  private static makeKey(project: string, slot: string): string {
    return `${project}:${slot}`;
  }

  // ─── Session Lifecycle ──────────────────────────────────────

  /**
   * Ensure a ready PTY session exists for the given slot.
   * Reuses existing live session or creates a new one.
   */
  async ensureSession(opts: EnsureSessionOpts): Promise<PTYSession> {
    const key = PTYSessionManager.makeKey(opts.project, opts.slot);

    // Reuse existing live session
    const existing = this.sessions.get(key);
    if (existing?.isAlive()) {
      // If session was left in a worktree from a previous card, we can't change cwd
      // of a running PTY. But the run prompt will include explicit cwd instructions.
      return existing;
    }

    // Clean up dead session
    if (existing) {
      this.sessions.delete(key);
    }

    // Create output log directory
    mkdirSync(opts.logsDir, { recursive: true });
    const outputPath = resolve(opts.logsDir, `${opts.slot}-pty-${Date.now()}.log`);

    // Create parser for the tool
    const parser: OutputParser = opts.tool === 'claude'
      ? new ClaudeOutputParser()
      : new CodexOutputParser();

    // Spawn PTY
    const session = new PTYSession(opts.tool, opts.cwd, outputPath, parser);

    // Auto-handle trust prompts
    if (opts.autoTrust !== false) {
      session.on('waiting-input', (event) => {
        const prompt = event.prompt.toLowerCase();
        const codexUpdateNotice = event.type === 'confirmation' && (
          prompt.includes('update notice') ||
          prompt.includes('press enter to continue')
        );

        if (codexUpdateNotice) {
          this.log(`[${key}] Auto-skipping Codex update notice`);
          session.write('\x1b[B\r');
          return;
        }

        if (event.type === 'trust') {
          this.log(`[${key}] Auto-confirming trust prompt`);
          session.confirm();
        }
      });
    }

    // Clean up on exit
    session.on('exit', (code) => {
      this.log(`[${key}] PTY exited (code=${code})`);
      this.sessions.delete(key);
    });

    this.sessions.set(key, session);

    // Wait for ready
    const timeout = opts.readyTimeoutMs ?? 60_000;
    try {
      await this.waitForState(session, 'ready', timeout);
      this.log(`[${key}] Session ready (pid=${session.pid})`);
    } catch (err) {
      const state = session.getState();
      // If stuck in confirmation/input during boot, still return session
      if (state === 'waiting_input' || state === 'needs_confirmation') {
        this.log(`[${key}] Session waiting for input (pid=${session.pid})`);
      } else {
        this.log(`[${key}] Session failed to reach ready state: ${state}`);
        session.kill();
        this.sessions.delete(key);
        throw err;
      }
    }

    return session;
  }

  // ─── Run Management ─────────────────────────────────────────

  /**
   * Start a new run (send prompt) on an existing session.
   */
  async startRun(project: string, slot: string, prompt: string): Promise<{ runId: string }> {
    const session = this.requireSession(project, slot);
    if (session.getState() !== 'ready') {
      throw new Error(`Session not ready (state=${session.getState()})`);
    }

    const runId = String(Date.now());
    session.beginRun(runId, prompt, previewPrompt(prompt));
    session.sendPrompt(prompt);
    await this.ensurePromptSubmitted(project, slot, session);

    this.log(`[${project}:${slot}] Run started: ${runId}`);
    return { runId };
  }

  /**
   * Resume a run on the same session (for conflict resolution, retries, etc.)
   */
  async resumeRun(project: string, slot: string, instruction: string): Promise<{ runId: string }> {
    const session = this.requireSession(project, slot);
    if (session.getState() !== 'ready') {
      throw new Error(`Session not ready for resume (state=${session.getState()})`);
    }

    const runId = String(Date.now());
    session.beginRun(runId, instruction, previewPrompt(instruction));
    session.sendPrompt(instruction);
    await this.ensurePromptSubmitted(project, slot, session);

    this.log(`[${project}:${slot}] Resume run started: ${runId}`);
    return { runId };
  }

  /**
   * Wait for the current run to complete (prompt reappears).
   */
  async waitForRunComplete(
    project: string,
    slot: string,
    timeoutMs: number = 3_600_000,
  ): Promise<{ status: 'completed' | 'failed' | 'timeout'; runId: string | null }> {
    const session = this.requireSession(project, slot);
    const runId = session.getRunId();

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ status: 'timeout', runId });
      }, timeoutMs);

      const onCompleted = (completedRunId: string) => {
        clearTimeout(timer);
        cleanup();
        resolve({ status: 'completed', runId: completedRunId });
      };

      const onFailed = (failedRunId: string) => {
        clearTimeout(timer);
        cleanup();
        resolve({ status: 'failed', runId: failedRunId });
      };

      const onExit = () => {
        clearTimeout(timer);
        cleanup();
        resolve({ status: 'failed', runId });
      };

      const cleanup = () => {
        session.off('run-completed', onCompleted);
        session.off('run-failed', onFailed);
        session.off('exit', onExit);
      };

      session.on('run-completed', onCompleted);
      session.on('run-failed', onFailed);
      session.on('exit', onExit);
    });
  }

  // ─── Human Interaction ──────────────────────────────────────

  /**
   * Send a response to a waiting-input prompt.
   */
  respond(project: string, slot: string, response: string): void {
    const session = this.requireSession(project, slot);
    this.writeResponse(session, response);
    this.log(`[${project}:${slot}] Sent response: ${response}`);
  }

  async maintainSession(project: string, slot: string): Promise<SessionInfo | null> {
    const session = this.getSession(project, slot);
    if (!session) return null;
    await this.repairPromptSubmission(project, slot, session);
    return this.inspect(project, slot);
  }

  // ─── Inspection ─────────────────────────────────────────────

  getSession(project: string, slot: string): PTYSession | null {
    return this.sessions.get(PTYSessionManager.makeKey(project, slot)) || null;
  }

  inspect(project: string, slot: string): SessionInfo | null {
    const session = this.getSession(project, slot);
    if (!session) return null;
    return {
      sessionId: session.sessionId,
      state: session.getState(),
      pid: session.pid,
      tool: session.tool,
      cwd: session.cwd,
      runId: session.getRunId(),
      buffer: session.getBuffer(30),
      alive: session.isAlive(),
      lastOutputAt: session.getLastOutputAt() ? new Date(session.getLastOutputAt()!).toISOString() : null,
      submitAttempts: session.getSubmitAttempts(),
      stalledReason: session.getStalledReason(),
      promptPreview: session.getPromptPreview(),
      executionEvidence: this.hasExecutionEvidence(session),
    };
  }

  listSessions(): SessionInfo[] {
    const result: SessionInfo[] = [];
    for (const session of this.sessions.values()) {
      result.push({
        sessionId: session.sessionId,
        state: session.getState(),
        pid: session.pid,
        tool: session.tool,
        cwd: session.cwd,
        runId: session.getRunId(),
        buffer: session.getBuffer(5),
        alive: session.isAlive(),
        lastOutputAt: session.getLastOutputAt() ? new Date(session.getLastOutputAt()!).toISOString() : null,
        submitAttempts: session.getSubmitAttempts(),
        stalledReason: session.getStalledReason(),
        promptPreview: session.getPromptPreview(),
        executionEvidence: this.hasExecutionEvidence(session),
      });
    }
    return result;
  }

  // ─── Cleanup ────────────────────────────────────────────────

  killSession(project: string, slot: string): void {
    const key = PTYSessionManager.makeKey(project, slot);
    const session = this.sessions.get(key);
    if (session) {
      session.kill();
      this.sessions.delete(key);
    }
  }

  killAll(): void {
    for (const session of this.sessions.values()) {
      session.kill();
    }
    this.sessions.clear();
  }

  get size(): number {
    return this.sessions.size;
  }

  // ─── Internal ─────────────────────────────────────────────

  private requireSession(project: string, slot: string): PTYSession {
    const session = this.getSession(project, slot);
    if (!session || !session.isAlive()) {
      throw new Error(`No live session for ${project}:${slot}`);
    }
    return session;
  }

  private waitForState(
    session: PTYSession,
    target: SessionState,
    timeoutMs: number,
  ): Promise<void> {
    if (session.getState() === target) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timeout (${timeoutMs}ms) waiting for ${target}, current: ${session.getState()}`)),
        timeoutMs,
      );
      const handler = (state: SessionState) => {
        if (state === target) {
          clearTimeout(timer);
          session.off('state-change', handler);
          resolve();
        }
      };
      session.on('state-change', handler);
      session.on('exit', () => {
        clearTimeout(timer);
        session.off('state-change', handler);
        reject(new Error('Session exited before reaching target state'));
      });
    });
  }

  private log(msg: string): void {
    process.stderr.write(`[pty-manager] ${msg}\n`);
  }

  private writeResponse(session: PTYSession, response: string): void {
    const num = parseInt(response, 10);
    if (!Number.isNaN(num) && num >= 1) {
      const downs = '\x1b[B'.repeat(num - 1);
      session.write(`${downs}\r`);
      return;
    }
    session.write(`${response}\r`);
  }

  private async ensurePromptSubmitted(project: string, slot: string, session: PTYSession): Promise<void> {
    const key = `${project}:${slot}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      session.markSubmitAttempt();
      session.confirm();
      await sleep(900);

      if (this.isRunAccepted(session)) {
        return;
      }

      this.log(`[${key}] Prompt still not executing after submit attempt ${attempt}`);
    }

    session.setStalledReason('Prompt did not start executing after submit attempts');
  }

  private async repairPromptSubmission(project: string, slot: string, session: PTYSession): Promise<void> {
    if (!session.isAlive() || !session.getRunId()) return;
    if (session.getState() !== 'ready') return;

    const attempts = session.getSubmitAttempts();
    if (attempts === 0) return;
    if (this.isRunAccepted(session)) return;

    const lastSubmitAt = session.getLastSubmitAt();
    if (lastSubmitAt && Date.now() - lastSubmitAt < 5_000) return;
    if (attempts >= 6) return;

    const key = `${project}:${slot}`;
    const promptText = session.getPromptText();
    if (attempts >= 3 && promptText) {
      this.log(`[${key}] Re-sending prompt after stalled submit (attempt ${attempts + 1})`);
      session.sendPrompt('\x15');
      await sleep(100);
      session.sendPrompt(promptText);
    } else {
      this.log(`[${key}] Re-submitting Enter after stalled submit (attempt ${attempts + 1})`);
    }

    session.markSubmitAttempt();
    session.confirm();
    await sleep(900);

    if (this.isRunAccepted(session)) {
      session.setStalledReason(null);
      return;
    }

    session.setStalledReason(`Prompt still not executing after ${session.getSubmitAttempts()} submit attempts`);
  }

  private isRunAccepted(session: PTYSession): boolean {
    const state = session.getState();
    if (state === 'busy' || state === 'waiting_input' || state === 'needs_confirmation') {
      return true;
    }
    return this.hasExecutionEvidence(session);
  }

  private hasExecutionEvidence(session: PTYSession): boolean {
    const text = session.getBuffer(120);
    return /Working\(|\bRan\b|I['’]ll do|I['’]m going to|Reading|Searching|Applied|Updated|The repository is|^•\s+/im.test(text);
  }
}
