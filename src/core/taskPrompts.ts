/**
 * @module        taskPrompts
 * @description   Worker 任务提示词模板生成
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-28
 * @updated       2026-04-03
 *
 * @role          util
 * @layer         core
 * @boundedContext worker
 */
export type WorkerTaskPhase = 'development' | 'integration';

interface SharedPromptContext {
  taskSeq: string;
  taskTitle: string;
  taskDescription: string;
  cardId: string;
  worktreePath: string;
  branchName: string;
  targetBranch: string;
  mergeMode: 'none' | 'create';
  gitlabProjectId: string;
  skillContent?: string;
  projectRules?: string;
  knowledge?: string;
  /**
   * v0.51.0: pre-rendered wiki context (hot.md + index summary + relevant pages).
   * Produced by `wikiRead → formatWikiContext`. Inserted between `knowledge` and `# Task`.
   * When WIKI_ENABLED=false, callers leave this undefined so nothing is appended.
   */
  wikiContext?: string;
  /**
   * v0.51.0: trailing reminder block pointing to the `wiki-update` skill. Worker
   * sees it after `# How to Run` so it's the last thing read before deciding what
   * to write.
   */
  wikiUpdateReminder?: string;
  /** v0.50.18：完成信号词，默认 "done"。项目 YAML / env 可覆盖。 */
  completionSignal?: string;
}

/** v0.50.18：Worker 完成信号的默认词——Stop hook 监听此词触发 COMPLETED 标签 */
export const DEFAULT_COMPLETION_SIGNAL = 'done';

interface PhasePromptContext extends SharedPromptContext {
  phase: WorkerTaskPhase;
}

export function buildPhasePrompt(ctx: PhasePromptContext): string {
  const sections: string[] = [];

  if (ctx.skillContent?.trim()) {
    sections.push(ctx.skillContent.trim());
    sections.push('---');
  }

  if (ctx.projectRules?.trim()) {
    sections.push(ctx.projectRules.trim());
    sections.push('---');
  }

  if (ctx.knowledge?.trim()) {
    sections.push(ctx.knowledge.trim());
    sections.push('---');
  }

  if (ctx.wikiContext?.trim()) {
    sections.push(ctx.wikiContext.trim());
    sections.push('---');
  }

  sections.push(buildTaskSection(ctx));
  sections.push(buildPhaseInstructions(ctx));

  if (ctx.wikiUpdateReminder?.trim()) {
    sections.push(ctx.wikiUpdateReminder.trim());
  }

  return sections.join('\n\n').trim() + '\n';
}

function buildTaskSection(ctx: SharedPromptContext): string {
  // v0.50.9：只显式列 MR 相关字段，当 merge mode = create 时才输出。其余情况
  // Card Full ID / GitLab Project ID / MR Mode 对 Worker 基本无用，去掉降噪。
  const mrLine = ctx.mergeMode === 'create'
    ? `\nTarget branch: ${ctx.targetBranch} (MR mode, GitLab project ${ctx.gitlabProjectId})`
    : '';
  return `# Task

${ctx.taskTitle} (seq ${ctx.taskSeq})

Working directory: ${ctx.worktreePath}${mrLine}

Description:
${ctx.taskDescription || '(no description)'}`;
}

function buildPhaseInstructions(ctx: PhasePromptContext): string {
  // v0.50.9：大幅瘦身。只保留 SPS 框架不可回避的不变式：worktree 隔离、push、
  // 报告 blocker、说 <signal> 作为完成信号。其他项目级约定（CHANGELOG / DECISIONS /
  // conventional commits）归 CLAUDE.md 管，projectRules 段会注入。
  // v0.50.18：completion signal 参数化，默认 "done"。
  const signal = ctx.completionSignal ?? DEFAULT_COMPLETION_SIGNAL;
  return `# How to Run

Work inside \`${ctx.worktreePath}\`. Inspect the code, implement the task, commit, then \`git push\` to the current branch. Say "${signal}" only after the push succeeds.

If blocked by missing permissions / unclear requirements / environment issues, report the exact blocker instead of guessing.`;
}

/**
 * Build prompt for non-git task (git: false pipeline).
 * No branch, worktree, push, or merge instructions.
 */
export function buildTaskPrompt(ctx: SharedPromptContext): string {
  const sections: string[] = [];

  if (ctx.skillContent?.trim()) {
    sections.push(ctx.skillContent.trim());
    sections.push('---');
  }

  if (ctx.projectRules?.trim()) {
    sections.push(ctx.projectRules.trim());
    sections.push('---');
  }

  if (ctx.knowledge?.trim()) {
    sections.push(ctx.knowledge.trim());
    sections.push('---');
  }

  if (ctx.wikiContext?.trim()) {
    sections.push(ctx.wikiContext.trim());
    sections.push('---');
  }

  sections.push(`# Task

${ctx.taskTitle} (seq ${ctx.taskSeq})

Working directory: ${ctx.worktreePath}

Description:
${ctx.taskDescription || '(no description)'}`);

  const signal = ctx.completionSignal ?? DEFAULT_COMPLETION_SIGNAL;
  sections.push(`# How to Run

Work inside \`${ctx.worktreePath}\`. Complete the task, validate the output, then say "${signal}". Don't touch files outside this directory. If blocked, report the exact blocker.`);

  if (ctx.wikiUpdateReminder?.trim()) {
    sections.push(ctx.wikiUpdateReminder.trim());
  }

  return sections.join('\n\n').trim() + '\n';
}

