/**
 * @module        hookCommand
 * @description   Claude Code hook 事件的 SPS 包装命令，简化 .claude/settings.json 中的 hook 脚本
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
 * @boundedContext agent-hooks
 *
 * @trigger       sps hook <event>   (由 .claude/settings.json 的 hook 脚本调用)
 * @inputs        hook 事件的 JSON 载荷（stdin）+ SPS_* 环境变量
 * @outputs       对 stop：给卡片加 COMPLETED-<stage> 标签
 *                对 user-prompt-submit：JSON 输出附加 system prompt（注入 skill 提示）
 *
 * 设计说明：
 * - hook 脚本只需一行：`sps hook <event>` —— 不必写 jq / env 提取逻辑
 * - 依赖 worker 启动时注入的 SPS_* env vars（见 worker-manager-impl.ts）
 * - 读 stdin 的 Claude hook payload（JSON）辅助判断
 */
import { executeCardMarkComplete } from './cardMarkComplete.js';
import { ProjectContext } from '../core/context.js';
import { createTaskBackend } from '../providers/registry.js';
import { ProjectPipelineAdapter } from '../core/projectPipelineAdapter.js';

/** Read all of stdin as a string (best effort, with timeout). */
async function readStdin(timeoutMs = 1_000): Promise<string> {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => { clearTimeout(timer); resolve(data); });
    process.stdin.on('error', () => { clearTimeout(timer); resolve(data); });
  });
}

interface ClaudeHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  prompt?: string;
}

async function parseStdinAsJson(): Promise<ClaudeHookPayload | null> {
  const raw = await readStdin();
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ─── Subcommand: stop ────────────────────────────────────────────

/**
 * Called from .claude/settings.json's Stop hook. Adds COMPLETED-<stage> label
 * to the current card. Requires SPS_PROJECT + SPS_CARD_ID + SPS_STAGE env vars.
 */
async function hookStop(flags: Record<string, unknown>): Promise<void> {
  const project = process.env.SPS_PROJECT;
  const cardId = process.env.SPS_CARD_ID;
  const stage = process.env.SPS_STAGE;

  if (!project || !cardId) {
    // Worker process not running inside SPS pipeline — skip silently.
    // This happens if user runs claude manually in a cwd with .claude/settings.json,
    // without SPS having spawned the worker.
    process.stderr.write('[sps hook stop] SPS_PROJECT or SPS_CARD_ID not set — not in SPS pipeline, skipping\n');
    return;
  }

  // Drain stdin to avoid blocking claude-agent-acp (payload is optional here).
  await readStdin();

  // Delegate to mark-complete (handles stage resolution + idempotency).
  await executeCardMarkComplete(project, [cardId], { ...flags, stage });
}

// ─── Subcommand: user-prompt-submit ──────────────────────────────

/**
 * Called from .claude/settings.json's UserPromptSubmit hook. If the current
 * card has skill:<name> labels, emit a Claude hookSpecificOutput JSON so the
 * prompt is prefixed with "You MUST use skill <name>" instruction.
 */
async function hookUserPromptSubmit(_flags: Record<string, unknown>): Promise<void> {
  const project = process.env.SPS_PROJECT;
  const cardId = process.env.SPS_CARD_ID;

  // Drain stdin (payload not needed for this hook)
  await readStdin();

  if (!project || !cardId) return; // not in pipeline, nothing to inject

  let ctx: ProjectContext;
  try {
    ctx = ProjectContext.load(project);
  } catch {
    return; // project not loadable — fail silently
  }

  const adapter = new ProjectPipelineAdapter(ctx.config, ctx.paths.repoDir);
  const allStateNames = [...new Set([
    adapter.states.planning, adapter.states.backlog,
    adapter.states.ready, adapter.states.done,
    ...adapter.stages.flatMap(s => [s.triggerState, s.activeState, s.onCompleteState]),
  ].filter(Boolean))];
  const taskBackend = createTaskBackend(ctx.config, allStateNames);

  let card: { labels: string[] } | null = null;
  try {
    card = await taskBackend.getBySeq(cardId);
  } catch {
    return;
  }
  if (!card) return;

  const skillLabels = card.labels
    .filter(l => l.startsWith('skill:'))
    .map(l => l.slice('skill:'.length))
    .filter(Boolean);

  if (skillLabels.length === 0) return;

  const skillHint = skillLabels
    .map(n => `- \`${n}\` (see ~/.claude/skills/${n}/SKILL.md)`)
    .join('\n');

  // Claude Code hookSpecificOutput format for UserPromptSubmit: the `additionalContext`
  // string is prepended to the prompt before Claude processes it.
  const output = {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext:
        `[SPS skill hint] This card is tagged with the following skills — you MUST consult them before acting:\n${skillHint}\n`,
    },
  };
  console.log(JSON.stringify(output));
}

// ─── Entry ────────────────────────────────────────────────────────

export async function executeHook(
  event: string,
  flags: Record<string, unknown>,
): Promise<void> {
  switch (event) {
    case 'stop':
      await hookStop(flags);
      break;
    case 'user-prompt-submit':
      await hookUserPromptSubmit(flags);
      break;
    default:
      process.stderr.write(`[sps hook] Unknown event: ${event}\n`);
      process.stderr.write(`Usage: sps hook <stop|user-prompt-submit>\n`);
      process.exit(2);
  }
}

// Exported for potential future use
export { parseStdinAsJson };
