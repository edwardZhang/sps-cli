import type { ProjectConfig } from '../core/config.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';
import { PlaneTaskBackend } from './PlaneTaskBackend.js';
import { TrelloTaskBackend } from './TrelloTaskBackend.js';
import { MarkdownTaskBackend } from './MarkdownTaskBackend.js';
import { GitLabRepoBackend } from './GitLabRepoBackend.js';
import { MatrixNotifier } from './MatrixNotifier.js';
import { ProjectContext } from '../core/context.js';
import { ACPWorkerRuntime } from './ACPWorkerRuntime.js';

export function createTaskBackend(config: ProjectConfig, customStates?: string[]): TaskBackend {
  switch (config.PM_TOOL) {
    case 'plane': return new PlaneTaskBackend(config);
    case 'trello': return new TrelloTaskBackend(config);
    case 'markdown': return new MarkdownTaskBackend(config, customStates);
    default: throw new Error(`Unknown PM_TOOL: ${config.PM_TOOL}`);
  }
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
  config: { ACP_AGENT?: string; WORKER_TOOL: string; raw: Record<string, string> };
}): AgentRuntime {
  return new ACPWorkerRuntime(sessionCtx as any);
}
