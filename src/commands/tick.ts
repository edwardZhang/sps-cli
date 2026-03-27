import { ProjectContext } from '../core/context.js';
import { acquireTickLock, releaseTickLock } from '../core/lock.js';
import { readState } from '../core/state.js';
import { Logger } from '../core/logger.js';
import { SchedulerEngine } from '../engines/SchedulerEngine.js';
import { ExecutionEngine } from '../engines/ExecutionEngine.js';
import { CloseoutEngine } from '../engines/CloseoutEngine.js';
import { MonitorEngine } from '../engines/MonitorEngine.js';
import { createTaskBackend, createWorkerProvider, createRepoBackend, createNotifier, createAgentRuntime } from '../providers/registry.js';
import { ProcessSupervisor } from '../manager/supervisor.js';
import { CompletionJudge } from '../manager/completion-judge.js';
import { PostActions } from '../manager/post-actions.js';
import { MergeMutex } from '../manager/merge-mutex.js';
import { ResourceLimiter } from '../manager/resource-limiter.js';
import { Recovery } from '../manager/recovery.js';
import { createPMClient } from '../manager/pm-client.js';
import { RuntimeCoordinator } from '../manager/runtime-coordinator.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { TickResult, StepResult, CommandResult } from '../models/types.js';

const DEFAULT_INTERVAL_S = 30;

// ─── Shared Manager modules (global across all projects) ──────

let sharedSupervisor: ProcessSupervisor | null = null;
let sharedResourceLimiter: ResourceLimiter | null = null;
let sharedCompletionJudge: CompletionJudge | null = null;

function getSharedModules() {
  if (!sharedSupervisor) {
    sharedSupervisor = new ProcessSupervisor();
  }
  if (!sharedResourceLimiter) {
    const maxWorkers = parseInt(process.env.SPS_MANAGER_MAX_WORKERS || '30', 10);
    const staggerMs = parseInt(process.env.SPS_MANAGER_STAGGER_MS || '5000', 10);
    const maxMem = parseInt(process.env.SPS_MANAGER_MAX_MEMORY_PERCENT || '80', 10);
    sharedResourceLimiter = new ResourceLimiter({
      maxGlobalWorkers: maxWorkers,
      staggerDelayMs: staggerMs,
      maxMemoryPercent: maxMem,
    });
  }
  if (!sharedCompletionJudge) {
    sharedCompletionJudge = new CompletionJudge();
  }
  return {
    supervisor: sharedSupervisor,
    resourceLimiter: sharedResourceLimiter,
    completionJudge: sharedCompletionJudge,
  };
}

// ─── Per-project isolated runner ─────────────────────────────────

interface ProjectRunner {
  project: string;
  ctx: ProjectContext;
  log: Logger;
  taskBackend: TaskBackend;
  notifier: Notifier;
  agentRuntime: ReturnType<typeof createAgentRuntime>;
  scheduler: SchedulerEngine;
  closeout: CloseoutEngine;
  execution: ExecutionEngine;
  monitor: MonitorEngine;
  done: boolean;
  fatalError: boolean;
  tickNum: number;
  idleCount: number;
}

