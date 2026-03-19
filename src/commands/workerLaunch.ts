import { ProjectContext } from '../core/context.js';
import { ExecutionEngine } from '../engines/ExecutionEngine.js';
import { createTaskBackend, createWorkerProvider, createRepoBackend, createNotifier } from '../providers/registry.js';
import { Logger } from '../core/logger.js';

export async function executeWorkerLaunch(
  project: string,
  seq: string,
  flags: Record<string, boolean>,
): Promise<void> {
  const log = new Logger('worker-launch', project);
  const jsonOutput = !!flags.json;
  const dryRun = !!flags['dry-run'];

  if (!seq) {
    if (jsonOutput) {
      console.log(JSON.stringify({ project, component: 'worker-launch', status: 'fail', exitCode: 2, error: 'Missing seq argument' }));
    } else {
      log.error('Usage: sps worker launch <project> <seq>');
    }
    process.exit(2);
  }

  let ctx: ProjectContext;
  try {
    ctx = ProjectContext.load(project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonOutput) {
      console.log(JSON.stringify({ project, component: 'worker-launch', status: 'fail', exitCode: 3, error: msg }));
    } else {
      log.error(`Fatal: ${msg}`);
    }
    process.exit(3);
  }

  const taskBackend = createTaskBackend(ctx.config);
  const workerProvider = createWorkerProvider(ctx.config);
  const repoBackend = createRepoBackend(ctx.config);
  const notifier = createNotifier(ctx.config);
  const engine = new ExecutionEngine(ctx, taskBackend, workerProvider, repoBackend, notifier);
  const result = await engine.launchSingle(seq, { dryRun });

  if (jsonOutput) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const fullLog = new Logger('worker-launch', project, ctx.paths.logsDir);
    for (const action of result.actions) {
      const icon = action.result === 'ok' ? '✓' : action.result === 'skip' ? '·' : '✗';
      fullLog.info(`${icon} ${action.entity}: ${action.message || action.result}`);
    }
    if (result.status === 'ok') {
      fullLog.ok(`Worker launched for seq ${seq}`);
    } else {
      fullLog.error(`Failed: ${JSON.stringify(result.details)}`);
    }
  }

  process.exit(result.exitCode);
}
