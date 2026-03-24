import type { WorkerStatus } from '../models/types.js';

/** Result returned by launch() and sendFix()/resolveConflict() in print mode. */
export interface LaunchResult {
  /** OS process ID (print mode) or 0 (interactive mode) */
  pid: number;
  /** Path to the JSONL output file (print mode) or '' (interactive) */
  outputFile: string;
  /** Claude/Codex session ID for resume chains (print mode) */
  sessionId?: string;
}

export interface WorkerProvider {
  /** Validate that the worktree directory exists and is a git repo. */
  prepareEnv(worktree: string, seq: string): Promise<void>;

  /**
   * Launch a worker to execute the task described in promptFile.
   *
   * - Print mode: spawns `claude -p` / `codex exec` as a child process.
   *   Returns immediately with pid, outputFile, and sessionId.
   *   The process runs in the background; use inspect()/detectCompleted()
   *   to track progress.
   *
   * - Interactive mode: starts TUI in tmux, waits for ready, sends prompt.
   *   Returns { pid: 0, outputFile: '' } as stub.
   */
  launch(session: string, worktree: string, promptFile: string): Promise<LaunchResult>;

  /**
   * Inspect a worker: check if alive and capture recent output.
   * - Print mode: checks PID liveness + tails output file.
   * - Interactive mode: checks tmux session + captures pane text.
   */
  inspect(session: string): Promise<{
    alive: boolean;
    paneText: string;
    pid?: number;
    exitCode?: number;
  }>;

  /**
   * Detect whether the worker has completed its task.
   * - Print mode: process exited with code 0 → COMPLETED, non-zero → DEAD.
   * - Interactive mode: pane text scraping + marker files.
   */
  detectCompleted(session: string, logDir: string, branch: string): Promise<WorkerStatus>;

  /**
   * Detect if worker is waiting for user confirmation.
   * Only meaningful for interactive mode; print mode providers return
   * { waiting: false } since --dangerously-skip-permissions is used.
   */
  detectWaiting(session: string): Promise<{ waiting: boolean; destructive: boolean; prompt: string }>;

  /**
   * Check if worker appears blocked (errors, stuck states).
   * Only meaningful for interactive mode.
   */
  detectBlocked(session: string): Promise<boolean>;

  /**
   * Send a fix prompt to the worker (e.g. after CI failure).
   *
   * - Print mode: spawns a NEW process with --resume <sessionId>,
   *   returns a new LaunchResult with the new pid/outputFile.
   * - Interactive mode: sends text via tmux, returns void-equivalent.
   *
   * @param resumeSessionId - Session ID to resume (print mode only)
   */
  sendFix(session: string, fixPrompt: string, resumeSessionId?: string): Promise<LaunchResult | void>;

  /**
   * Send conflict resolution instructions to the worker.
   *
   * - Print mode: spawns a NEW process with --resume <sessionId>.
   * - Interactive mode: sends text via tmux.
   *
   * @param resumeSessionId - Session ID to resume (print mode only)
   */
  resolveConflict(
    session: string,
    worktree: string,
    branch: string,
    resumeSessionId?: string,
  ): Promise<LaunchResult | void>;

  /**
   * Release a worker session after task completion.
   * - Print mode: no-op (process already exited).
   * - Interactive mode: optionally exit CLI / keep for reuse.
   */
  release(session: string): Promise<void>;

  /**
   * Force-stop a worker (error recovery, cleanup).
   * - Print mode: kill(pid, SIGTERM) → SIGKILL.
   * - Interactive mode: /exit + kill tmux session.
   */
  stop(session: string): Promise<void>;

  /** Collect recent output as a summary string. */
  collectSummary(session: string): Promise<string>;
}
