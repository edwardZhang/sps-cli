/**
 * @module        cardAdd
 * @description   添加任务卡片命令 —— v0.50 改走 CardService
 *
 * @role          command
 * @layer         command
 * @boundedContext taskManagement
 *
 * @trigger       sps card add <project> "<title>" ["description"] [--skill a,b] [--json]
 */
import { Logger } from '../core/logger.js';
import { readQueue, writeQueue } from '../core/queue.js';
import { toExitCode } from '../shared/errors.js';
import { createContainer } from '../services/container.js';

export async function executeCardAdd(
  project: string,
  positionals: string[],
  flags: Record<string, boolean | string>,
): Promise<void> {
  const log = new Logger('card-add', project);
  const jsonOutput = !!flags.json;

  const title = positionals[0];
  const desc = positionals.slice(1).join(' ');
  const skillFlag = typeof flags.skill === 'string' ? flags.skill : '';
  const skills = skillFlag
    ? skillFlag
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  if (!title) {
    console.error('Usage: sps card add <project> "<title>" ["description"] [--skill name1,name2]');
    process.exit(2);
  }

  // PIPELINE_LABEL + pipeline_order.json 是 CLI 侧的额外行为，Service 没有这条路径 ——
  // 走 Service 新建卡片后，CLI 自己补这两个副作用（和旧行为等价）。
  // Service 不负责：
  //   - 添加 AI-PIPELINE label（由 pipeline stage 自己决定是否要 label）
  //   - 追加 pipeline_order.json（队列是 CLI 本地视图）
  const services = createContainer();
  const result = await services.cards.create(project, { title, description: desc, skills });
  if (!result.ok) {
    const msg = result.error.message;
    if (jsonOutput) {
      console.log(JSON.stringify({ status: 'fail', error: msg, code: result.error.code }));
    } else {
      log.error(msg);
    }
    process.exit(toExitCode(result.error));
  }

  const seq = String(result.value.seq);
  const pipelineLabel = process.env.PIPELINE_LABEL || 'AI-PIPELINE';

  try {
    // 副作用：AI-PIPELINE label —— 用 Service 的 update({labels})
    const withLabels = Array.from(new Set([...result.value.labels, pipelineLabel]));
    await services.cards.update(project, result.value.seq, { labels: withLabels });

    // 副作用：追加到 pipeline_order.json
    const { ProjectContext } = await import('../core/context.js');
    const ctx = ProjectContext.load(project);
    const seqNum = Number.parseInt(seq, 10);
    if (!Number.isNaN(seqNum)) {
      const queue = readQueue(ctx.paths.pipelineOrderFile);
      if (!queue.includes(seqNum)) {
        queue.push(seqNum);
        writeQueue(ctx.paths.pipelineOrderFile, queue);
      }
    }
  } catch (err) {
    log.warn(`card created but side-effect failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        {
          status: 'ok',
          seq: result.value.seq,
          title: result.value.title,
          state: result.value.state,
          label: pipelineLabel,
        },
        null,
        2,
      ),
    );
  } else {
    log.ok(`Created seq:${seq} "${result.value.title}" in ${result.value.state} [${pipelineLabel}]`);
  }
}
