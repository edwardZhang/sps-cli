import type { CardState } from '../models/types.js';
import type { TaskLeasePhase } from './state.js';

export type WorkerTaskPhase = 'development' | 'integration';

export const DEVELOPMENT_PROMPT_FILE = 'development_prompt.txt';
export const INTEGRATION_PROMPT_FILE = 'integration_prompt.txt';
export const LEGACY_TASK_PROMPT_FILE = 'task_prompt.txt';

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

export function selectWorkerPhase(
  pmState: CardState | null | undefined,
  leasePhase?: TaskLeasePhase | null,
): WorkerTaskPhase {
  if (pmState === 'QA') return 'integration';
  if (leasePhase && ['merging', 'resolving_conflict'].includes(leasePhase)) {
    return 'integration';
  }
  return 'development';
}

export function promptFileForPhase(phase: WorkerTaskPhase): string {
  return phase === 'integration' ? INTEGRATION_PROMPT_FILE : DEVELOPMENT_PROMPT_FILE;
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
Branch: ${ctx.branchName}
Target Branch: ${ctx.targetBranch}
Card Full ID: ${ctx.cardId}
GitLab Project ID: ${ctx.gitlabProjectId}
MR Mode: ${ctx.mergeMode}
Worktree: ${ctx.worktreePath}

Description:
${ctx.taskDescription || '(no description)'}`;
}

function buildPhaseInstructions(ctx: PhasePromptContext): string {
  if (ctx.phase === 'integration') {
    return `# Integration Phase Instructions

You are in the integration phase for this task.

Your responsibility in this phase is to integrate the current task branch back into the target branch.

First inspect the repository state yourself in this worktree:
1. Confirm the current branch
2. Check git status
3. Check whether a rebase or merge is already in progress
4. Inspect conflicts if they exist
5. Determine the exact next step required to finish integration

Rules:
1. Work only in the current worktree: ${ctx.worktreePath}
2. Integrate branch ${ctx.branchName} back into target branch ${ctx.targetBranch}
3. If there are conflicts, resolve them carefully based on the task intent and current codebase
4. Complete any required git add / rebase --continue / merge follow-up steps
5. Validate the repository state before finishing
6. Do not restart development from scratch unless the repository state clearly requires code changes to complete integration
7. If you are blocked by permissions, confirmations, or external policy, report the exact blocker instead of looping forever
8. Say "done" only after integration work is complete or you have identified a concrete external blocker

Completion rule:
- The preferred outcome of this phase is: the integration work is finished successfully for branch ${ctx.branchName} against target ${ctx.targetBranch}.
- Do not treat this phase as a fresh development task.`;
  }

  return `# Development Phase Instructions

You are in the development phase for this task.

Your responsibility in this phase is to complete the implementation work in the current task branch.

First inspect the repository state yourself in this worktree:
1. Confirm the current branch
2. Check git status
3. Check whether a rebase or merge is already in progress
4. Inspect the current code and determine what remains to finish the task

Rules:
1. Work only in the current worktree: ${ctx.worktreePath}
2. Complete the implementation for this task
3. Run appropriate validation or tests when needed
4. Commit the finished work to the current task branch ${ctx.branchName}
5. Do not merge into the target branch ${ctx.targetBranch} in this phase
6. Do not run merge scripts or perform integration work in this phase
7. Current pipeline handoff still requires the feature branch to be pushed after implementation is complete; push ${ctx.branchName} only after the development work is committed and ready for handoff
8. If you are blocked by permissions, confirmations, or missing environment requirements, report the exact blocker
9. Say "done" only after the implementation work is complete and the branch is in a ready-for-integration state

Completion rule:
- The intended end of this phase is: the implementation is complete on branch ${ctx.branchName} and ready to enter integration.
- Do not merge into ${ctx.targetBranch} in this phase.`;
}

export function buildResumePrompt(
  phase: WorkerTaskPhase,
  worktreePath: string,
  branchName: string,
  originalPrompt: string | null,
): string {
  const phaseLabel = phase === 'integration' ? 'QA' : 'Inprogress';
  const phaseGoal = phase === 'integration'
    ? 'Continue the integration work for this task in the current worktree.'
    : 'Continue the development work for this task in the current worktree.';

  const header = [
    'The previous SPS tick process stopped. The old worker session is gone.',
    'Recover this task at the task level in the existing worktree.',
    `Current PM State: ${phaseLabel}`,
    `Worktree: ${worktreePath}`,
    `Branch: ${branchName}`,
    '',
    phaseGoal,
    'First inspect the current repository state yourself before changing anything.',
    'Then continue the same task from the current repository state instead of starting over.',
  ].join('\n');

  if (!originalPrompt?.trim()) {
    return header;
  }

  return `${header}\n\nPhase task context:\n---\n${originalPrompt.trim()}`;
}