function createRunner(project: string): ProjectRunner | null {
  const log = new Logger('tick', project);

  let ctx: ProjectContext;
  try {
    ctx = ProjectContext.load(project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Fatal: cannot load project ${project}: ${msg}`);
    return null;
  }

  const fullLog = new Logger('tick', project, ctx.paths.logsDir);

  // Acquire lock
  const lockResult = acquireTickLock(ctx.paths.tickLockFile, ctx.config.TICK_LOCK_TIMEOUT_MINUTES);
  if (!lockResult.acquired) {
    fullLog.info('Another tick is running for this project, skipping');
    return null;
  }

  // Create providers
  let taskBackend, workerProvider, repoBackend, notifier, agentRuntime;
  try {
    taskBackend = createTaskBackend(ctx.config);
    workerProvider = createWorkerProvider(ctx.config);
    repoBackend = createRepoBackend(ctx.config);
    notifier = createNotifier(ctx.config);
    agentRuntime = createAgentRuntime(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fullLog.error(`Fatal: provider init failed for ${project}: ${msg}`);
    releaseTickLock(ctx.paths.tickLockFile);
    return null;
  }

  // Get shared Manager modules
  const { supervisor, resourceLimiter, completionJudge } = getSharedModules();

  // Create per-project Manager modules
  const pmClient = createPMClient(ctx.config);
  const mergeMutex = new MergeMutex();
  const postActions = new PostActions(pmClient, supervisor, resourceLimiter, notifier, mergeMutex, agentRuntime);

  return {
    project,
    ctx,
    log: fullLog,
    taskBackend,
    notifier,
    agentRuntime,
    scheduler: new SchedulerEngine(ctx, taskBackend, notifier),
    closeout: new CloseoutEngine(ctx, taskBackend, repoBackend, workerProvider, notifier, agentRuntime),
    execution: new ExecutionEngine(
      ctx, taskBackend, repoBackend,
      supervisor, completionJudge, postActions, resourceLimiter,
      notifier, agentRuntime,
    ),
    monitor: new MonitorEngine(ctx, taskBackend, workerProvider, repoBackend, notifier, supervisor),
    done: false,
    fatalError: false,
    tickNum: 0,
    idleCount: 0,
  };
}

// ─── Entry point ─────────────────────────────────────────────────

/**
 * Execute the unified tick command.
 *
 * Supports multiple projects in a single process:
 *   sps tick project-a project-b project-c
 *
 * Each project is fully isolated (own context, providers, engines, lock, state).
 * Manager modules (Supervisor, ResourceLimiter, CompletionJudge) are shared globally.
 * Projects are ticked sequentially within each cycle. One project's error
 * does not affect others.
 *
 * --once: single tick cycle, then exit.
 */
export async function executeTick(
  projects: string[],
  flags: Record<string, boolean>,
): Promise<void> {
  const globalLog = new Logger('tick', '');
  const jsonOutput = !!flags.json;
  const dryRun = !!flags['dry-run'];
  const once = !!flags.once;
  const interval = DEFAULT_INTERVAL_S;

  if (projects.length === 0) {
    console.error('Usage: sps tick <project> [project2] [project3] ...');
    process.exit(2);
  }

  // ─── Initialize runners ────────────────────────────────────────
  const runners: ProjectRunner[] = [];
  for (const project of projects) {
    const runner = createRunner(project);
    if (runner) {
      runners.push(runner);
    }
  }

  if (runners.length === 0) {
    globalLog.error('No projects could be initialized');
    process.exit(3);
  }

  // ─── Rebuild runtime projection before recovery ───────────────
  for (const runner of runners) {
    try {
      const coordinator = new RuntimeCoordinator(runner.ctx, runner.taskBackend);
      const rebuilt = await coordinator.rebuildRuntimeProjection('tick-rebuild');
      if (rebuilt.updated) {
        runner.log.info('Rebuilt runtime projection from PM + worktree + session evidence');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runner.log.warn(`Runtime projection rebuild failed (non-fatal): ${msg}`);
    }
  }

  if (runners.length > 1) {
    globalLog.info(`Managing ${runners.length} projects: ${runners.map((r) => r.project).join(', ')}`);
  }

  // ─── Recovery: restore active workers from previous tick ───────
  const { supervisor, completionJudge, resourceLimiter } = getSharedModules();
  try {
    const projectInfos = runners.map(r => ({
      name: r.project,
      config: r.ctx.config,
      stateFile: r.ctx.paths.stateFile,
      logsDir: r.ctx.paths.logsDir,
    }));
    // Per-project PostActions factory (each project uses its own PM config)
    const runnerMap = new Map(runners.map(r => [r.project, r]));
    const mergeMutexMap = new Map(runners.map(r => [r.project, new MergeMutex()]));
    const postActionsFactory = (config: import('../core/config.js').ProjectConfig) => {
      const pmClient = createPMClient(config);
      const runner = runnerMap.get(config.PROJECT_NAME);
      const mm = mergeMutexMap.get(config.PROJECT_NAME) || new MergeMutex();
      return new PostActions(pmClient, supervisor, resourceLimiter, runner?.notifier || null, mm, runner?.agentRuntime || null);
    };
    const recovery = new Recovery(supervisor, completionJudge, postActionsFactory, resourceLimiter);
    const result = await recovery.recover(projectInfos);
    if (result.found > 0) {
      globalLog.info(
        `Recovery: ${result.found} workers found, ${result.alive} alive, ` +
        `${result.completed} completed, ${result.failed} failed`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    globalLog.warn(`Recovery failed (non-fatal): ${msg}`);
  }

  // Cleanup all locks on exit
  const cleanupAll = () => {
    for (const runner of runners) {
      releaseTickLock(runner.ctx.paths.tickLockFile);
    }
  };
  process.on('exit', cleanupAll);
  process.on('SIGINT', () => { cleanupAll(); process.exit(130); });
  process.on('SIGTERM', () => { cleanupAll(); process.exit(143); });

  // ─── Single tick mode ──────────────────────────────────────────
  if (once) {
    const results: TickResult[] = [];
    for (const runner of runners) {
      const result = await runOneTick(runner, dryRun);
      results.push(result);
    }
    // Wait for any exit callbacks / PostActions to complete
    await supervisor.drainPendingActions();
    if (jsonOutput) {
      outputJson(runners.length === 1 ? results[0] : results);
    }
    cleanupAll();
    const worstExit = Math.max(...results.map((r) => r.exitCode));
    process.exit(worstExit);
  }

  // ─── Continuous mode ───────────────────────────────────────────
  for (const runner of runners) {
    runner.log.info(`Starting continuous tick (interval=${interval}s)`);
  }

  while (true) {
    for (const runner of runners) {
      if (runner.done || runner.fatalError) continue;

      runner.tickNum++;
      const result = await runOneTick(runner, dryRun);

      if (jsonOutput) {
        outputJson(result);
      } else {
        const actionsCount = result.steps.reduce(
          (sum, s) => sum + (s.actions?.filter((a) => a.result === 'ok').length || 0), 0);
        if (actionsCount > 0) {
          const summary = result.steps
            .flatMap((s) => (s.actions || []).filter((a) => a.result === 'ok'))
            .map((a) => `${a.entity}:${a.message}`)
            .join(', ');
          runner.log.info(`[tick #${runner.tickNum}] ${actionsCount} action(s): ${summary}`);
          runner.idleCount = 0;
        } else {
          runner.idleCount++;
          if (runner.idleCount === 1 || runner.idleCount % 10 === 0) {
            runner.log.debug(`[tick #${runner.tickNum}] idle (${runner.idleCount})`);
          }
        }
      }

      const allDone = await checkAllDone(runner.ctx, runner.taskBackend);
      if (allDone) {
        runner.log.ok('All cards done, no active workers — project complete.');
        await runner.notifier.sendSuccess(`[${runner.project}] Pipeline complete — all cards done.`).catch(() => {});
        releaseTickLock(runner.ctx.paths.tickLockFile);
        runner.done = true;
      }

      if (result.exitCode === 3) {
        runner.log.error('Fatal error, stopping tick for this project');
        releaseTickLock(runner.ctx.paths.tickLockFile);
        runner.fatalError = true;
      }
    }

    const allFinished = runners.every((r) => r.done || r.fatalError);
    if (allFinished) {
      const doneCount = runners.filter((r) => r.done).length;
      const errorCount = runners.filter((r) => r.fatalError).length;
      if (runners.length > 1) {
        globalLog.ok(`All projects finished (${doneCount} done, ${errorCount} errors)`);
      }
      cleanupAll();
      process.exit(errorCount > 0 ? 1 : 0);
    }

    // Drain any pending PostActions before sleeping
    await supervisor.drainPendingActions();

    await sleep(interval * 1000);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

async function runOneTick(
  runner: ProjectRunner,
  dryRun: boolean,
): Promise<TickResult> {
  const { project, scheduler, closeout, execution, monitor, log } = runner;

  // Hot-reload project conf at the start of each tick cycle
  // so changes to branch, worker settings, etc. take effect without restart
  try {
    runner.ctx.reload();
  } catch (err) {
    log.warn(`conf reload failed (using cached): ${err instanceof Error ? err.message : err}`);
  }

  const steps: StepResult[] = [];
  const opts = { dryRun };

  const schedulerResult = await runStep('scheduler', () => scheduler.tick(opts), log);
  steps.push(schedulerResult);

  const qaResult = await runStep('qa', () => closeout.tick(), log);
  steps.push(qaResult);

  let pipelineResult = await runStep('pipeline', () => execution.tick(opts), log);
  if (schedulerResult.status === 'fail') {
    pipelineResult.status = pipelineResult.status === 'ok' ? 'degraded' : pipelineResult.status;
    pipelineResult.note = 'scheduler failed — no new cards launched';
  }
  steps.push(pipelineResult);

  const monitorResult = await runStep('monitor', () => monitor.tick(), log);
  steps.push(monitorResult);

  const hasFatal = steps.some((s) => s.exitCode === 3);
  const hasFail = steps.some((s) => s.status === 'fail' || s.status === 'degraded');

  return {
    project,
    component: 'tick',
    status: hasFatal ? 'fail' : hasFail ? 'degraded' : 'ok',
    exitCode: hasFatal ? 3 : hasFail ? 1 : 0,
    steps,
    actions: [],
    recommendedActions: [],
    details: {},
  };
}

async function checkAllDone(
  ctx: ProjectContext,
  taskBackend: TaskBackend,
): Promise<boolean> {
  const pipelineLabel = ctx.config.PIPELINE_LABEL || 'AI-PIPELINE';
  const state = readState(ctx.paths.stateFile, ctx.maxWorkers);
  if (Object.values(state.workers).some((w) => w.status !== 'idle')) return false;

  for (const cardState of ['Planning', 'Backlog', 'Todo', 'Inprogress', 'QA'] as const) {
    try {
      const cards = await taskBackend.listByState(cardState);
      if (cards.some((c) => c.labels.includes(pipelineLabel))) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function runStep(
  name: string,
  fn: () => Promise<CommandResult>,
  log: Logger,
): Promise<StepResult> {
  try {
    const result = await fn();
    return {
      step: name,
      status: result.status,
      exitCode: result.exitCode,
      actions: result.actions,
      error: result.status === 'fail' ? JSON.stringify(result.details) : undefined,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`${name} threw: ${msg}`);
    return { step: name, status: 'fail', exitCode: 1, error: msg };
  }
}

function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
