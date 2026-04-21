/**
 * @module        registry
 * @description   Provider 注册中心，根据项目配置创建各后端实例
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-19
 * @updated       2026-04-03
 *
 * @role          provider
 * @layer         provider
 * @boundedContext registry
 */
import type { ProjectConfig } from '../core/config.js';
import type { ProjectContext } from '../core/context.js';
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import { ACPWorkerRuntime } from './ACPWorkerRuntime.js';
import { GitLabRepoBackend } from './GitLabRepoBackend.js';
import { MarkdownTaskBackend } from './MarkdownTaskBackend.js';
import { MatrixNotifier } from './MatrixNotifier.js';

export function createTaskBackend(config: ProjectConfig, customStates?: string[]): TaskBackend {
  // v0.42.0: markdown is the only supported backend. Plane/Trello removed.
  if (config.PM_TOOL && config.PM_TOOL !== 'markdown') {
    throw new Error(
      `PM_TOOL="${config.PM_TOOL}" is no longer supported as of v0.42.0. ` +
      `Only 'markdown' is available. Update your conf to PM_TOOL="markdown".`,
    );
  }
  return new MarkdownTaskBackend(config, customStates);
}

export function createRepoBackend(config: ProjectConfig): RepoBackend {
  return new GitLabRepoBackend(config);
}

export function createNotifier(config: ProjectConfig): Notifier {
  return new MatrixNotifier(config);
}

export function createAgentRuntime(ctx: ProjectContext): AgentRuntime {
  return new ACPWorkerRuntime(ctx);
}

/** Create AgentRuntime for harness mode (sps agent) — no project config required. */
export function createSessionRuntime(sessionCtx: {
  projectName: string;
  paths: { repoDir: string; logsDir: string; stateFile: string; acpStateFile?: string };
  config: { raw: Record<string, string> };
}): AgentRuntime {
  return new ACPWorkerRuntime(sessionCtx as any);
}
