import type { ProjectConfig } from '../core/config.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { WorkerProvider } from '../interfaces/WorkerProvider.js';
import type { RepoBackend } from '../interfaces/RepoBackend.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';
import { PlaneTaskBackend } from './PlaneTaskBackend.js';
import { TrelloTaskBackend } from './TrelloTaskBackend.js';
import { MarkdownTaskBackend } from './MarkdownTaskBackend.js';
import { ClaudePrintProvider } from './ClaudePrintProvider.js';
import { CodexExecProvider } from './CodexExecProvider.js';
import { ClaudeTmuxProvider } from './ClaudeTmuxProvider.js';
import { CodexTmuxProvider } from './CodexTmuxProvider.js';
import { GitLabRepoBackend } from './GitLabRepoBackend.js';
import { MatrixNotifier } from './MatrixNotifier.js';
import { ProjectContext } from '../core/context.js';
import { ACPWorkerRuntime } from './ACPWorkerRuntime.js';
import { PTYAgentRuntime } from './PTYAgentRuntime.js';

export function createTaskBackend(config: ProjectConfig): TaskBackend {
  switch (config.PM_TOOL) {
    case 'plane': return new PlaneTaskBackend(config);
    case 'trello': return new TrelloTaskBackend(config);
    case 'markdown': return new MarkdownTaskBackend(config);
    default: throw new Error(`Unknown PM_TOOL: ${config.PM_TOOL}`);
  }
}

export function createWorkerProvider(config: ProjectConfig): WorkerProvider {
  const mode = config.WORKER_MODE || 'print';
  const tool = config.WORKER_TOOL || 'claude';

  if (mode === 'print') {
    switch (tool) {
      case 'claude': return new ClaudePrintProvider(config);
      case 'codex': return new CodexExecProvider(config);
      default: throw new Error(`Unknown WORKER_TOOL: ${tool}`);
    }
  }

  // Interactive (tmux) mode — legacy fallback
  switch (tool) {
    case 'claude': return new ClaudeTmuxProvider(config);
    case 'codex': return new CodexTmuxProvider(config);
    default: throw new Error(`Unknown WORKER_TOOL: ${tool}`);
  }
}

export function createRepoBackend(config: ProjectConfig): RepoBackend {
  return new GitLabRepoBackend(config);
}

export function createNotifier(config: ProjectConfig): Notifier {
  return new MatrixNotifier(config);
}

export function createAgentRuntime(ctx: ProjectContext): AgentRuntime {
  const transport = ctx.config.raw.WORKER_TRANSPORT || 'acp';
  if (transport === 'pty') {
    return new PTYAgentRuntime(ctx);
  }
  return new ACPWorkerRuntime(ctx);
}
