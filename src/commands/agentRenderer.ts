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

export async function waitAndStream(
  runtime: AgentRuntime,
  slot: string,
  opts?: { pollMs?: number; signal?: AbortSignal; stateFile?: string },
): Promise<StreamResult> {
  const pollMs = opts?.pollMs ?? 2_000;
  let lastLen = 0;
  let fullOutput = '';

  while (true) {
    if (opts?.signal?.aborted) {
      return { status: 'cancelled', output: fullOutput };
    }

    const state = await runtime.inspect(slot);
    const session = state.sessions[slot];
    if (!session) {
      return { status: 'lost', output: fullOutput };
    }

    // Stream incremental output
    const paneText = session.lastPaneText || '';
    if (paneText.length > lastLen) {
      const newText = paneText.slice(lastLen);
      process.stdout.write(newText);
      fullOutput += newText;
      lastLen = paneText.length;
    }

    // Check run status
    const runStatus = session.currentRun?.status;
    if (runStatus === 'completed') {
      if (opts?.stateFile) clearRunInState(opts.stateFile, slot);
      return { status: 'completed', output: fullOutput };
    }
    if (runStatus === 'failed' || runStatus === 'cancelled' || runStatus === 'lost') {
      if (opts?.stateFile) clearRunInState(opts.stateFile, slot);
      return { status: runStatus, output: fullOutput };
    }

    // Session offline with no active run
    if (session.sessionState === 'offline' && !session.currentRun) {
      return { status: 'lost', output: fullOutput };
    }

    await new Promise((r) => setTimeout(r, pollMs));
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
