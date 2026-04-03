/**
 * @module        schedulerTick
 * @description   调度引擎单次执行命令，将就绪卡片从 Backlog 推入工作队列
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
 * @trigger       sps scheduler <project> [--json] [--dry-run]
 * @inputs        项目名、JSON 输出标志、dry-run 标志
 * @outputs       调度结果（推入队列的卡片列表）
 * @workflow      1. 加载上下文 → 2. 创建 SchedulerEngine → 3. 执行调度 tick → 4. 输出结果
 */
import { ProjectContext } from '../core/context.js';
import { Logger } from '../core/logger.js';
import { ProjectPipelineAdapter } from '../core/projectPipelineAdapter.js';
import { SchedulerEngine } from '../engines/SchedulerEngine.js';
import { createNotifier, createTaskBackend } from '../providers/registry.js';

export async function executeSchedulerTick(
  project: string,
  flags: Record<string, boolean>,
): Promise<void> {
  const log = new Logger('scheduler', project);
  const jsonOutput = !!flags.json;
  const dryRun = !!flags['dry-run'];

  let ctx: ProjectContext;
  try {
    ctx = ProjectContext.load(project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonOutput) {
      console.log(JSON.stringify({ project, component: 'scheduler', status: 'fail', exitCode: 3, error: msg }));
    } else {
      log.error(`Fatal: ${msg}`);
    }
    process.exit(3);
  }

  const taskBackend = createTaskBackend(ctx.config);
  const notifier = createNotifier(ctx.config);
  const pipelineAdapter = new ProjectPipelineAdapter(ctx.config, ctx.paths.repoDir);
  const engine = new SchedulerEngine(ctx, taskBackend, pipelineAdapter, notifier);
  const result = await engine.tick({ dryRun });

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const fullLog = new Logger('scheduler', project, ctx.paths.logsDir);
    for (const action of result.actions) {
      const icon = action.result === 'ok' ? '✓' : action.result === 'skip' ? '·' : '✗';
      fullLog.info(`${icon} ${action.entity}: ${action.message || action.result}`);
    }
    if (result.actions.length === 0) {
      fullLog.info('No actions taken');
      if (result.details && typeof result.details === 'object' && 'reason' in result.details) {
        fullLog.info(`Reason: ${(result.details as Record<string, unknown>).reason}`);
      }
    }
  }

  process.exit(result.exitCode);
}
