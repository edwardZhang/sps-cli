/**
 * @module        ACPClient
 * @description   ACP 客户端接口定义，规范会话创建、运行启动及状态检查的契约
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-27
 * @updated       2026-04-03
 *
 * @role          interface
 * @layer         interface
 * @boundedContext agent-control-protocol
 */

import type { AccumulatorEvent, AccumulatorListener } from '../providers/adapters/acp-session-accumulator.js';
import type { ACPRunStatus, ACPSessionStatus, ACPTool } from '../models/acp.js';

export type { AccumulatorEvent, AccumulatorListener };

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
  /** Extra env vars passed to the spawned agent process (e.g. SPS_CARD_ID, SPS_STAGE).
   *  These flow through claude-agent-acp to Claude and become available to hook scripts. */
  extraEnv?: Record<string, string>;
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
  /**
   * Attach a listener to an existing session's accumulator to receive structured
   * events (text/tool_use/tool_update/usage) as the run progresses. Returns an
   * unsubscribe function. No-op (returns () => {}) if session does not exist.
   */
  subscribe(sessionName: string, listener: AccumulatorListener): () => void;
}
