/**
 * @module        cardMarkComplete
 * @description   标记任务卡片为已完成，由 Claude Stop hook 调用
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-04-17
 * @updated       2026-04-17
 *
 * @role          command
 * @layer         command
 * @boundedContext taskManagement
 *
 * @trigger       sps card mark-complete <project> <seq> [--stage <name>]
 * @inputs        项目名、卡片序号；可选 --stage 覆盖 $SPS_STAGE
 * @outputs       JSON: { ok, stage, label } 或 stderr 错误
 * @workflow      1. 解析 stage（优先 flag，其次 env）→ 2. addLabel COMPLETED-<stage> → 3. 可选评论
 *
 * 设计说明：
 * - 命令只打标签，不动卡片状态；pipeline tick 看到标签后按 YAML 推进
 * - 幂等：已有同名标签不报错
 */
import { ProjectContext } from '../core/context.js';
import { Logger } from '../core/logger.js';
import { createTaskBackend } from '../providers/registry.js';
import { ProjectPipelineAdapter } from '../core/projectPipelineAdapter.js';

export async function executeCardMarkComplete(
  project: string,
  positionals: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const log = new Logger('card-mark-complete', project);
  const jsonOutput = !!flags.json;
  const seq = positionals[0];

  if (!seq) {
    console.error('Usage: sps card mark-complete <project> <seq> [--stage <name>]');
    process.exit(2);
  }

  // Resolve stage: --stage flag > $SPS_STAGE env > 'develop' (default)
  const stageFromFlag = typeof flags.stage === 'string' ? flags.stage : undefined;
  const stageFromEnv = process.env.SPS_STAGE;
  const stage = stageFromFlag || stageFromEnv || 'develop';

  let ctx: ProjectContext;
  try {
    ctx = ProjectContext.load(project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(msg);
    process.exit(3);
  }

  const adapter = new ProjectPipelineAdapter(ctx.config, ctx.paths.repoDir);
  const allStateNames = [...new Set([
    adapter.states.planning, adapter.states.backlog,
    adapter.states.ready, adapter.states.done,
    ...adapter.stages.flatMap(s => [s.triggerState, s.activeState, s.onCompleteState]),
  ].filter(Boolean))];
  const taskBackend = createTaskBackend(ctx.config, allStateNames);

  const label = `COMPLETED-${stage}`;

  try {
    await taskBackend.addLabel(seq, label);
    const message = `seq:${seq} marked complete for stage '${stage}' (label: ${label})`;
    log.ok(message);
    if (jsonOutput) {
      console.log(JSON.stringify({ ok: true, seq, stage, label }));
    } else {
      console.log(message);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to add label ${label}: ${msg}`);
    if (jsonOutput) {
      console.log(JSON.stringify({ ok: false, seq, stage, label, error: msg }));
    }
    process.exit(1);
  }
}
