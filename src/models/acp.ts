/**
 * @module        acp
 * @description   ACP（Agent Control Protocol）数据模型，定义会话、运行记录及状态枚举
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-27
 * @updated       2026-03-31
 *
 * @role          model
 * @layer         model
 * @boundedContext agent-control-protocol
 */

export type ACPTool = 'claude' | 'codex' | 'gemini';

export type ACPSlotStatus =
  | 'idle'
  | 'launching'
  | 'active'
  | 'offline';

export type ACPSessionStatus =
  | 'booting'
  | 'ready'
  | 'busy'
  | 'needs_confirmation'
  | 'draining'
  | 'offline';

export type ACPRunStatus =
  | 'submitted'
  | 'running'
  | 'waiting_input'
  | 'needs_confirmation'
  | 'stalled_submit'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'lost';

export interface ACPRunRecord {
  runId: string;
  status: ACPRunStatus;
  promptPreview: string;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface PendingInput {
  type: 'input' | 'trust' | 'permission' | 'confirmation' | 'unknown';
  prompt: string;
  options?: string[];
  dangerous?: boolean;
  timestamp: string;
}

export interface ACPSessionRecord {
  slot: string;
  tool: ACPTool;
  sessionId: string;
  sessionName: string;
  pid?: number | null;
  cwd: string;
  status: ACPSlotStatus;
  sessionState: ACPSessionStatus;
  currentRun: ACPRunRecord | null;
  pendingInput: PendingInput | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  lastOutputAt?: string | null;
  submitAttempts?: number;
  stalledReason?: string | null;
  lastPaneText: string;
}

/**
 * @deprecated ACPState has been merged into RuntimeState.sessions.
 * Use RuntimeState directly — this alias exists only for migration.
 */
export interface ACPState {
  version: number;
  updatedAt: string;
  updatedBy: string;
  sessions: Record<string, ACPSessionRecord>;
}
