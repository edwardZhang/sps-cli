/**
 * @module        types
 * @description   核心数据类型定义，包括 Card、Worker 状态、MR 状态及命令结果等
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-19
 * @updated       2026-04-02
 *
 * @role          model
 * @layer         model
 * @boundedContext shared-types
 */

/** Unified card representation across PM backends */
export interface Card {
  id: string;
  seq: string;
  name: string;
  desc: string;
  state: CardState;
  labels: string[];
  meta: Record<string, unknown>;
}

/** Card state — defaults are Planning/Backlog/Todo/Inprogress/QA/Done but configurable via pipeline YAML */
export type CardState = string;

export type AuxiliaryState = 'BLOCKED' | 'NEEDS-FIX' | 'WAITING-CONFIRMATION' | 'CONFLICT' | 'STALE-RUNTIME';

/** Worker detection result */
export type WorkerStatus =
  | 'ALIVE'
  | 'COMPLETED'
  | 'NEEDS_INPUT'
  | 'AUTO_CONFIRM'
  | 'BLOCKED'
  | 'DEAD'
  | 'DEAD_EXCEEDED'
  /** Process exited (code 0) but no artifacts found (no commits/MR). Worker gave up or hit token limit. */
  | 'EXITED_INCOMPLETE';

/** MR status from repo backend */
export interface MrStatus {
  exists: boolean;
  state: 'opened' | 'merged' | 'closed' | 'not_found';
  ciStatus: 'success' | 'failed' | 'running' | 'pending' | 'created' | 'unknown';
  mergeStatus: 'can_be_merged' | 'cannot_be_merged' | 'checking' | 'unknown';
  url: string | null;
  iid: number | null;
}

/** Result from a tick step or command */
export interface CommandResult {
  project: string;
  component: string;
  status: 'ok' | 'fail' | 'degraded' | 'skipped';
  exitCode: number;
  actions: ActionRecord[];
  recommendedActions: RecommendedAction[];
  details: Record<string, unknown>;
}

export interface ActionRecord {
  action: string;
  entity: string;
  result: 'ok' | 'fail' | 'skip';
  message?: string;
}

/** Tick aggregated result */
export interface TickResult extends CommandResult {
  steps: StepResult[];
}

export interface StepResult {
  step: string;
  status: 'ok' | 'fail' | 'degraded' | 'skipped';
  exitCode: number;
  error?: string;
  note?: string;
  actions?: ActionRecord[];
  checks?: CheckResult[];
}

/** recommendedActions protocol (03 §8.4) */
export interface RecommendedAction {
  action: string;
  reason: string;
  severity: 'info' | 'warning' | 'critical';
  autoExecutable: boolean;
  requiresConfirmation: boolean;
  safeToRetry: boolean;
}

/** Doctor check result */
export interface CheckResult {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'skip';
  message: string;
}
