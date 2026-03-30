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
  if (pmState === 'Inprogress') return 'development';
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

Your responsibility is to merge branch ${ctx.branchName} into ${ctx.targetBranch}.

## CRITICAL: Worktree Checkout Limitation

You are working inside a git worktree at: ${ctx.worktreePath}
The target branch "${ctx.targetBranch}" is checked out in the main repository.
Git does NOT allow the same branch to be checked out in two worktrees simultaneously.

DO NOT run:
  git checkout ${ctx.targetBranch}    ← will fail with "already used by worktree"
  git switch ${ctx.targetBranch}      ← same error
  git branch -f ${ctx.targetBranch}   ← same error

Instead, use this merge strategy:
  1. Stay on branch ${ctx.branchName}
  2. Rebase onto origin/${ctx.targetBranch}: git fetch origin && git rebase origin/${ctx.targetBranch}
  3. Resolve any conflicts during rebase
  4. Push the rebased branch: git push origin ${ctx.branchName} --force-with-lease
  5. Push to target: git push origin ${ctx.branchName}:${ctx.targetBranch}

## Steps

1. Confirm the current branch (should be ${ctx.branchName})
2. Check git status — look for in-progress rebase/merge
3. Fetch latest: git fetch origin
4. Rebase onto origin/${ctx.targetBranch}
5. Resolve any conflicts based on the task intent and codebase
6. Complete rebase: git add . && git rebase --continue
7. Push: git push origin ${ctx.branchName}:${ctx.targetBranch}
8. Validate the final state

## Rules

1. Work only in this worktree: ${ctx.worktreePath}
2. Never checkout or switch to ${ctx.targetBranch} — use rebase + push instead
3. If conflicts exist, resolve them carefully based on the task intent
4. Before finishing, update docs/CHANGELOG.md with integration summary
5. If you made architecture decisions, append to docs/DECISIONS.md
6. Do not restart development from scratch
7. If blocked by permissions or external policy, report the exact blocker
8. Say "done" only after the push to ${ctx.targetBranch} succeeds

## Completion

The task is complete when: git push origin ${ctx.branchName}:${ctx.targetBranch} succeeds.`;
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
5. Before finishing, update docs/CHANGELOG.md with a concise summary of the implementation completed in this phase
6. If you made architecture or technical decisions, append them to docs/DECISIONS.md
7. Do not merge into the target branch ${ctx.targetBranch} in this phase
8. Do not run merge scripts or perform integration work in this phase
9. Do not push or update the target branch in this phase
10. If you are blocked by permissions, confirmations, or missing environment requirements, report the exact blocker
11. Say "done" only after the implementation work is complete and committed on ${ctx.branchName}

Completion rule:
- The intended end of this phase is: the implementation is complete and committed on branch ${ctx.branchName}.
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
