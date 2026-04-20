/**
 * @module        cardMarkStarted
 * @description   标记任务卡片为已开始处理，由 Claude UserPromptSubmit hook 调用
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @role          command
 * @layer         command
 * @boundedContext taskManagement
 *
 * @trigger       sps card mark-started <project> [seq] [--stage <name>]
 * @inputs        项目名；可选 seq（不传则从 marker 文件反查）；可选 --stage
 * @outputs       JSON: { ok, seq, stage, label } 或 stderr 错误
 * @workflow      1. 解析 seq 和 stage（优先级见注释）→ 2. addLabel STARTED-<stage> → 幂等
 *
 * 设计说明：
 * - 和 mark-complete 对称：一个标"开始"，一个标"完成"
 * - 用于 SPS 探活 resumeRun 是否真正触发 claude 处理：派发后 N 秒仍没有
 *   STARTED-<stage> 标签 → MonitorEngine 判定 ACK 超时
 * - 幂等：已有标签不报错
 */
import { ProjectContext } from '../core/context.js';
import { Logger } from '../core/logger.js';
import { readCurrentCardMarker } from '../core/markerFile.js';
import { createTaskBackend } from '../providers/registry.js';
import { ProjectPipelineAdapter } from '../core/projectPipelineAdapter.js';

export async function executeCardMarkStarted(
  project: string,
  positionals: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const log = new Logger('card-mark-started', project);
  const jsonOutput = !!flags.json;

  // Seq resolution priority:
  //   1. Positional arg (explicit CLI usage)
  //   2. runtime/worker-<SPS_WORKER_SLOT>-current.json (hook usage)
  //
  // No fallback to $SPS_CARD_ID env — it's stale under claude process reuse.
  let seq = positionals[0];
  const stageFromFlag = typeof flags.stage === 'string' ? flags.stage : undefined;
  let stageFromMarker: string | undefined;

  if (!seq) {
    const slot = process.env.SPS_WORKER_SLOT;
    if (!slot) {
      console.error('Usage: sps card mark-started <project> <seq> [--stage <name>]');
      console.error('       (when called without seq, SPS_WORKER_SLOT env is required)');
      process.exit(2);
    }
    const marker = readCurrentCardMarker(project, slot);
    if (!marker) {
      console.error(`No current-card marker found at runtime/worker-${slot}-current.json`);
      console.error('Either pass <seq> explicitly, or ensure the worker manager wrote the marker before dispatch.');
      process.exit(2);
    }
    seq = marker.cardId;
    if (marker.stage) stageFromMarker = marker.stage;
  }

  // Stage resolution: --stage flag > marker file > $SPS_STAGE env > 'develop'
  const stageFromEnv = process.env.SPS_STAGE;
  const stage = stageFromFlag || stageFromMarker || stageFromEnv || 'develop';

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

  const label = `STARTED-${stage}`;

  try {
    await taskBackend.addLabel(seq, label);
    const message = `seq:${seq} marked started for stage '${stage}' (label: ${label})`;
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
