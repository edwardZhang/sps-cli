import type { WorkerStatus } from '../models/types.js';

export interface WorkerProvider {
  prepareEnv(worktree: string, seq: string): Promise<void>;
  launch(session: string, worktree: string): Promise<void>;
  waitReady(session: string, timeoutMs?: number): Promise<boolean>;
  sendTask(session: string, promptFile: string): Promise<void>;
  inspect(session: string): Promise<{ alive: boolean; paneText: string }>;
  detectWaiting(session: string): Promise<{ waiting: boolean; destructive: boolean; prompt: string }>;
  detectCompleted(session: string, logDir: string, branch: string): Promise<WorkerStatus>;
  detectBlocked(session: string): Promise<boolean>;
  sendFix(session: string, fixPrompt: string): Promise<void>;
  resolveConflict(session: string, worktree: string, branch: string): Promise<void>;

  /**
   * Release a worker session after task completion.
   *
   * When WORKER_SESSION_REUSE is enabled: keep the CLI process running
   * inside the tmux session so the next task can hot-reuse it (preserving
   * session state like env vars, loaded MCP servers, etc.).
   *
   * When WORKER_SESSION_REUSE is disabled: exit the CLI and optionally
   * kill the tmux session.
   */
  release(session: string): Promise<void>;

  /**
   * Force-stop a worker session (error recovery, cleanup).
   * Always exits the CLI and kills the tmux session regardless of
   * WORKER_SESSION_REUSE setting.
   */
  stop(session: string): Promise<void>;

  collectSummary(session: string): Promise<string>;
}
