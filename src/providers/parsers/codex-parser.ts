/**
 * CodexOutputParser — real-time stream parser for Codex CLI interactive output.
 */
import type { PTYSession, OutputParser, WaitingInputEvent } from '../../manager/pty-session.js';

const DANGEROUS_RE = /rm\s+-rf|git\s+push\s+--force|DROP\s+TABLE|DELETE\s+FROM|TRUNCATE/i;

export class CodexOutputParser implements OutputParser {
  private accumulated = '';

  reset(): void {
    this.accumulated = '';
  }

  feed(chunk: string, session: PTYSession): void {
    this.accumulated += chunk;

    const state = session.getState();

    // ── booting → ready ──
    if (state === 'booting') {
      if (this.hasPrompt()) {
        session.setState('ready');
        this.accumulated = '';
        return;
      }
      // Trust/sandbox prompt during boot
      if (/trust|sandbox|approve/i.test(this.accumulated) && /\[y\/n\]|Enter/i.test(this.accumulated)) {
        session.setState('waiting_input');
        session.emit('waiting-input', {
          type: 'trust',
          prompt: 'Codex trust/sandbox prompt',
          dangerous: false,
          timestamp: new Date().toISOString(),
        } satisfies WaitingInputEvent);
        this.accumulated = '';
        return;
      }
      return;
    }

    // ── Permission prompts ──
    const permMatch = this.accumulated.match(/\? (Allow|Approve|Execute)[:\s]+(.+?)(?:\n|$)/);
    if (permMatch) {
      const promptText = permMatch[2].trim();
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

    // ── waiting_input → ready ──
    if (state === 'waiting_input' && this.hasPrompt()) {
      session.setState('ready');
      this.accumulated = '';
      return;
    }

    // ── ready → busy ──
    if (state === 'ready' && this.hasBusyIndicator(chunk)) {
      session.setState('busy');
    }

    // ── busy → ready (run completed) ──
    if (state === 'busy' && this.hasPrompt()) {
      const runId = session.getRunId();
      if (runId) {
        session.emit('run-completed', runId);
      }
      session.setState('ready');
      this.accumulated = '';
      return;
    }

    if (this.accumulated.length > 50_000) {
      this.accumulated = this.accumulated.slice(-10_000);
    }
  }

  private hasPrompt(): boolean {
    // Codex prompt: $ or ❯ at end of line
    return /[$❯>]\s*$/.test(this.accumulated.trimEnd());
  }

  private hasBusyIndicator(chunk: string): boolean {
    return /Running|Thinking|Executing|apply_patch|Searching|Reading/.test(chunk);
  }
}
