import type { ACPState, ACPSessionRecord, ACPTool } from '../models/acp.js';

export interface AgentRuntime {
  ensureSession(slot: string, tool?: ACPTool, cwd?: string): Promise<ACPSessionRecord>;
  startRun(slot: string, prompt: string, tool?: ACPTool, cwd?: string): Promise<ACPSessionRecord>;
  resumeRun(slot: string, prompt: string): Promise<ACPSessionRecord>;
  inspect(slot?: string): Promise<ACPState>;
  stopSession(slot: string): Promise<void>;
}
