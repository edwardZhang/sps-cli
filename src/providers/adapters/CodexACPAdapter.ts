import type {
  EnsureSessionInput,
  EnsureSessionResult,
  InspectRunInput,
  InspectRunResult,
  InspectSessionInput,
  InspectSessionResult,
  StartRunInput,
  StartRunResult,
  StopSessionInput,
} from '../../interfaces/ACPClient.js';
import { capturePaneText, pastePrompt, sessionExists, sleep, tmux } from '../acpTmux.js';

const CODEX_READY = /›\s.*$/m;
const CODEX_MODEL_LINE = /codex.*default.*·|gpt-.*codex/i;
const CODEX_UPDATE_PROMPT = /Update available|Skip until next version|Press enter to continue/i;
const CODEX_RATE_LIMIT_PROMPT = /rate limit|Switch to .+codex-mini|Keep current model/i;
const CODEX_TRUST_PROMPT = /Do you trust the contents of this directory|1\.\s+Yes, continue|Working with untrusted contents/i;

function isReady(text: string): boolean {
  return (CODEX_MODEL_LINE.test(text) && CODEX_READY.test(text))
    || (/OpenAI Codex/i.test(text) && /›/m.test(text));
}

function waitingInput(text: string): boolean {
  return CODEX_UPDATE_PROMPT.test(text) || CODEX_RATE_LIMIT_PROMPT.test(text);
}

export class CodexACPAdapter {
  async ensureSession(input: EnsureSessionInput): Promise<EnsureSessionResult> {
    const codexCmd = 'codex --sandbox danger-full-access -a never --no-alt-screen';
    const ready = await this.bootstrapSession(input, codexCmd);
    if (!ready) {
      throw new Error('Codex ACP session did not become ready within timeout');
    }

    return {
      sessionId: input.sessionName,
      sessionState: 'ready',
      paneText: capturePaneText(input.sessionName, 40),
      lastSeenAt: new Date().toISOString(),
    };
  }

  async startRun(input: StartRunInput): Promise<StartRunResult> {
    await pastePrompt(input.sessionName, input.prompt);

    for (let attempt = 0; attempt < 3; attempt++) {
      await sleep(2_000);
      const pane = capturePaneText(input.sessionName, 20);
      if (!isReady(pane)) {
        return {
          runId: `${Date.now()}`,
          runState: waitingInput(pane) ? 'waiting_input' : 'running',
          paneText: pane,
          lastSeenAt: new Date().toISOString(),
        };
      }
      tmux(['send-keys', '-t', input.sessionName, 'Enter']);
    }

    return {
      runId: `${Date.now()}`,
      runState: 'running',
      paneText: capturePaneText(input.sessionName, 20),
      lastSeenAt: new Date().toISOString(),
    };
  }

  async inspectSession(input: InspectSessionInput): Promise<InspectSessionResult> {
    if (!sessionExists(input.sessionName)) {
      return { sessionState: 'offline', paneText: '', lastSeenAt: new Date().toISOString() };
    }
    const pane = capturePaneText(input.sessionName, 80);
    return {
      sessionState: isReady(pane) ? 'ready' : 'busy',
      paneText: pane,
      lastSeenAt: new Date().toISOString(),
    };
  }

  async inspectRun(input: InspectRunInput): Promise<InspectRunResult> {
    if (!input.activeRun) {
      return { runState: null, paneText: '', lastSeenAt: new Date().toISOString() };
    }
    if (!sessionExists(input.sessionName)) {
      return { runState: 'lost', paneText: '', lastSeenAt: new Date().toISOString() };
    }
    const pane = capturePaneText(input.sessionName, 120);
    let runState: InspectRunResult['runState'] = 'running';
    if (isReady(pane)) {
      runState = 'completed';
    } else if (waitingInput(pane)) {
      runState = 'waiting_input';
    }
    return {
      runState,
      paneText: pane,
      lastSeenAt: new Date().toISOString(),
    };
  }

  async stopSession(input: StopSessionInput): Promise<void> {
    if (!sessionExists(input.sessionName)) return;
    tmux(['send-keys', '-t', input.sessionName, '/quit', 'Enter']);
    await sleep(500);
    tmux(['kill-session', '-t', input.sessionName]);
  }

  private async bootstrapSession(input: EnsureSessionInput, codexCmd: string): Promise<boolean> {
    if (input.resetExisting && sessionExists(input.sessionName)) {
      tmux(['kill-session', '-t', input.sessionName]);
      await sleep(500);
    }

    if (sessionExists(input.sessionName)) {
      const pane = capturePaneText(input.sessionName, 20);
      if (isReady(pane)) return true;
      tmux(['send-keys', '-t', input.sessionName, 'C-c']);
      await sleep(500);
      tmux(['send-keys', '-t', input.sessionName, 'Enter']);
      await sleep(500);
      tmux(['send-keys', '-t', input.sessionName, codexCmd, 'Enter']);
    } else {
      const result = tmux(['new-session', '-d', '-s', input.sessionName, '-c', input.cwd]);
      if (result === null && !sessionExists(input.sessionName)) {
        throw new Error(`Failed to create tmux session: ${input.sessionName}`);
      }
      tmux(['send-keys', '-t', input.sessionName, codexCmd, 'Enter']);
    }

    if (await this.waitReady(input.sessionName, 90_000)) {
      return true;
    }

    tmux(['kill-session', '-t', input.sessionName]);
    await sleep(500);
    const recreate = tmux(['new-session', '-d', '-s', input.sessionName, '-c', input.cwd]);
    if (recreate === null && !sessionExists(input.sessionName)) {
      throw new Error(`Failed to recreate tmux session: ${input.sessionName}`);
    }
    tmux(['send-keys', '-t', input.sessionName, codexCmd, 'Enter']);
    return this.waitReady(input.sessionName, 90_000);
  }

  private async waitReady(session: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    await sleep(5_000);

    while (Date.now() < deadline) {
      const text = capturePaneText(session, 30);

      if (isReady(text)) return true;

      if (CODEX_UPDATE_PROMPT.test(text)) {
        if (/1\. Update now/i.test(text)) {
          tmux(['send-keys', '-t', session, 'Down']);
          await sleep(300);
          tmux(['send-keys', '-t', session, 'Down']);
          await sleep(300);
        }
        tmux(['send-keys', '-t', session, 'Enter']);
        await sleep(3_000);
        continue;
      }

      if (CODEX_TRUST_PROMPT.test(text)) {
        tmux(['send-keys', '-t', session, 'Enter']);
        await sleep(3_000);
        continue;
      }

      if (CODEX_RATE_LIMIT_PROMPT.test(text)) {
        tmux(['send-keys', '-t', session, 'Escape']);
        await sleep(500);
        tmux(['send-keys', '-t', session, 'Enter']);
        await sleep(2_000);
        continue;
      }
      await sleep(3_000);
    }

    return false;
  }
}
