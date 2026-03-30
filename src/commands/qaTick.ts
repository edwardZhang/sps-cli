import { ProjectContext } from '../core/context.js';
import { workflowUsesAgentRuntime } from '../core/config.js';
import { CloseoutEngine } from '../engines/CloseoutEngine.js';
import { createTaskBackend, createRepoBackend, createNotifier, createAgentRuntime } from '../providers/registry.js';
import { ProcessSupervisor } from '../manager/supervisor.js';
import { CompletionJudge } from '../manager/completion-judge.js';
import { ResourceLimiter } from '../manager/resource-limiter.js';
import { WorkerManagerImpl } from '../manager/worker-manager-impl.js';
import { SPSEventHandler } from '../engines/EventHandler.js';
import { RuntimeStore } from '../core/runtimeStore.js';
import { Logger } from '../core/logger.js';

export async function executeQaTick(
  project: string,
  flags: Record<string, boolean>,
): Promise<void> {
  const log = new Logger('qa', project);
  const jsonOutput = !!flags.json;

  let ctx: ProjectContext;
  try {
    ctx = ProjectContext.load(project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonOutput) {
      console.log(JSON.stringify({ project, component: 'qa', status: 'fail', exitCode: 3, error: msg }));
    } else {
      log.error(`Fatal: ${msg}`);
    }
    process.exit(3);
  }

  const taskBackend = createTaskBackend(ctx.config);
  const repoBackend = createRepoBackend(ctx.config);
  const notifier = createNotifier(ctx.config);
  const agentRuntime = workflowUsesAgentRuntime(ctx.config) ? createAgentRuntime(ctx) : null;

  // Build WorkerManager for standalone QA tick
  const supervisor = new ProcessSupervisor();
  const maxWorkers = parseInt(process.env.SPS_MANAGER_MAX_WORKERS || '30', 10);
  const resourceLimiter = new ResourceLimiter({
    maxGlobalWorkers: maxWorkers,
    staggerDelayMs: parseInt(process.env.SPS_MANAGER_STAGGER_MS || '5000', 10),
    maxMemoryPercent: parseInt(process.env.SPS_MANAGER_MAX_MEMORY_PERCENT || '90', 10),
  });
  const completionJudge = new CompletionJudge();
  const workerManager = new WorkerManagerImpl({
    supervisor, completionJudge, resourceLimiter,
    agentRuntime: agentRuntime ?? null,
    stateFile: ctx.paths.stateFile,
    maxWorkers: ctx.maxWorkers,
  });
  const runtimeStore = new RuntimeStore({ paths: { stateFile: ctx.paths.stateFile }, maxWorkers: ctx.maxWorkers });
  const raw = ctx.config.raw;
  const eventHandler = new SPSEventHandler({
    taskBackend, notifier, runtimeStore, project,
  });
  workerManager.onEvent((event) => eventHandler.handle(event));

  const engine = new CloseoutEngine(ctx, taskBackend, repoBackend, workerManager, notifier);
  const result = await engine.tick();

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const fullLog = new Logger('qa', project, ctx.paths.logsDir);
    for (const action of result.actions) {
      const icon = action.result === 'ok' ? '✓' : action.result === 'skip' ? '·' : '✗';
      fullLog.info(`${icon} ${action.entity}: ${action.message || action.result}`);
    }
    if (result.actions.length === 0) {
      fullLog.info('No QA cards to process');
    }
  }

  process.exit(result.exitCode);
}
