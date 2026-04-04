/**
 * @module        pipelineTick
 * @description   Pipeline 引擎单次执行命令，驱动任务分配和 Worker 调度
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-19
 * @updated       2026-04-03
 *
 * @role          command
 * @layer         command
 * @boundedContext pipeline
 *
 * @trigger       sps pipeline <project> [--json] [--dry-run]
 * @inputs        项目名、JSON 输出标志、dry-run 标志
 * @outputs       Pipeline tick 执行结果
 * @workflow      1. 加载上下文 → 2. 创建 StageEngine → 3. 执行 pipeline tick → 4. 输出结果
 */
import {} from '../core/config.js';
import { ProjectContext } from '../core/context.js';
import { Logger } from '../core/logger.js';
import { ProjectPipelineAdapter } from '../core/projectPipelineAdapter.js';
import { RuntimeStore } from '../core/runtimeStore.js';
import { SPSEventHandler } from '../engines/EventHandler.js';
import { StageEngine } from '../engines/StageEngine.js';
import { CompletionJudge } from '../manager/completion-judge.js';
import { ResourceLimiter } from '../manager/resource-limiter.js';
import { ProcessSupervisor } from '../manager/supervisor.js';
import { WorkerManagerImpl } from '../manager/worker-manager-impl.js';
import { createAgentRuntime, createNotifier, createRepoBackend, createTaskBackend } from '../providers/registry.js';

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
    maxMemoryPercent: parseInt(process.env.SPS_MANAGER_MAX_MEMORY_PERCENT || '100', 10),
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
