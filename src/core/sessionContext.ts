/**
 * SessionContext — lightweight runtime context for harness mode (sps agent).
 *
 * Unlike ProjectContext, does not require ~/.coral/projects/<name>/conf.
 * State stored in ~/.coral/sessions/ (separate from pipeline state).
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { resolveSessionPaths, type SessionPaths } from './paths.js';
import type { ACPTool } from '../models/acp.js';

export interface SessionContext {
  projectName: string;
  cwd: string;
  tool: ACPTool;
  maxWorkers: number;
  paths: SessionPaths & { repoDir: string };
  config: {
    ACP_AGENT?: string;
    WORKER_TOOL: string;
    raw: Record<string, string>;
  };
}

export function createSessionContext(opts?: {
  cwd?: string;
  tool?: ACPTool;
}): SessionContext {
  const cwd = opts?.cwd ? resolve(opts.cwd) : process.cwd();
  const tool: ACPTool = opts?.tool ?? (process.env.SPS_AGENT as ACPTool) ?? 'claude';
  const sessionPaths = resolveSessionPaths();

  // Ensure directories exist
  mkdirSync(sessionPaths.stateDir, { recursive: true });
  mkdirSync(sessionPaths.logsDir, { recursive: true });

  return {
    projectName: 'standalone',
    cwd,
    tool,
    maxWorkers: 0,  // no pipeline worker slots in harness mode
    paths: {
      ...sessionPaths,
      repoDir: cwd,
    },
    config: {
      ACP_AGENT: tool,
      WORKER_TOOL: tool,
      raw: { WORKER_TRANSPORT: 'acp-sdk' },
    },
  };
}
