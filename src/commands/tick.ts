/**
 * @module        tick
 * @description   主 tick 循环命令，协调调度、流水线、QA 和监控引擎的周期性执行
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
 * @trigger       sps tick <project> [--interval N] [--once] [--json]
 * @inputs        项目名、执行间隔、单次/循环模式、JSON 输出标志
 * @outputs       每轮 tick 的调度/流水线/QA/监控结果
 * @workflow      1. 获取锁 → 2. 加载引擎 → 3. 循环执行 scheduler→pipeline→QA→monitor → 4. 释放锁
 */
import { ProjectContext } from '../core/context.js';
import { acquireTickLock, releaseTickLock } from '../core/lock.js';
import { Logger } from '../core/logger.js';
import { ProjectPipelineAdapter } from '../core/projectPipelineAdapter.js';
import { RuntimeStore } from '../core/runtimeStore.js';
import { cleanupOrphanAcpSessions } from '../core/sessionCleanup.js';
import { readState } from '../core/state.js';
import { SPSEventHandler } from '../engines/EventHandler.js';
import { MonitorEngine } from '../engines/MonitorEngine.js';
import { SchedulerEngine } from '../engines/SchedulerEngine.js';
import { StageEngine } from '../engines/StageEngine.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import { CompletionJudge } from '../manager/completion-judge.js';
import { RuntimeCoordinator } from '../manager/runtime-coordinator.js';
import { ProcessSupervisor } from '../manager/supervisor.js';
// PostActions and Recovery are no longer used directly — WM handles recovery
// and SPSEventHandler handles PM operations via the event system.
import { WorkerManagerImpl } from '../manager/worker-manager-impl.js';
import type { CommandResult, StepResult, TickResult } from '../models/types.js';
import { createAgentRuntime, createNotifier, createRepoBackend, createTaskBackend } from '../providers/registry.js';

const DEFAULT_INTERVAL_S = 30;

// ─── Shared Manager modules (global across all projects) ──────

let sharedSupervisor: ProcessSupervisor | null = null;
let sharedCompletionJudge: CompletionJudge | null = null;

function getSharedModules() {
  if (!sharedSupervisor) {
    sharedSupervisor = new ProcessSupervisor();
  }
  if (!sharedCompletionJudge) {
    sharedCompletionJudge = new CompletionJudge();
  }
  return {
    supervisor: sharedSupervisor,
    completionJudge: sharedCompletionJudge,
  };
}

// ─── Per-project isolated runner ─────────────────────────────────

interface ProjectRunner {
  project: string;
  ctx: ProjectContext;
  pipelineAdapter: ProjectPipelineAdapter;
  log: Logger;
  taskBackend: TaskBackend;
  notifier: Notifier;
  agentRuntime: ReturnType<typeof createAgentRuntime> | null;
  workerManager: import('../manager/worker-manager-impl.js').WorkerManagerImpl;
  scheduler: SchedulerEngine;
  stages: StageEngine[];
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

  // Rotate logs — each tick session gets a clean log file
  fullLog.rotateLogs();

  // Pipeline adapter: reads YAML config or returns defaults (created early to inform provider states)
  const pipelineAdapter = new ProjectPipelineAdapter(ctx.config, ctx.paths.repoDir);

  // Collect all unique state names for PM backend
  const allStateNames = [
    ...new Set([
      pipelineAdapter.states.planning,
      pipelineAdapter.states.backlog,
      pipelineAdapter.states.ready,
      pipelineAdapter.states.done,
      ...pipelineAdapter.stages.map(s => s.triggerState),
      ...pipelineAdapter.stages.map(s => s.activeState),
      ...pipelineAdapter.stages.map(s => s.onCompleteState),
    ].filter(Boolean)),
  ];

