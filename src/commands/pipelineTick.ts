import { ProjectContext } from '../core/context.js';
import { ExecutionEngine } from '../engines/ExecutionEngine.js';
import { createTaskBackend, createRepoBackend, createNotifier, createAgentRuntime } from '../providers/registry.js';
import { ProcessSupervisor } from '../manager/supervisor.js';
import { CompletionJudge } from '../manager/completion-judge.js';
import { PostActions } from '../manager/post-actions.js';
import { ResourceLimiter } from '../manager/resource-limiter.js';
import { createPMClient } from '../manager/pm-client.js';
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

  const taskBackend = createTaskBackend(ctx.config);
  const repoBackend = createRepoBackend(ctx.config);
  const notifier = createNotifier(ctx.config);
  const supervisor = new ProcessSupervisor();
  const completionJudge = new CompletionJudge();
  const resourceLimiter = new ResourceLimiter({
    maxGlobalWorkers: parseInt(process.env.SPS_MANAGER_MAX_WORKERS || '30', 10),
    staggerDelayMs: parseInt(process.env.SPS_MANAGER_STAGGER_MS || '5000', 10),
    maxMemoryPercent: parseInt(process.env.SPS_MANAGER_MAX_MEMORY_PERCENT || '80', 10),
  });
  const pmClient = createPMClient(ctx.config);
  const agentRuntime = createAgentRuntime(ctx);
  const postActions = new PostActions(pmClient, supervisor, resourceLimiter, notifier, agentRuntime);
  const engine = new ExecutionEngine(ctx, taskBackend, repoBackend, supervisor, completionJudge, postActions, resourceLimiter, notifier, agentRuntime);
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
