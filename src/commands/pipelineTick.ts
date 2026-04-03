import { ProjectContext } from '../core/context.js';
import {} from '../core/config.js';
import { StageEngine } from '../engines/StageEngine.js';
import { createTaskBackend, createRepoBackend, createNotifier, createAgentRuntime } from '../providers/registry.js';
import { ProcessSupervisor } from '../manager/supervisor.js';
import { CompletionJudge } from '../manager/completion-judge.js';
import { ResourceLimiter } from '../manager/resource-limiter.js';
import { WorkerManagerImpl } from '../manager/worker-manager-impl.js';
import { SPSEventHandler } from '../engines/EventHandler.js';
import { RuntimeStore } from '../core/runtimeStore.js';
import { ProjectPipelineAdapter } from '../core/projectPipelineAdapter.js';
import { Logger } from '../core/logger.js';

export async function executePipelineTick(
  project: string,
  flags: Record<string, boolean>,
): Promise<void> {
  const log = new Logger('pipeline', project);
  const jsonOutput = !!flags.json;
  const dryRun = !!flags['dry-run'];

  let ctx: ProjectContext;
  try {
    ctx = ProjectContext.load(project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonOutput) {
      console.log(JSON.stringify({ project, component: 'pipeline', status: 'fail', exitCode: 3, error: msg }));
    } else {
      log.error(`Fatal: ${msg}`);
    }
    process.exit(3);
  }

  const pipelineAdapter = new ProjectPipelineAdapter(ctx.config, ctx.paths.repoDir);
  const allStateNames = [...new Set([
    pipelineAdapter.states.planning, pipelineAdapter.states.backlog,
    pipelineAdapter.states.ready, pipelineAdapter.states.done,
    ...pipelineAdapter.stages.flatMap(s => [s.triggerState, s.activeState, s.onCompleteState]),
  ].filter(Boolean))];
  const taskBackend = createTaskBackend(ctx.config, allStateNames);
  const repoBackend = createRepoBackend(ctx.config);
  const notifier = createNotifier(ctx.config);
  const supervisor = new ProcessSupervisor();
  const completionJudge = new CompletionJudge();
  const resourceLimiter = new ResourceLimiter({
    maxGlobalWorkers: parseInt(process.env.SPS_MANAGER_MAX_WORKERS || '30', 10),
    staggerDelayMs: parseInt(process.env.SPS_MANAGER_STAGGER_MS || '5000', 10),
    maxMemoryPercent: parseInt(process.env.SPS_MANAGER_MAX_MEMORY_PERCENT || '90', 10),
  });
  const agentRuntime = createAgentRuntime(ctx);
  const workerManager = new WorkerManagerImpl({
    supervisor, completionJudge, resourceLimiter,
    agentRuntime: agentRuntime ?? null,
    stateFile: ctx.paths.stateFile, maxWorkers: ctx.maxWorkers,
  });
  const runtimeStore = new RuntimeStore({ paths: { stateFile: ctx.paths.stateFile }, maxWorkers: ctx.maxWorkers });
  const raw = ctx.config.raw;
  const eventHandler = new SPSEventHandler({
    taskBackend, notifier, runtimeStore, project, pipelineAdapter,
  });
  workerManager.onEvent((event) => eventHandler.handle(event));
  // Run first stage (handles prepare + launch — equivalent to old ExecutionEngine)
  const firstStage = pipelineAdapter.stages[0];
  const engine = new StageEngine(ctx, firstStage, 0, pipelineAdapter.stages.length, taskBackend, repoBackend, workerManager, pipelineAdapter, notifier);
  const result = await engine.tick({ dryRun });

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const fullLog = new Logger('pipeline', project, ctx.paths.logsDir);
    for (const action of result.actions) {
      const icon = action.result === 'ok' ? '✓' : action.result === 'skip' ? '·' : '✗';
      fullLog.info(`${icon} ${action.entity}: ${action.message || action.result}`);
    }
    if (result.actions.length === 0) {
      fullLog.info('No cards to process');
    }
  }

  process.exit(result.exitCode);
}
