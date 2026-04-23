/**
 * @module        services/executors
 * @description   Service port 的 Production executor 实现（Phase 3）
 *
 * @layer         services
 *
 * 和 defaults.ts 同属"glue layer"——集中 Service 层伸进 Domain 的调用点。
 * 这些 executor 让 Console 和 CLI 两条 Delivery 走同一份业务逻辑：
 *   - WorkerExecutor     → 直接调 StageEngine.launchSingle / WorkerManager.kill
 *   - PipelineExecutor   → 直接调 executeStop / executeReset（绕过 CLI spawn）
 *   - ChatExecutor       → 直接用 DaemonClient
 *   - ProjectInitExecutor→ 直接调 executeProjectInit
 *
 * 这样 Console 路由再也不需要 spawn 子 CLI 进程。
 */
import type { ProcessSpawner } from '../infra/spawn.js';
import type { ChatExecutor } from './ChatService.js';
import type { PipelineExecutor, ResetPipelineOpts } from './PipelineService.js';
import type { ProjectInitExecutor, ProjectInitOpts } from './ProjectService.js';
import type { WorkerExecutor } from './WorkerService.js';

// ─── WorkerExecutor —— 直接调 StageEngine 启卡 / RuntimeStore kill ─────

export class DefaultWorkerExecutor implements WorkerExecutor {
  async launch(project: string, seq: number): Promise<void> {
    const { ProjectContext } = await import('../core/context.js');
    const { ProjectPipelineAdapter } = await import('../core/projectPipelineAdapter.js');
    const { RuntimeStore } = await import('../core/runtimeStore.js');
    const { SPSEventHandler } = await import('../engines/EventHandler.js');
    const { StageEngine } = await import('../engines/StageEngine.js');
    const { CompletionJudge } = await import('../manager/completion-judge.js');
    const { ProcessSupervisor } = await import('../manager/supervisor.js');
    const { WorkerManagerImpl } = await import('../manager/worker-manager-impl.js');
    const { createAgentRuntime, createNotifier, createRepoBackend, createTaskBackend } =
      await import('../providers/registry.js');

    const ctx = ProjectContext.load(project);
    const pipelineAdapter = new ProjectPipelineAdapter(ctx.config, ctx.paths.repoDir);
    const allStateNames = [
      ...new Set(
        [
          pipelineAdapter.states.planning,
          pipelineAdapter.states.backlog,
          pipelineAdapter.states.ready,
          pipelineAdapter.states.done,
          ...pipelineAdapter.stages.flatMap((s) => [s.triggerState, s.activeState, s.onCompleteState]),
        ].filter(Boolean),
      ),
    ];
    const taskBackend = createTaskBackend(ctx.config, allStateNames);
    const repoBackend = createRepoBackend(ctx.config);
    const notifier = createNotifier(ctx.config);
    const supervisor = new ProcessSupervisor();
    const completionJudge = new CompletionJudge();
    const agentRuntime = createAgentRuntime(ctx);
    const workerManager = new WorkerManagerImpl({
      supervisor,
      completionJudge,
      agentRuntime: agentRuntime ?? null,
      stateFile: ctx.paths.stateFile,
      maxWorkers: ctx.maxWorkers,
    });
    const runtimeStore = new RuntimeStore({
      paths: { stateFile: ctx.paths.stateFile },
      maxWorkers: ctx.maxWorkers,
    });
    const eventHandler = new SPSEventHandler({
      taskBackend,
      notifier,
      runtimeStore,
      project,
      pipelineAdapter,
    });
    workerManager.onEvent((event) => eventHandler.handle(event));

    const firstStage = pipelineAdapter.stages[0];
    if (!firstStage) {
      throw new Error(`Project ${project} has no pipeline stages`);
    }
    const engine = new StageEngine(
      ctx,
      firstStage,
      0,
      pipelineAdapter.stages.length,
      taskBackend,
      repoBackend,
      workerManager,
      pipelineAdapter,
      notifier,
    );
    const result = await engine.launchSingle(String(seq), { dryRun: false });
    if (result.status !== 'ok') {
      const detail = typeof result.details === 'object' && result.details
        ? JSON.stringify(result.details)
        : String(result.details ?? 'unknown');
      throw new Error(detail);
    }
  }

