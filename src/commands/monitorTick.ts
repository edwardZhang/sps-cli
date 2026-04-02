import { ProjectContext } from '../core/context.js';
import { MonitorEngine } from '../engines/MonitorEngine.js';
import { ProcessSupervisor } from '../manager/supervisor.js';
import { createTaskBackend, createRepoBackend, createNotifier } from '../providers/registry.js';
import { ProjectPipelineAdapter } from '../core/projectPipelineAdapter.js';
import { Logger } from '../core/logger.js';

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
  const engine = new MonitorEngine(ctx, taskBackend, repoBackend, notifier, supervisor, pipelineAdapter);
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
