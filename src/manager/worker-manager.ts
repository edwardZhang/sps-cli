/**
 * WorkerManager — ACP interface entry point (v0.24.x).
 *
 * Defines the contract between SPS engine layer (orchestrator) and
 * worker process management (executor).  The SPS engines call these
 * methods; the implementation encapsulates Supervisor, CompletionJudge,
 * ResourceLimiter, and (transitionally) PostActions.
 *
 * See: docs/design/14-acp-worker-manager-protocol.md
 */

import type { CompletionResult } from './completion-judge.js';

// ─── Worker State ────────────────────────────────────────────────

export type WorkerState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'waiting_input'
  | 'needs_confirmation'
  | 'completed'
  | 'failed';

// ─── Phase ───────────────────────────────────────────────────────

export type WorkerPhase = 'development' | 'integration';

// ─── Pending Input ───────────────────────────────────────────────

export interface WMPendingInput {
  type: 'text' | 'confirmation';
  prompt: string;
  options?: string[];
  detectedAt: string;
}

// ─── Request Types ───────────────────────────────────────────────

export interface TaskRunRequest {
  taskId: string;
  cardId: string;
  project: string;
  phase: WorkerPhase;
  prompt: string;
  cwd: string;
  branch: string;
  targetBranch: string;
  tool: 'claude' | 'codex';
  transport: 'proc' | 'acp-sdk';
  outputFile: string;
  timeoutSec?: number;
  maxRetries?: number;
  env?: Record<string, string>;
}

export interface TaskResumeRequest {
  taskId: string;
  cardId: string;
  project: string;
  phase: WorkerPhase;
  prompt: string;
  cwd: string;
  branch: string;
  targetBranch: string;
  tool: 'claude' | 'codex';
  transport: 'proc' | 'acp-sdk';
  outputFile: string;
  sessionId?: string;
}

export interface TaskCancelRequest {
  taskId: string;
  project: string;
  reason: 'timeout' | 'user_cancel' | 'anomaly';
}

export interface TaskInputRequest {
  taskId: string;
  project: string;
  input: string;
}

export interface TaskConfirmRequest {
  taskId: string;
  project: string;
  action: 'confirm' | 'reject';
  message?: string;
}

export interface InspectQuery {
  project?: string;
  taskId?: string;
  slot?: string;
}

// ─── Response Types ──────────────────────────────────────────────

export type RejectReason =
  | 'resource_exhausted'
  | 'duplicate_task'
  | 'invalid_request'
  | 'spawn_failed';

export interface TaskRunResponse {
  accepted: boolean;
  slot: string | null;
  workerId: string | null;
  pid?: number;
  sessionId?: string;
  queued?: boolean;
  queuePosition?: number;
  rejectReason?: RejectReason;
}

// ─── Worker Snapshot ─────────────────────────────────────────────

export interface WorkerSnapshot {
  slot: string;
  taskId: string | null;
  cardId: string | null;
  project: string;
  state: WorkerState;
  phase: WorkerPhase | null;
  pid: number | null;
  sessionId: string | null;
  cwd: string | null;
  branch: string | null;
  startedAt: string | null;
  updatedAt: string;
  outputTail: string | null;
  pendingInput: WMPendingInput | null;
}

// ─── Events ──────────────────────────────────────────────────────

export type WorkerEventType =
  | 'status.update'
  | 'run.completed'
  | 'run.failed'
  | 'input.required';

export interface WorkerEvent {
  type: WorkerEventType;
  taskId: string;
  cardId: string;
  project: string;
  phase: WorkerPhase;
  slot: string;
  workerId: string;
  timestamp: string;
  state: WorkerState;

  /** Present on run.completed / run.failed */
  exitCode?: number;
  completionResult?: CompletionResult;

  /** Present on input.required */
  pendingInput?: WMPendingInput;

  /** Last lines of worker output */
  outputTail?: string;
  /** Error message on failure */
  error?: string;
}

export type WorkerEventHandler = (event: WorkerEvent) => void;

// ─── Recovery ────────────────────────────────────────────────────

export interface RecoveryContext {
  project: string;
  stateFile: string;
  baseBranch: string;
}

export interface RecoveryResult {
  scanned: number;
  alive: number;
  completed: number;
  failed: number;
  released: number;
  rebuilt: number;
  queueRebuilt: number;
  events: WorkerEvent[];
}

// ─── WorkerManager Interface ─────────────────────────────────────

export interface WorkerManager {
  /**
   * Launch a new worker for a task.
   * Allocates slot, spawns process, registers exit callback chain.
   */
  run(request: TaskRunRequest): Promise<TaskRunResponse>;

  /**
   * Resume a previously started task (same worktree, optionally same session).
   */
  resume(request: TaskResumeRequest): Promise<TaskRunResponse>;

  /**
   * Cancel a running or queued task.
   * SIGTERM → 5s grace → SIGKILL. Releases slot + resources.
   */
  cancel(request: TaskCancelRequest): Promise<void>;

  /**
   * Send text input to a worker waiting for stdin.
   * Only supported for ACP transport; proc returns unsupported error.
   */
  sendInput(request: TaskInputRequest): Promise<void>;

  /**
   * Confirm or reject a worker's confirmation prompt.
   * Only supported for ACP transport.
   */
  confirm(request: TaskConfirmRequest): Promise<void>;

  /**
   * Inspect current worker state.
   * Returns snapshots filtered by query (project, taskId, or slot).
   */
  inspect(query: InspectQuery): WorkerSnapshot[];

  /**
   * Register an event handler for worker lifecycle events.
   * Events are persisted to state.json before callback invocation.
   */
  onEvent(handler: WorkerEventHandler): void;

  /**
   * Recover workers after tick restart.
   * Scans state.json, checks PID survival, rebuilds projections.
   */
  recover(contexts: RecoveryContext[]): Promise<RecoveryResult>;
}