  // Create providers
  let taskBackend, repoBackend, notifier;
  let agentRuntime: ReturnType<typeof createAgentRuntime> | null = null;
  try {
    taskBackend = createTaskBackend(ctx.config, allStateNames);
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
  const { supervisor, completionJudge } = getSharedModules();

  // Create per-project WorkerManager (wraps supervisor + judge)
  const workerManager = new WorkerManagerImpl({
    supervisor,
    completionJudge,
    agentRuntime: agentRuntime ?? null,
    stateFile: ctx.paths.stateFile,
    maxWorkers: ctx.maxWorkers,
  });

  // Register SPSEventHandler for PM operations on worker lifecycle events
  const runtimeStore = new RuntimeStore({
    paths: { stateFile: ctx.paths.stateFile },
    maxWorkers: ctx.maxWorkers,
  });
  const _raw = ctx.config.raw;
  const eventHandler = new SPSEventHandler({
    taskBackend,
    notifier,
    runtimeStore,
    project,
    pipelineAdapter,
  });
  workerManager.onEvent((event) => eventHandler.handle(event));

  return {
    project,
    ctx,
    pipelineAdapter,
    log: fullLog,
    taskBackend,
    notifier,
    agentRuntime,
    workerManager,
    scheduler: new SchedulerEngine(ctx, taskBackend, pipelineAdapter, notifier),
    stages: pipelineAdapter.stages.map((stage, i) =>
      new StageEngine(
        ctx, stage, i, pipelineAdapter.stages.length,
        taskBackend, repoBackend, workerManager, pipelineAdapter, notifier,
      ),
    ),
    monitor: new MonitorEngine(ctx, taskBackend, repoBackend, notifier, supervisor, pipelineAdapter, workerManager),
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
 * Manager modules (Supervisor, CompletionJudge) are shared globally.
 * Projects are ticked sequentially within each cycle. One project's error
 * does not affect others.
 *
 */
export async function executeTick(
  projects: string[],
  flags: Record<string, boolean>,
): Promise<void> {
  const globalLog = new Logger('tick', '');
  const jsonOutput = !!flags.json;
  const dryRun = !!flags['dry-run'];
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

  const { supervisor } = getSharedModules();

  // ─── Orphan cleanup: kill leftover ACP shims from prior crashed runs ──
  // Must run BEFORE recovery so the new tick never tries to reattach to a
  // dead/orphan shim. Safe for harness mode — only touches worker-* slots.
  for (const runner of runners) {
    try {
      const result = await cleanupOrphanAcpSessions(runner.ctx, runner.log);
      if (result.killed > 0 || result.cleaned > 0) {
        runner.log.info(
          `Orphan cleanup: killed ${result.killed} process(es), cleared ${result.cleaned} stale session record(s)`,
        );
      }
    } catch (err) {
      runner.log.warn(`Orphan cleanup failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Recovery: restore active workers via WorkerManager ────────
  for (const runner of runners) {
    try {
      const wmResult = await runner.workerManager.recover([{
        project: runner.project,
        stateFile: runner.ctx.paths.stateFile,
        baseBranch: runner.ctx.config.GITLAB_MERGE_BRANCH,
      }]);
      if (wmResult.scanned > 0) {
        globalLog.info(
          `Recovery (${runner.project}): scanned=${wmResult.scanned} alive=${wmResult.alive} ` +
          `completed=${wmResult.completed} failed=${wmResult.failed} ` +
          `released=${wmResult.released} queueRebuilt=${wmResult.queueRebuilt}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runner.log.warn(`Recovery failed (non-fatal): ${msg}`);
    }
  }

  // Cleanup all locks on exit
  const cleanupAll = () => {
    for (const runner of runners) {
      releaseTickLock(runner.ctx.paths.tickLockFile);
      runner.workerManager.cleanup();
    }
  };
  process.on('exit', cleanupAll);

  // Wait for pending PM operations before exiting on signal
  const gracefulExit = async (code: number) => {
    cleanupAll();
    try {
      await supervisor.drainPendingActions();
    } catch { /* best effort */ }
    process.exit(code);
  };
  process.on('SIGINT', () => { gracefulExit(130); });
  process.on('SIGTERM', () => { gracefulExit(143); });

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

      const allDone = await checkAllDone(runner.ctx, runner.taskBackend, runner.pipelineAdapter);
      if (allDone) {
        runner.log.ok('All cards done, no active workers — project complete.');
        await runner.notifier.send(`🎉 [${runner.project}] Pipeline complete — all cards done.`).catch(() => {});
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

    // Drain any pending supervisor exit callbacks before sleeping
    await supervisor.drainPendingActions();

    await sleep(interval * 1000);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────

async function runOneTick(
  runner: ProjectRunner,
  dryRun: boolean,
): Promise<TickResult> {
  const { project, scheduler, stages, monitor, log, pipelineAdapter, ctx } = runner;

  // Hot-reload project conf at the start of each tick cycle
  // so changes to branch, worker settings, etc. take effect without restart
  try {
    runner.ctx.reload();
  } catch (err) {
    log.warn(`conf reload failed (using cached): ${err instanceof Error ? err.message : err}`);
  }

  const steps: StepResult[] = [];
  const opts = { dryRun };

  // ── Failure halt: check for NEEDS-FIX cards before doing anything ──
  // If any card has NEEDS-FIX, the pipeline is halted until resolved.
  // TODO: This halts globally. Should only halt if the failed card's stage has halt: true.
  {
    const needsFixCards: string[] = [];
    for (const cardState of pipelineAdapter.activeStates) {
      try {
        const cards = await runner.taskBackend.listByState(cardState as any);
        for (const card of cards) {
          if (card.labels.includes('NEEDS-FIX')) {
            needsFixCards.push(`seq:${card.seq} (${card.name})`);
          }
        }
      } catch { /* ignore */ }
    }
    if (needsFixCards.length > 0) {
      log.warn(`Pipeline halted: ${needsFixCards.length} card(s) with NEEDS-FIX: ${needsFixCards.join(', ')}`);
      log.info('Remove NEEDS-FIX label to resume. Or use: sps reset <project> <seq>');
      return {
        project,
        component: 'tick',
        status: 'halted' as any,
        exitCode: 0,
        steps: [],
        actions: [],
        recommendedActions: [],
        details: { halted: true, needsFixCards },
      };
    }
  }

  // ── Recovery: reset orphaned Inprogress cards on tick startup ──
  // If a card is in a stage active state but no worker is running,
  // it was interrupted. Move it back to the ready state for re-processing.
  {
    const state = readState(ctx.paths.stateFile, ctx.maxWorkers);
    const hasActiveWorker = Object.values(state.workers).some(w => w.status !== 'idle');
    if (!hasActiveWorker) {
      for (const stage of pipelineAdapter.stages) {
        try {
          const stuckCards = await runner.taskBackend.listByState(stage.activeState as any);
          for (const card of stuckCards) {
            if (!card.labels.includes('NEEDS-FIX')) {
              log.info(`Recovery: seq:${card.seq} stuck in ${stage.activeState}, moving back to ${pipelineAdapter.states.ready}`);
              await runner.taskBackend.move(card.seq, pipelineAdapter.states.ready);
            }
          }
        } catch { /* ignore */ }
      }
    }
  }

  const schedulerResult = await runStep('scheduler', () => scheduler.tick(opts), log);
  steps.push(schedulerResult);

  // Execute stage engines sequentially (single worker, no need for reverse order)
  for (const stage of stages) {
    const stageResult = await runStep(`stage-${stage.name}`, () => stage.tick(opts), log);
    if (stage.isFirstStage && schedulerResult.status === 'fail') {
      stageResult.status = stageResult.status === 'ok' ? 'degraded' : stageResult.status;
      stageResult.note = 'scheduler failed — no new cards launched';
    }
    steps.push(stageResult);
  }

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
  pipelineAdapter: ProjectPipelineAdapter,
): Promise<boolean> {
  const pipelineLabel = ctx.config.PIPELINE_LABEL || 'AI-PIPELINE';
  const state = readState(ctx.paths.stateFile, ctx.maxWorkers);
  if (Object.values(state.workers).some((w) => w.status !== 'idle')) return false;

  for (const cardState of pipelineAdapter.activeStates) {
    try {
      const cards = await taskBackend.listByState(cardState as any);
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
