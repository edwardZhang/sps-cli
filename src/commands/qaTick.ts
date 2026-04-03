/**
 * @module        qaTick
 * @description   QA 引擎单次执行命令，驱动质量检查阶段的任务调度
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
 * @trigger       sps qa <project> [--json] [--dry-run]
 * @inputs        项目名、JSON 输出标志、dry-run 标志
 * @outputs       QA tick 执行结果
 * @workflow      1. 加载上下文 → 2. 创建 StageEngine → 3. 执行 QA tick → 4. 输出结果
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

  const pipelineAdapter = new ProjectPipelineAdapter(ctx.config, ctx.paths.repoDir);
  const allStateNames = [...new Set([
    pipelineAdapter.states.planning, pipelineAdapter.states.backlog,
    pipelineAdapter.states.ready, pipelineAdapter.states.done,
    ...pipelineAdapter.stages.flatMap(s => [s.triggerState, s.activeState, s.onCompleteState]),
  ].filter(Boolean))];
  const taskBackend = createTaskBackend(ctx.config, allStateNames);
  const repoBackend = createRepoBackend(ctx.config);
  const notifier = createNotifier(ctx.config);
  const agentRuntime = createAgentRuntime(ctx);

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
    taskBackend, notifier, runtimeStore, project, pipelineAdapter,
  });
  workerManager.onEvent((event) => eventHandler.handle(event));

  // Run last stage (handles integration/merge — equivalent to old CloseoutEngine)
  const lastIdx = pipelineAdapter.stages.length - 1;
  const lastStage = pipelineAdapter.stages[lastIdx];
  const engine = new StageEngine(ctx, lastStage, lastIdx, pipelineAdapter.stages.length, taskBackend, repoBackend, workerManager, pipelineAdapter, notifier);
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
