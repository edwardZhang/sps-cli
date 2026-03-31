import type { ACPState, ACPSessionRecord, ACPTool } from '../models/acp.js';
import type { McpServerConfig } from './ACPClient.js';

export interface AgentRuntime {
  ensureSession(slot: string, tool?: ACPTool, cwd?: string, opts?: { mcpServers?: McpServerConfig[] }): Promise<ACPSessionRecord>;
  startRun(slot: string, prompt: string, tool?: ACPTool, cwd?: string): Promise<ACPSessionRecord>;
  resumeRun(slot: string, prompt: string): Promise<ACPSessionRecord>;
  inspect(slot?: string): Promise<ACPState>;
  stopSession(slot: string): Promise<void>;
}
