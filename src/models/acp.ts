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
  | 'draining'
  | 'offline';

export type ACPRunStatus =
  | 'submitted'
  | 'running'
  | 'waiting_input'
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

export interface ACPSessionRecord {
  slot: string;
  tool: ACPTool;
  sessionId: string;
  sessionName: string;
  cwd: string;
  status: ACPSlotStatus;
  sessionState: ACPSessionStatus;
  currentRun: ACPRunRecord | null;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string | null;
  lastPaneText: string;
}

export interface ACPState {
  version: number;
  updatedAt: string;
  updatedBy: string;
  sessions: Record<string, ACPSessionRecord>;
}
