/**
 * @module        core/orphanRecovery
 * @description   遗孤 slot / 卡片恢复的纯函数层——解析 runtime state + pipeline 配置，
 *                产出一个可测试的 RecoveryPlan。执行逻辑（真实写 state / backend）由
 *                executor 层负责。
 *
 * @layer         core / domain
 *
 * v0.50.17：从 DefaultPipelineExecutor.recoverOrphans 抽出。原版 108 行的方法内嵌了
 * 配置加载、io、状态写入、错误吞咽——没法单测。拆后此处纯逻辑可测，executor 只做 glue。
 */

// ─── Inputs ──────────────────────────────────────────────────────

export interface WorkerSlotLike {
  status?: string;
  seq?: number | string | null;
}

export interface StageLike {
  name: string;
  triggerState?: string;
  activeState?: string;
  onCompleteState?: string;
}

export interface PipelineAdapterLike {
  states: { ready?: string };
  stages: StageLike[];
}

export interface RuntimeStateLike {
  workers: Record<string, WorkerSlotLike>;
  leases?: Record<string, unknown>;
}

// ─── Output ──────────────────────────────────────────────────────

export interface RecoveryPlan {
  /** seq+slot 的 orphan 列表，按输入顺序保留。 */
  orphans: Array<{ seq: string; slotName: string }>;
  /** 推回的目标 state（一般是第一 stage 的 triggerState，缺省 states.ready） */
  triggerState: string;
  /** 所有瞬态 label —— 回收时从卡片上清掉这些 */
  transientLabels: Set<string>;
}

// ─── Planner ─────────────────────────────────────────────────────

// 基于 state + pipeline 配置产出一个回收计划。纯函数，无副作用。
//   - orphans：state.workers 里 status != 'idle' 且绑着 seq 的 slot
//   - triggerState：首 stage 的 triggerState；缺失则回退 states.ready
//   - transientLabels：所有阶段的 STARTED-x / ACK-RETRIED-x + 全局瞬态集合
export function planOrphanRecovery(
  state: RuntimeStateLike,
  pipelineAdapter: PipelineAdapterLike,
): RecoveryPlan {
  const orphans: Array<{ seq: string; slotName: string }> = [];
  for (const [slotName, w] of Object.entries(state.workers)) {
    if (w.status === 'idle' || w.seq == null) continue;
    orphans.push({ seq: String(w.seq), slotName });
  }

  const firstStage = pipelineAdapter.stages[0];
  const triggerState =
    firstStage?.triggerState ?? pipelineAdapter.states.ready ?? 'Todo';

  const transientLabels = new Set<string>([
    'CLAIMED',
    'STALE-RUNTIME',
    'ACK-TIMEOUT',
    'RACE-CANDIDATE',
  ]);
  for (const stage of pipelineAdapter.stages) {
    transientLabels.add(`STARTED-${stage.name}`);
    transientLabels.add(`ACK-RETRIED-${stage.name}`);
  }

  return { orphans, triggerState, transientLabels };
}

/**
 * 给定一个 worker slot 对象，重置为 idle（就地修改）。executor 和 monitor 都用。
 * 用 null 清空瞬态字段；保留 slotName/静态配置。
 */
export function resetWorkerSlot(slot: Record<string, unknown>): void {
  slot.status = 'idle';
  slot.seq = null;
  slot.branch = null;
  slot.worktree = null;
  slot.claimedAt = null;
  slot.lastHeartbeat = null;
  if ('pid' in slot) slot.pid = null;
  if ('sessionId' in slot) slot.sessionId = null;
}
