export type ACPTool = 'claude' | 'codex';

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

export interface ACPState {
  version: number;
  updatedAt: string;
  updatedBy: string;
  sessions: Record<string, ACPSessionRecord>;
}