  async kill(project: string, slot: number): Promise<void> {
    const { ProjectContext } = await import('../core/context.js');
    const { RuntimeStore } = await import('../core/runtimeStore.js');
    const ctx = ProjectContext.load(project);
    const store = new RuntimeStore({
      paths: { stateFile: ctx.paths.stateFile },
      maxWorkers: ctx.maxWorkers,
    });
    const slotName = `worker-${slot}`;
    const state = store.readState();
    const worker = state.workers[slotName];
    if (worker?.pid && worker.pid > 0) {
      try {
        process.kill(worker.pid, 'SIGTERM');
      } catch {
        /* pid 已死 */
      }
    }
    // 清 slot 状态 —— mutator 重置为 idle
    store.updateState(`console-worker-kill-${slot}`, (s) => {
      const w = s.workers[slotName];
      if (!w) return;
      w.status = 'idle';
      w.seq = null;
      w.branch = null;
      w.worktree = null;
      w.claimedAt = null;
      w.lastHeartbeat = null;
      if ('pid' in w) w.pid = null;
      if ('sessionId' in w) w.sessionId = null;
    });
  }
}

// ─── PipelineExecutor —— 通过 ProcessSpawner 走子进程（避开 process.exit 污染）─────
//
// 细节：executeStop / executeReset 都直接调 process.exit() 做错误退出，不能在 Console
// server 内联调——会把服务器也杀了。用子进程隔离最干净。这是 Delivery 层不允许 spawn
// 但 executor glue 层允许的典型场景。

export class DefaultPipelineExecutor implements PipelineExecutor {
  constructor(private readonly spawner: ProcessSpawner) {}

  async stop(project: string): Promise<void> {
    const result = await this.spawner.runCliSync({
      args: ['stop', project],
      timeoutMs: 20_000,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `sps stop exited ${result.exitCode}`);
    }
  }

