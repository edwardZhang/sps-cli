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
  stop(session: string): Promise<void>;
  collectSummary(session: string): Promise<string>;
}
