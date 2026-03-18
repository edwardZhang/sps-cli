import type { ProjectConfig } from '../core/config.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { WorkerProvider } from '../interfaces/WorkerProvider.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { Notifier } from '../interfaces/Notifier.js';
import { PlaneTaskBackend } from './PlaneTaskBackend.js';
import { TrelloTaskBackend } from './TrelloTaskBackend.js';
import { MarkdownTaskBackend } from './MarkdownTaskBackend.js';
import { ClaudeWorkerProvider } from './ClaudeWorkerProvider.js';
import { CodexWorkerProvider } from './CodexWorkerProvider.js';
import { GitLabRepoBackend } from './GitLabRepoBackend.js';
import { MatrixNotifier } from './MatrixNotifier.js';

export function createTaskBackend(config: ProjectConfig): TaskBackend {
  switch (config.PM_TOOL) {
    case 'plane': return new PlaneTaskBackend(config);
    case 'trello': return new TrelloTaskBackend(config);
    case 'markdown': return new MarkdownTaskBackend(config);
    default: throw new Error(`Unknown PM_TOOL: ${config.PM_TOOL}`);
  }
}

export function createWorkerProvider(config: ProjectConfig): WorkerProvider {
  switch (config.WORKER_TOOL) {
    case 'claude': return new ClaudeWorkerProvider(config);
    case 'codex': return new CodexWorkerProvider(config);
    default: throw new Error(`Unknown WORKER_TOOL: ${config.WORKER_TOOL}`);
  }
}

export function createRepoBackend(config: ProjectConfig): RepoBackend {
  return new GitLabRepoBackend(config);
}

export function createNotifier(config: ProjectConfig): Notifier {
  return new MatrixNotifier(config);
}
