/**
 * ClaudeOutputParser — real-time stream parser for Claude Code interactive output.
 *
 * Detects state transitions by matching patterns in the stripped-ANSI text stream.
 * Fed by PTYSession.onData → stripAnsi → parser.feed()
 */
import type { PTYSession, OutputParser, WaitingInputEvent } from '../../manager/pty-session.js';

const DANGEROUS_RE = /rm\s+-rf|git\s+push\s+--force|DROP\s+TABLE|DELETE\s+FROM|TRUNCATE|format\s+c:|dd\s+if=/i;

export class ClaudeOutputParser implements OutputParser {
  private accumulated = '';
  private lastPromptAt = 0;

  reset(): void {
    this.accumulated = '';
    this.lastPromptAt = 0;
  }

  feed(chunk: string, session: PTYSession): void {
    this.accumulated += chunk;

    const state = session.getState();

    // ── booting → ready (prompt appears for the first time) ──
    if (state === 'booting') {
      // Check both accumulated and current chunk for prompt
      if (this.hasPrompt() || this.hasPromptInChunk(chunk)) {
        session.setState('ready');
        this.lastPromptAt = Date.now();
        this.accumulated = '';
        return;
      }
      // Also detect "bypass permissions" as ready indicator
      if (/bypass permissions/i.test(this.accumulated)) {
        session.setState('ready');
        this.lastPromptAt = Date.now();
        this.accumulated = '';
        return;
      }

      // Trust prompt during boot
      if (this.accumulated.includes('Yes, I trust this folder') ||
          this.accumulated.includes('trust this folder')) {
        session.setState('waiting_input');
        session.emit('waiting-input', {
          type: 'trust',
          prompt: 'Trust this folder?',
          options: ['Yes', 'No'],
          dangerous: false,
          timestamp: new Date().toISOString(),
        } satisfies WaitingInputEvent);
        this.accumulated = '';
        return;
      }
      return;
    }

    // ── Permission / confirmation prompts (any state) ──
    const permMatch = this.accumulated.match(/\? Allow[:\s]+(.+?)(?:\n|$)/);
    if (permMatch) {
      const promptText = permMatch[1].trim();
      session.setState('waiting_input');
      session.emit('waiting-input', {
        type: 'permission',
        prompt: promptText,
        dangerous: DANGEROUS_RE.test(promptText),
        timestamp: new Date().toISOString(),
      } satisfies WaitingInputEvent);
      this.accumulated = '';
      return;
    }

    if (/Enter to confirm|Esc to cancel|y\/n\]?\s*$/i.test(this.accumulated)) {
      const lines = this.accumulated.split('\n').filter(Boolean);
      const promptText = lines[lines.length - 1]?.trim() || 'Confirmation required';
      session.setState('waiting_input');
      session.emit('waiting-input', {
        type: 'confirmation',
        prompt: promptText,
        dangerous: DANGEROUS_RE.test(this.accumulated),
        timestamp: new Date().toISOString(),
      } satisfies WaitingInputEvent);
      this.accumulated = '';
      return;
    }

    // ── waiting_input → ready (user responded, prompt came back) ──
    if (state === 'waiting_input' && this.hasPrompt()) {
      session.setState('ready');
      this.lastPromptAt = Date.now();
      this.accumulated = '';
      return;
    }

    // ── ready → busy (content appearing after prompt = Worker started working) ──
    if (state === 'ready' && this.hasBusyIndicator(chunk)) {
      session.setState('busy');
    }

    // ── busy → ready (prompt reappeared = run completed) ──
    if (state === 'busy' && (this.hasPrompt() || this.hasPromptInChunk(chunk))) {
      const runId = session.getRunId();
      if (runId) {
        session.emit('run-completed', runId);
      }
      session.setState('ready');
      this.lastPromptAt = Date.now();
      this.accumulated = '';
      return;
    }

    // Prevent memory leak
    if (this.accumulated.length > 50_000) {
      this.accumulated = this.accumulated.slice(-10_000);
    }
  }

  // ── Pattern matchers ──

  private hasPrompt(): boolean {
    // Claude Code prompt: ❯ or > at end of a line, or bypass permissions indicator
    return /[❯>]\s*$/m.test(this.accumulated) || /bypass permissions/i.test(this.accumulated);
  }

  private hasPromptInChunk(chunk: string): boolean {
    // Check raw chunk for prompt characters (may have ANSI around them)
    return chunk.includes('❯') || chunk.includes('bypass permissions');
  }

  private hasBusyIndicator(chunk: string): boolean {
    // Spinner, tool calls, or working indicators
    return /[●◐◑◒◓]|Working|Thinking|Read|Write|Bash|Edit|Search|Glob|Agent/.test(chunk);
  }
}
