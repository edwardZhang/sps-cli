/**
 * @module        cardAdd
 * @description   添加任务卡片命令，向项目看板中创建新的任务卡
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
 * @boundedContext taskManagement
 *
 * @trigger       sps card add <project> "<title>" ["description"]
 * @inputs        项目名、卡片标题、可选描述
 * @outputs       新创建的卡片信息（文本或 JSON）
 * @workflow      1. 解析参数 → 2. 加载项目上下文 → 3. 创建 TaskBackend → 4. 写入卡片
 */
import { ProjectContext } from '../core/context.js';
import { Logger } from '../core/logger.js';
import { readQueue, writeQueue } from '../core/queue.js';
import { createTaskBackend } from '../providers/registry.js';

export async function executeCardAdd(
  project: string,
  positionals: string[],
  flags: Record<string, boolean>,
): Promise<void> {
  const log = new Logger('card-add', project);
  const jsonOutput = !!flags.json;

  const name = positionals[0];
  const desc = positionals.slice(1).join(' ');

  if (!name) {
    console.error('Usage: sps card add <project> "<title>" ["description"]');
    process.exit(2);
  }

  let ctx: ProjectContext;
  try {
    ctx = ProjectContext.load(project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(msg);
    process.exit(3);
  }

  const { ProjectPipelineAdapter } = await import('../core/projectPipelineAdapter.js');
  const adapter = new ProjectPipelineAdapter(ctx.config, ctx.paths.repoDir);
  const allStateNames = [...new Set([
    adapter.states.planning, adapter.states.backlog,
    adapter.states.ready, adapter.states.done,
    ...adapter.stages.flatMap(s => [s.triggerState, s.activeState, s.onCompleteState]),
  ].filter(Boolean))];
  const taskBackend = createTaskBackend(ctx.config, allStateNames);
  const pipelineLabel = ctx.config.PIPELINE_LABEL || 'AI-PIPELINE';

  try {
    // 0. Bootstrap (ensure directories/state exist)
    await taskBackend.bootstrap();

    // 1. Create card in Planning
    const card = await taskBackend.create(name, desc || '', 'Planning');

    // 2. Add AI-PIPELINE label
    await taskBackend.addLabel(card.seq, pipelineLabel);

    // 3. Append to pipeline_order.json (if file exists)
    const seqNum = parseInt(card.seq, 10);
    if (!isNaN(seqNum)) {
      const queue = readQueue(ctx.paths.pipelineOrderFile);
      if (!queue.includes(seqNum)) {
        queue.push(seqNum);
        writeQueue(ctx.paths.pipelineOrderFile, queue);
      }
    }

    if (jsonOutput) {
      console.log(JSON.stringify({
        status: 'ok',
        seq: card.seq,
        name: card.name,
        state: 'Planning',
        label: pipelineLabel,
      }, null, 2));
    } else {
      log.ok(`Created seq:${card.seq} "${card.name}" in Planning [${pipelineLabel}]`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonOutput) {
      console.log(JSON.stringify({ status: 'fail', error: msg }));
    } else {
      log.error(msg);
    }
    process.exit(1);
  }
}
