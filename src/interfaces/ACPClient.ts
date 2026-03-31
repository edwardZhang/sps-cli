import type { ACPSessionStatus, ACPRunStatus, ACPTool } from '../models/acp.js';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Array<{ name: string; value: string }>;
}

export interface EnsureSessionInput {
  sessionName: string;
  tool: ACPTool;
  cwd: string;
  resetExisting?: boolean;
  /** Directory for worker output logs (enables sps logs) */
  logsDir?: string;
  /** MCP servers to attach to this session */
  mcpServers?: McpServerConfig[];
}

export interface EnsureSessionResult {
  sessionId: string;
  sessionState: ACPSessionStatus;
  paneText: string;
  lastSeenAt: string;
  /** Adapter child process PID (for cross-process liveness checks) */
  pid?: number | null;
}

export interface StartRunInput {
  sessionName: string;
  tool: ACPTool;
  prompt: string;
}

export interface StartRunResult {
  runId: string;
  runState: ACPRunStatus;
  paneText: string;
  lastSeenAt: string;
  /** Adapter child process PID */
  pid?: number | null;
}

export interface InspectSessionInput {
  sessionName: string;
  tool: ACPTool;
  /** Persisted PID for cross-process fallback liveness check */
  pid?: number | null;
}

export interface InspectSessionResult {
  sessionState: ACPSessionStatus;
  paneText: string;
  lastSeenAt: string;
}

export interface InspectRunInput {
  sessionName: string;
  tool: ACPTool;
  activeRun: boolean;
  /** Persisted PID for cross-process fallback liveness check */
  pid?: number | null;
}

export interface InspectRunResult {
  runState: ACPRunStatus | null;
  paneText: string;
  lastSeenAt: string;
}

export interface StopSessionInput {
  sessionName: string;
  tool: ACPTool;
}

export interface ACPClient {
  ensureSession(input: EnsureSessionInput): Promise<EnsureSessionResult>;
  startRun(input: StartRunInput): Promise<StartRunResult>;
  inspectSession(input: InspectSessionInput): Promise<InspectSessionResult>;
  inspectRun(input: InspectRunInput): Promise<InspectRunResult>;
  stopSession(input: StopSessionInput): Promise<void>;
}
