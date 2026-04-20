/**
 * @module        monitorTick
 * @description   监控引擎单次执行命令，检测异常 Worker 并触发恢复操作
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
 * @trigger       sps monitor <project> [--json]
 * @inputs        项目名、JSON 输出标志
 * @outputs       监控结果（修复动作列表）
 * @workflow      1. 加载项目上下文 → 2. 创建 MonitorEngine → 3. 执行监控 tick → 4. 输出结果
 */
import { ProjectContext } from '../core/context.js';
import { Logger } from '../core/logger.js';
import { ProjectPipelineAdapter } from '../core/projectPipelineAdapter.js';
import { MonitorEngine } from '../engines/MonitorEngine.js';
import { CompletionJudge } from '../manager/completion-judge.js';
import { ProcessSupervisor } from '../manager/supervisor.js';
import { WorkerManagerImpl } from '../manager/worker-manager-impl.js';
import { createNotifier, createRepoBackend, createTaskBackend } from '../providers/registry.js';

export async function executeMonitorTick(
  project: string,
  flags: Record<string, boolean>,
): Promise<void> {
  const log = new Logger('monitor', project);
  const jsonOutput = !!flags.json;

  let ctx: ProjectContext;
  try {
    ctx = ProjectContext.load(project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonOutput) {
      console.log(JSON.stringify({ project, component: 'monitor', status: 'fail', exitCode: 3, error: msg }));
    } else {
      log.error(`Fatal: ${msg}`);
    }
    process.exit(3);
  }

  const taskBackend = createTaskBackend(ctx.config);
  const repoBackend = createRepoBackend(ctx.config);
  const notifier = createNotifier(ctx.config);
  const supervisor = new ProcessSupervisor();
  const pipelineAdapter = new ProjectPipelineAdapter(ctx.config, ctx.paths.repoDir);
  const workerManager = new WorkerManagerImpl({
    supervisor,
    completionJudge: new CompletionJudge(),
    agentRuntime: null,
    stateFile: ctx.paths.stateFile,
    maxWorkers: ctx.maxWorkers,
  });
  const engine = new MonitorEngine(ctx, taskBackend, repoBackend, notifier, supervisor, pipelineAdapter, workerManager);
  const result = await engine.tick();

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const fullLog = new Logger('monitor', project, ctx.paths.logsDir);
    for (const action of result.actions) {
      const icon = action.result === 'ok' ? '✓' : action.result === 'skip' ? '·' : '✗';
      fullLog.info(`${icon} ${action.entity}: ${action.message || action.result}`);
    }
    const checks = (result.details as { checks?: { name: string; status: string; message: string }[] }).checks;
    if (checks) {
      for (const check of checks) {
        const icon = check.status === 'pass' ? '✓' : check.status === 'warn' ? '⚠' : '✗';
        fullLog.info(`${icon} ${check.name}: ${check.message}`);
      }
    }
  }

  process.exit(result.exitCode);
}
