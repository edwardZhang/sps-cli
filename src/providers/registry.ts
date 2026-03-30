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

export function createTaskBackend(config: ProjectConfig): TaskBackend {
  switch (config.PM_TOOL) {
    case 'plane': return new PlaneTaskBackend(config);
    case 'trello': return new TrelloTaskBackend(config);
    case 'markdown': return new MarkdownTaskBackend(config);
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
