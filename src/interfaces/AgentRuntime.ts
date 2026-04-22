/**
 * @module        AgentRuntime
 * @description   Agent 运行时接口，抽象会话管理与任务执行的统一契约
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

import type { ACPSessionRecord, ACPState, ACPTool } from '../models/acp.js';
import type { AccumulatorListener, McpServerConfig } from './ACPClient.js';

export interface AgentRuntime {
  ensureSession(slot: string, tool?: ACPTool, cwd?: string, opts?: { mcpServers?: McpServerConfig[]; extraEnv?: Record<string, string> }): Promise<ACPSessionRecord>;
  startRun(slot: string, prompt: string, tool?: ACPTool, cwd?: string, opts?: { extraEnv?: Record<string, string> }): Promise<ACPSessionRecord>;
  resumeRun(slot: string, prompt: string): Promise<ACPSessionRecord>;
  inspect(slot?: string): Promise<ACPState>;
  stopSession(slot: string): Promise<void>;
  /**
   * Attach a listener to the current session for real-time accumulator events.
   * Returns an unsubscribe function. Session must already exist (call ensureSession first).
   */
  subscribe(slot: string, listener: AccumulatorListener): () => void;
}
