/**
 * Agent output renderer — polls AgentRuntime.inspect() and streams
 * incremental output to stdout. Shared by sps agent (one-shot + chat).
 */
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';

export interface StreamResult {
  status: 'completed' | 'failed' | 'cancelled' | 'lost';
  output: string;
}

export async function waitAndStream(
  runtime: AgentRuntime,
  slot: string,
  opts?: { pollMs?: number; signal?: AbortSignal },
): Promise<StreamResult> {
  const pollMs = opts?.pollMs ?? 2_000;
  let lastLen = 0;
  let fullOutput = '';

  while (true) {
    if (opts?.signal?.aborted) {
      return { status: 'cancelled', output: fullOutput };
    }

    const state = await runtime.inspect(slot);
    const session = Object.values(state.sessions)[0];
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
      return { status: 'completed', output: fullOutput };
    }
    if (runStatus === 'failed' || runStatus === 'cancelled' || runStatus === 'lost') {
      return { status: runStatus, output: fullOutput };
    }

    // Session offline with no active run
    if (session.sessionState === 'offline' && !session.currentRun) {
      return { status: 'lost', output: fullOutput };
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }
}
