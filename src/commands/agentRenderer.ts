/**
 * Agent output renderer — polls AgentRuntime.inspect() and streams
 * incremental output to stdout. Shared by sps agent (one-shot + chat).
 */
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';
import { readState, writeState } from '../core/state.js';

export interface StreamResult {
  status: 'completed' | 'failed' | 'cancelled' | 'lost';
  output: string;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DIM = '\x1b[90m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

export async function waitAndStream(
  runtime: AgentRuntime,
  slot: string,
  opts?: { pollMs?: number; signal?: AbortSignal; stateFile?: string },
): Promise<StreamResult> {
  const pollMs = opts?.pollMs ?? 2_000;
  let lastLen = 0;
  let fullOutput = '';
  let spinnerIdx = 0;
  let hasOutput = false;

  // Print newline before spinner (separate from user input line)
  process.stderr.write('\n');

  // Start spinner
  const spinnerInterval = setInterval(() => {
    if (!hasOutput) {
      const frame = SPINNER[spinnerIdx % SPINNER.length];
      process.stderr.write(`\r${DIM}${frame} thinking...${RESET}`);
      spinnerIdx++;
    }
  }, 80);

  const clearSpinner = () => {
    clearInterval(spinnerInterval);
    if (!hasOutput) {
      process.stderr.write('\r\x1b[K'); // clear spinner line
    }
  };

  try {
    while (true) {
      if (opts?.signal?.aborted) {
        clearSpinner();
        return { status: 'cancelled', output: fullOutput };
      }

      const state = await runtime.inspect(slot);
      const session = state.sessions[slot];
      if (!session) {
        clearSpinner();
        return { status: 'lost', output: fullOutput };
      }

      // Stream incremental output
      const paneText = session.lastPaneText || '';
      if (paneText.length > lastLen) {
        if (!hasOutput) {
          clearSpinner();
          process.stderr.write(`${CYAN}▶ Agent${RESET}\n`);
          hasOutput = true;
        }
        const newText = paneText.slice(lastLen);
        process.stdout.write(newText);
        fullOutput += newText;
        lastLen = paneText.length;
      }

      // Check run status
      const runStatus = session.currentRun?.status;
      if (runStatus === 'completed') {
        clearSpinner();
        if (opts?.stateFile) clearRunInState(opts.stateFile, slot);
        return { status: 'completed', output: fullOutput };
      }
      if (runStatus === 'failed' || runStatus === 'cancelled' || runStatus === 'lost') {
        clearSpinner();
        if (opts?.stateFile) clearRunInState(opts.stateFile, slot);
        return { status: runStatus, output: fullOutput };
      }

      // Session offline with no active run
      if (session.sessionState === 'offline' && !session.currentRun) {
        clearSpinner();
        return { status: 'lost', output: fullOutput };
      }

      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    clearInterval(spinnerInterval);
  }
}

/** Clear currentRun from session state so the slot can accept the next prompt. */
function clearRunInState(stateFile: string, slot: string): void {
  try {
    const state = readState(stateFile, 0);
    if (state.sessions?.[slot]?.currentRun) {
      state.sessions[slot].currentRun = null;
      state.sessions[slot].status = 'idle';
      writeState(stateFile, state, 'agent-clear-run');
    }
  } catch {
    // Best effort
  }
}
