/**
 * @module        SchedulerEngine
 * @description   调度引擎（v0.51.9 起为 dormant — 卡 add 直接进 Backlog，
 *                Planning 改为人工暂存，无需自动提升）
 *
 * @deprecated  v0.51.9 后 tick() 是 no-op；保留类便于 tick 编排器接口稳定。
 *              v0.52 计划完整移除（含 sps scheduler tick 命令、pipeline.engines 入口）。
 *              历史职责（Planning → Backlog 自动提升 + pipeline_order.json 排序）见
 *              `revision.md` Rev 159 决策记录。
 *
 * @role          engine
 * @layer         engine
 * @boundedContext task-scheduling
 */

import type { ProjectContext } from '../core/context.js';
import { Logger } from '../core/logger.js';
import type { ProjectPipelineAdapter } from '../core/projectPipelineAdapter.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { CommandResult } from '../shared/types.js';

export class SchedulerEngine {
  private log: Logger;

  constructor(
    private ctx: ProjectContext,
    private taskBackend: TaskBackend,
    private pipelineAdapter: ProjectPipelineAdapter,
    private notifier?: Notifier,
  ) {
    this.log = new Logger('scheduler', ctx.projectName, ctx.paths.logsDir);
  }

  /**
   * v0.51.9：no-op。卡 add 直接进 Backlog，Planning 不再自动提升。
   *
   * 保留方法是为了：
   *   - tick 编排器无需改接口（pipeline tick / sps scheduler tick）
   *   - 老监控 / 工具脚本 dump 状态时仍能拿到 standard CommandResult shape
   *
   * 真正的卡片调度（Backlog → Todo → Inprogress）在 StageEngine。
   */
  async tick(_opts: { dryRun?: boolean } = {}): Promise<CommandResult> {
    void this.taskBackend;
    void this.pipelineAdapter;
    void this.notifier;
    this.log.info('scheduler is dormant since v0.51.9 (no Planning → Backlog promotion)');
    return {
      project: this.ctx.projectName,
      component: 'scheduler',
      status: 'ok',
      exitCode: 0,
      actions: [],
      recommendedActions: [],
      details: { reason: 'dormant_v0.51.9' },
    };
  }
}