  async reset(project: string, opts: ResetPipelineOpts): Promise<void> {
    const args = ['reset', project];
    if (opts.all) args.push('--all');
    else if (Array.isArray(opts.cards) && opts.cards.length > 0) {
      args.push('--card', opts.cards.join(','));
    }
    const result = await this.spawner.runCliSync({ args, timeoutMs: 60_000 });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || `sps reset exited ${result.exitCode}`);
    }
  }

  /**
   * v0.50.8：启动前回收遗孤卡片。
   *
   * 场景：上一轮 pipeline 被 stop（或 crash），state.json 里 slot 还显示 active，
   * 卡片停在 Inprogress 带 STARTED-<stage>。下一轮 start 后 MonitorEngine 会打
   * STALE-RUNTIME（SKIP_LABEL），卡片永远跑不起来。
   *
   * 这里一次性清理：移回首阶段 trigger state（通常 Todo）+ 清全部瞬态 labels +
   * reset slot 为 idle + 清 leases。下一轮 tick 就能重新 prepare + 派发。
   */
  async recoverOrphans(project: string): Promise<number> {
    const { ProjectContext } = await import('../core/context.js');
    const { ProjectPipelineAdapter } = await import('../core/projectPipelineAdapter.js');
    const { RuntimeStore } = await import('../core/runtimeStore.js');
    const { planOrphanRecovery, resetWorkerSlot } = await import('../core/orphanRecovery.js');
    const { createTaskBackend } = await import('../providers/registry.js');

    const ctx = ProjectContext.load(project);
    const pipelineAdapter = new ProjectPipelineAdapter(ctx.config, ctx.paths.repoDir);
    const allStateNames = [
      ...new Set(
        [
          pipelineAdapter.states.planning,
          pipelineAdapter.states.backlog,
          pipelineAdapter.states.ready,
          pipelineAdapter.states.done,
          ...pipelineAdapter.stages.flatMap((s) => [s.triggerState, s.activeState, s.onCompleteState]),
        ].filter(Boolean),
      ),
    ];
    const taskBackend = createTaskBackend(ctx.config, allStateNames);
    await taskBackend.bootstrap();
    const store = new RuntimeStore({
      paths: { stateFile: ctx.paths.stateFile },
      maxWorkers: ctx.maxWorkers,
    });

    const state = store.readState();
    const { orphans, triggerState, transientLabels } = planOrphanRecovery(state, pipelineAdapter);
    if (orphans.length === 0) return 0;

    let recovered = 0;
    for (const { seq, slotName } of orphans) {
      const card = await taskBackend.getBySeq(seq).catch((err) => {
        console.warn(`[recoverOrphans] getBySeq(${seq}) failed: ${err instanceof Error ? err.message : err}`);
        return null;
      });

      if (!card) {
        // 卡片文件丢了/读不到——只清 slot 和 lease
        await this.clearSlotAndLease(store, slotName, seq);
        continue;
      }

      // 清瞬态 label
      const toRemove = card.labels.filter((l) => transientLabels.has(l));
      for (const l of toRemove) {
        await taskBackend.removeLabel(seq, l).catch((err) => {
          console.warn(`[recoverOrphans] removeLabel(${seq}, ${l}) failed: ${err instanceof Error ? err.message : err}`);
        });
      }

      // 移回首阶段 trigger state（一般是 Todo）
      if (card.state !== triggerState) {
        await taskBackend.move(seq, triggerState).catch((err) => {
          console.warn(`[recoverOrphans] move(${seq}, ${triggerState}) failed: ${err instanceof Error ? err.message : err}`);
        });
      }

      await this.clearSlotAndLease(store, slotName, seq);
      recovered++;
    }

    return recovered;
  }

  /**
   * v0.50.17：slot + lease 清理共用 helper（原版重复 2 次）。
   * 任何 update 异常降级为 console.warn（以前是静默 best-effort）。
   */
  private async clearSlotAndLease(
    store: { updateState: (reason: string, mut: (draft: any) => void) => void },
    slotName: string,
    seq: string,
  ): Promise<void> {
    const { resetWorkerSlot } = await import('../core/orphanRecovery.js');
    try {
      store.updateState(`pipeline-recover-${slotName}`, (draft) => {
        const w = draft.workers[slotName];
        if (w) resetWorkerSlot(w);
        if (draft.leases?.[seq]) {
          delete draft.leases[seq];
        }
      });
    } catch (err) {
      console.warn(`[recoverOrphans] clear slot/lease (${slotName}/${seq}) failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ─── ChatExecutor —— 直接用 DaemonClient ─────────────────────────────

const CHAT_SLOT_PREFIX = 'chat-';

export class DefaultChatExecutor implements ChatExecutor {
  async stopSession(sessionId: string): Promise<void> {
    const { DaemonClient } = await import('../daemon/daemonClient.js');
    const client = new DaemonClient();
    if (!(await client.isRunning())) return;
    await client.stopSession(`${CHAT_SLOT_PREFIX}${sessionId}`).catch(() => undefined);
  }

  async cancelRun(sessionId: string): Promise<void> {
    const { DaemonClient } = await import('../daemon/daemonClient.js');
    const client = new DaemonClient();
    if (!(await client.isRunning())) {
      throw new Error('daemon not running');
    }
    await client.cancelRun(`${CHAT_SLOT_PREFIX}${sessionId}`);
  }
}

// ─── ProjectInitExecutor —— 直接调 executeProjectInit ─────────────────

export class DefaultProjectInitExecutor implements ProjectInitExecutor {
  async init(project: string, opts: ProjectInitOpts): Promise<void> {
    const { executeProjectInit } = await import('../commands/projectInit.js');
    await executeProjectInit(project, {}, opts);
  }
}
