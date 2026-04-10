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
}

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

  sections.push(buildTaskSection(ctx));
  sections.push(buildPhaseInstructions(ctx));

  return sections.join('\n\n').trim() + '\n';
}

function buildTaskSection(ctx: SharedPromptContext): string {
  return `# Current Task

Task ID: ${ctx.taskSeq}
Task: ${ctx.taskTitle}
Working Directory: ${ctx.worktreePath}
Target Branch: ${ctx.targetBranch}
Card Full ID: ${ctx.cardId}
GitLab Project ID: ${ctx.gitlabProjectId}
MR Mode: ${ctx.mergeMode}

Description:
${ctx.taskDescription || '(no description)'}`;
}

function buildPhaseInstructions(ctx: PhasePromptContext): string {
  return `# Development Instructions

You are working on this task in the current directory: ${ctx.worktreePath}

This is a single-worker pipeline. You work directly in the project directory on the current branch.

## Steps

1. Confirm the current branch and check git status
2. Inspect the current code and determine what remains to finish the task
3. Complete the implementation
4. Run appropriate validation or tests when needed
5. Commit and push to the current branch when done

## Rules

1. Work only in the current directory: ${ctx.worktreePath}
2. Complete the implementation for this task
3. Commit frequently with conventional commit messages (feat:, fix:, refactor:, etc.)
4. Push to the current branch: git push
5. Before finishing, update docs/CHANGELOG.md with a concise summary
6. If you made architecture or technical decisions, append them to docs/DECISIONS.md
7. If you are blocked by permissions, confirmations, or missing environment requirements, report the exact blocker
8. Say "done" only after all changes are committed and pushed

## Completion

The task is complete when all changes are committed and pushed to the current branch.`;
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

  sections.push(`# Current Task

Task ID: ${ctx.taskSeq}
Task: ${ctx.taskTitle}
Working Directory: ${ctx.worktreePath}

Description:
${ctx.taskDescription || '(no description)'}`);

  sections.push(`# Task Instructions

You are working on a task in: ${ctx.worktreePath}

Rules:
1. Work only in the specified directory
2. Complete the task as described
3. Output results to the appropriate files
4. Validate your output before finishing
5. Do NOT modify files outside the working directory
6. Say "done" when finished

Completion rule:
- All required output files are created and validated
- Say "done" after confirming the results are correct`);

  return sections.join('\n\n').trim() + '\n';
}

