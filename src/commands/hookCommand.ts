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

import { ProjectContext } from '../core/context.js';
import { readCurrentCardMarker } from '../core/markerFile.js';
import { ProjectPipelineAdapter } from '../core/projectPipelineAdapter.js';
import { createTaskBackend } from '../providers/registry.js';
import { executeCardMarkComplete } from './cardMarkComplete.js';

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
 * Called from .claude/settings.json's Stop hook as an alternative to the
 * project-template bash stop.sh. Reads the per-slot marker file to find the
 * current card, then delegates to mark-complete.
 *
 * v0.40.2+: We no longer trust $SPS_CARD_ID env (frozen at spawn, stale on
 * process reuse). Only $SPS_PROJECT + $SPS_WORKER_SLOT are stable.
 */
async function hookStop(flags: Record<string, unknown>): Promise<void> {
  const project = process.env.SPS_PROJECT;
  const slot = process.env.SPS_WORKER_SLOT;

  if (!project || !slot) {
    // Worker process not running inside SPS pipeline — skip silently.
    process.stderr.write('[sps hook stop] SPS_PROJECT or SPS_WORKER_SLOT not set — not in SPS pipeline, skipping\n');
    return;
  }

  // Drain stdin to avoid blocking claude-agent-acp.
  await readStdin();

  // Delegate to mark-complete; it will read the marker file itself (no seq
  // arg passed, so it falls back to marker lookup).
  await executeCardMarkComplete(project, [], flags);
}

// ─── Subcommand: user-prompt-submit ──────────────────────────────

/**
 * Called from .claude/settings.json's UserPromptSubmit hook. Two responsibilities:
 *
 *   1. Add STARTED-<stage> label to the current card. This is the "ACK signal"
 *      that SPS uses to confirm claude actually received the prompt and started
 *      processing (not just that resumeRun returned successfully). MonitorEngine
 *      uses the absence of this label past WORKER_ACK_TIMEOUT_S to detect
 *      resume failure.
 *
 *   2. If the card has skill:<name> labels, emit hookSpecificOutput so the
 *      prompt is prefixed with skill usage instructions.
 *
 * v0.40.2+ reads the marker file for current cardId (not $SPS_CARD_ID env,
 * which is no longer injected).
 */
async function hookUserPromptSubmit(_flags: Record<string, unknown>): Promise<void> {
  const project = process.env.SPS_PROJECT;
  const slot = process.env.SPS_WORKER_SLOT;

  // Drain stdin (payload not needed for this hook).
  await readStdin();

  if (!project || !slot) return; // not in pipeline, nothing to do

  const marker = readCurrentCardMarker(project, slot);
  if (!marker) {
    process.stderr.write(`[sps hook user-prompt-submit] No marker file at worker-${slot}-current.json — cannot identify card, skipping\n`);
    return;
  }
  const cardId = marker.cardId;
  const stage = marker.stage || 'develop';

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

  // ─── 1. Add STARTED-<stage> label (ACK signal) ────────────────
  const startedLabel = `STARTED-${stage}`;
  try {
    await taskBackend.addLabel(cardId, startedLabel);
  } catch (err) {
    // Non-fatal for prompt processing — log and continue. MonitorEngine will
    // detect ACK timeout if the label never lands.
    process.stderr.write(`[sps hook user-prompt-submit] addLabel ${startedLabel} failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`);
  }

  // ─── 2. Skill hints (if any) ──────────────────────────────────
  let card: { labels: string[]; skills?: string[] } | null = null;
  try {
    card = await taskBackend.getBySeq(cardId);
  } catch {
    return;
  }
  if (!card) return;

  // v0.42.0+: `skills` is a first-class frontmatter field. Legacy `skill:*`
  // labels are no longer parsed (hard break per v0.42 design decision #5).
  const skillNames = Array.isArray(card.skills) ? card.skills.filter(Boolean) : [];

  if (skillNames.length === 0) return;

  const skillHint = skillNames
    .map(n => `- \`${n}\` (project-local: .claude/skills/${n}/SKILL.md)`)
    .join('\n');

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
