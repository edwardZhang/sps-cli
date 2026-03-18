import { ProjectContext } from '../core/context.js';
import { CloseoutEngine } from '../engines/CloseoutEngine.js';
import { createTaskBackend, createWorkerProvider, createRepoBackend, createNotifier } from '../providers/registry.js';
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
  const workerProvider = createWorkerProvider(ctx.config);
  const notifier = createNotifier(ctx.config);
  const engine = new CloseoutEngine(ctx, taskBackend, repoBackend, workerProvider, notifier);
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
