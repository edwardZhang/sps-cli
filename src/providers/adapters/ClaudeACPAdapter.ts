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

const CLAUDE_READY = /bypass permissions|\? for shortcuts|tips for shortcuts/i;
const CLAUDE_PROMPT = /❯\s*$/m;
const CONFIRMATION_PROMPT = /(Do you want to proceed|y\/n|press enter|confirm|approve)/i;
const THEME_PROMPT = /Choose the text style that looks best with your terminal|Dark mode|Light mode/i;
const LOGIN_METHOD_PROMPT = /Select login method|Claude account with subscription|Anthropic Console account/i;
const BROWSER_SIGNIN_PROMPT = /Opening browser to sign in|Browser didn't open\?|Paste code here if prompted/i;

function isReady(text: string): boolean {
  return CLAUDE_READY.test(text) || (/Claude Code/i.test(text) && CLAUDE_PROMPT.test(text));
}

function needsStartupInput(text: string): boolean {
  return THEME_PROMPT.test(text) || LOGIN_METHOD_PROMPT.test(text) || BROWSER_SIGNIN_PROMPT.test(text);
}

export class ClaudeACPAdapter {
  async ensureSession(input: EnsureSessionInput): Promise<EnsureSessionResult> {
    const claudeCmd = 'claude --dangerously-skip-permissions';
    const ready = await this.bootstrapSession(input, claudeCmd);
    if (!ready) {
      const paneText = capturePaneText(input.sessionName, 80);
      if (needsStartupInput(paneText)) {
        return {
          sessionId: input.sessionName,
          sessionState: 'booting',
          paneText,
          lastSeenAt: new Date().toISOString(),
        };
      }
      throw new Error('Claude ACP session did not become ready within timeout');
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
          runState: CONFIRMATION_PROMPT.test(pane) ? 'waiting_input' : 'running',
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
      sessionState: isReady(pane) ? 'ready' : (needsStartupInput(pane) ? 'booting' : 'busy'),
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
    if (CONFIRMATION_PROMPT.test(pane)) {
      runState = 'waiting_input';
    } else if (isReady(pane)) {
      runState = 'completed';
    }
    return {
      runState,
      paneText: pane,
      lastSeenAt: new Date().toISOString(),
    };
  }

  async stopSession(input: StopSessionInput): Promise<void> {
    if (!sessionExists(input.sessionName)) return;
    tmux(['send-keys', '-t', input.sessionName, '/exit', 'Enter']);
    await sleep(500);
    tmux(['kill-session', '-t', input.sessionName]);
  }

  private async bootstrapSession(input: EnsureSessionInput, claudeCmd: string): Promise<boolean> {
    if (input.resetExisting && sessionExists(input.sessionName)) {
      tmux(['kill-session', '-t', input.sessionName]);
      await sleep(500);
    }

    if (sessionExists(input.sessionName)) {
      const pane = capturePaneText(input.sessionName, 20);
      if (isReady(pane)) return true;
      tmux(['send-keys', '-t', input.sessionName, 'C-c']);
      await sleep(500);
      tmux(['send-keys', '-t', input.sessionName, claudeCmd, 'Enter']);
    } else {
      const result = tmux(['new-session', '-d', '-s', input.sessionName, '-c', input.cwd]);
      if (result === null && !sessionExists(input.sessionName)) {
        throw new Error(`Failed to create tmux session: ${input.sessionName}`);
      }
      tmux(['send-keys', '-t', input.sessionName, claudeCmd, 'Enter']);
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
    tmux(['send-keys', '-t', input.sessionName, claudeCmd, 'Enter']);
    return this.waitReady(input.sessionName, 90_000);
  }

  private async waitReady(session: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    await sleep(3_000);

    while (Date.now() < deadline) {
      const text = capturePaneText(session, 20);
      if (THEME_PROMPT.test(text) || LOGIN_METHOD_PROMPT.test(text)) {
        tmux(['send-keys', '-t', session, 'Enter']);
        await sleep(2_000);
        continue;
      }
      if (BROWSER_SIGNIN_PROMPT.test(text)) {
        return false;
      }
      if (isReady(text)) return true;
      await sleep(2_000);
    }

    return false;
  }
}
