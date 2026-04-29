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
    console.error('Usage: sps card add <project> "<title>" ["description"] [--skill name1,name2] [--draft]');
    process.exit(2);
  }

  // v0.51.10：默认入 Backlog（CLI 主要被 agent / 自动化调用，期望立即跑）。
  // --draft 把卡放 Planning 等手动派发（人在终端建卡、想稍后再决定时用）。
  const isDraft = !!flags.draft;
  const initialState = isDraft ? 'Planning' : 'Backlog';

  // PIPELINE_LABEL 副作用：Service 创建后 CLI 自己补 AI-PIPELINE 标签（标签是
  // "SPS pipeline 卡"的标记，不再触发 SchedulerEngine — 因 v0.51.9 起卡直接进 Backlog）
  // v0.51.9：删去 pipeline_order.json 副作用（统一按 seq 排序）
  const services = createContainer();
  const result = await services.cards.create(project, {
    title,
    description: desc,
    skills,
    initialState,
  });
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
  } catch (err) {
    log.warn(`card created but label side-effect failed: ${err instanceof Error ? err.message : String(err)}`);
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
