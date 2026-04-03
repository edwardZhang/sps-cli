/**
 * Agent output renderer — polls AgentRuntime.inspect() and streams
 * incremental output to stdout. Shared by sps agent (one-shot + chat).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { readState, writeState } from '../core/state.js';
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';

export interface StreamResult {
  status: 'completed' | 'failed' | 'cancelled' | 'lost';
  output: string;
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const DIM = '\x1b[90m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

export interface WaitAndStreamOpts {
  pollMs?: number;
  signal?: AbortSignal;
  stateFile?: string;
  verbose?: boolean;
  logsDir?: string;
  quiet?: boolean;
}

export async function waitAndStream(
  runtime: AgentRuntime,
  slot: string,
  opts?: WaitAndStreamOpts,
): Promise<StreamResult> {
  const pollMs = opts?.pollMs ?? 2_000;
  let lastTextLen = 0;
  let lastLogLen = 0;
  let fullOutput = '';
  let spinnerIdx = 0;
  let hasOutput = false;
  const verbose = opts?.verbose ?? false;
  const quiet = opts?.quiet ?? false;

  // Find latest ACP log file for verbose mode
  let logFile: string | null = null;
  if (verbose && opts?.logsDir) {
    logFile = findLatestAcpLog(opts.logsDir);
  }

  // Print newline before spinner (separate from user input line)
  if (!quiet) process.stderr.write('\n');

  // Start spinner (suppressed in quiet/json mode)
  const spinnerInterval = quiet ? null : setInterval(() => {
    if (!hasOutput) {
      const frame = SPINNER[spinnerIdx % SPINNER.length];
      process.stderr.write(`\r${DIM}${frame} thinking...${RESET}`);
      spinnerIdx++;
    }
  }, 80);

  const clearSpinner = () => {
    if (spinnerInterval) clearInterval(spinnerInterval);
    if (!hasOutput && !quiet) {
      process.stderr.write('\r\x1b[K');
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

      // Verbose mode: stream tool calls from ACP log file
      if (verbose && opts?.logsDir) {
        if (!logFile) logFile = findLatestAcpLog(opts.logsDir);
        if (logFile) {
          const newLines = readLogIncrement(logFile, lastLogLen);
          if (newLines.content.length > 0) {
            if (!hasOutput) {
              clearSpinner();
              process.stderr.write(`${CYAN}▶ Agent${RESET}\n`);
              hasOutput = true;
            }
            for (const line of newLines.lines) {
              if (line.includes('[tool:') || line.includes('[tool_update]')) {
                process.stderr.write(`${YELLOW}  ${line}${RESET}\n`);
              } else if (line.includes('[assistant]')) {
                const text = line.replace(/^\S+ \[assistant\] /, '');
                process.stdout.write(text);
                fullOutput += text;
              } else if (line.includes('[usage]')) {
                process.stderr.write(`${DIM}  ${line}${RESET}\n`);
              } else if (!line.match(/^\S+ \[/)) {
                // Continuation text (multi-line assistant output without tag)
                process.stdout.write(line);
                fullOutput += line;
              }
            }
            lastLogLen = newLines.offset;
          }
        }
      } else {
        // Normal mode: stream text from lastPaneText
        const paneText = session.lastPaneText || '';
        if (paneText.length > lastTextLen) {
          if (!hasOutput) {
            clearSpinner();
            if (!quiet) process.stderr.write(`${CYAN}▶ Agent${RESET}\n`);
            hasOutput = true;
          }
          const newText = paneText.slice(lastTextLen);
          if (!quiet) process.stdout.write(newText);
          fullOutput += newText;
          lastTextLen = paneText.length;
        }
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
    if (spinnerInterval) clearInterval(spinnerInterval);
  }
}

/** Find the most recent *-acp-*.log file in a directory. */
function findLatestAcpLog(logsDir: string): string | null {
  try {
    const files = readdirSync(logsDir)
      .filter(f => f.includes('-acp-') && f.endsWith('.log'))
      .map(f => resolve(logsDir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    return files[0] ?? null;
  } catch {
    return null;
  }
}

/** Read new lines from a log file starting at byte offset. */
function readLogIncrement(file: string, fromOffset: number): { lines: string[]; content: string; offset: number } {
  try {
    const content = readFileSync(file, 'utf-8');
    if (content.length <= fromOffset) return { lines: [], content: '', offset: fromOffset };
    const newContent = content.slice(fromOffset);
    return {
      lines: newContent.split('\n').filter(l => l.length > 0),
      content: newContent,
      offset: content.length,
    };
  } catch {
    return { lines: [], content: '', offset: fromOffset };
  }
}

/**
 * Clear currentRun from session state so the slot can accept the next prompt.
 *
 * Note: Uses readState/writeState directly instead of RuntimeStore because
 * harness mode operates with SessionContext (no ProjectContext/RuntimeStore).
 * writeState is atomic (write-to-temp-then-rename) so this is safe.
 */
function clearRunInState(stateFile: string, slot: string): void {
  try {
    const state = readState(stateFile, 0);
    if (state.sessions?.[slot]?.currentRun) {
      state.sessions[slot].currentRun = null;
      state.sessions[slot].status = 'idle';
      writeState(stateFile, state, 'agent-clear-run');
    }
  } catch {
    // Best effort — session cleanup is non-critical
  }
}
