/**
 * @module        sessionContext
 * @description   轻量级会话上下文，用于 harness 模式
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-31
 * @updated       2026-04-03
 *
 * @role          state
 * @layer         core
 * @boundedContext session
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ACPTool } from '../models/acp.js';
import { resolveSessionPaths, type SessionPaths } from './paths.js';

export interface SessionContext {
  projectName: string;
  cwd: string;
  tool: ACPTool;
  maxWorkers: number;
  paths: SessionPaths & { repoDir: string };
  config: {
    raw: Record<string, string>;
  };
}

export function createSessionContext(opts?: {
  cwd?: string;
}): SessionContext {
  const cwd = opts?.cwd ? resolve(opts.cwd) : process.cwd();
  const sessionPaths = resolveSessionPaths();

  // Ensure directories exist
  mkdirSync(sessionPaths.stateDir, { recursive: true });
  mkdirSync(sessionPaths.logsDir, { recursive: true });

  return {
    projectName: 'standalone',
    cwd,
    tool: 'claude',
    maxWorkers: 0,  // no pipeline worker slots in harness mode
    paths: {
      ...sessionPaths,
      repoDir: cwd,
    },
    config: {
      raw: { WORKER_TRANSPORT: 'acp-sdk' },
    },
  };
}
