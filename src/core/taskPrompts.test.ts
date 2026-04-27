/**
 * @module        taskPrompts.test
 * @description   buildPhasePrompt / buildTaskPrompt 段落顺序 + wiki 插入点验证
 *
 * v0.51.0：新增 wikiContext / wikiUpdateReminder 字段。这里锁住它们的位置：
 *   wikiContext 在 knowledge 之后、`# Task` 之前；
 *   wikiUpdateReminder 在 `# How to Run` 之后。
 */
import { describe, expect, it } from 'vitest';
import { buildPhasePrompt, buildTaskPrompt } from './taskPrompts.js';

const baseCtx = {
  taskSeq: '42',
  taskTitle: 'Test card',
  taskDescription: 'do something',
  cardId: 'TASK-42',
  worktreePath: '/tmp/wt',
  branchName: 'task/42',
  targetBranch: 'main',
  mergeMode: 'none' as const,
  gitlabProjectId: '0',
};

describe('buildPhasePrompt', () => {
  it('emits prompt without optional sections', () => {
    const out = buildPhasePrompt({ ...baseCtx, phase: 'development' });
    expect(out).toContain('# Task');
    expect(out).toContain('# How to Run');
    expect(out).not.toContain('# Required Skills');
    expect(out).not.toContain('# 项目知识');
    expect(out).not.toContain('# Wiki Update Reminder');
  });

  it('inserts skill / projectRules / knowledge / wikiContext in order', () => {
    const out = buildPhasePrompt({
      ...baseCtx,
      phase: 'development',
      skillContent: '# Required Skills\nfrontend',
      projectRules: '# Project Rules\nrules',
      knowledge: '# Memory\nmem',
      wikiContext: '# 项目知识 - 当前状态\nhot',
    });
    const idxSkill = out.indexOf('# Required Skills');
    const idxRules = out.indexOf('# Project Rules');
    const idxMem = out.indexOf('# Memory');
    const idxWiki = out.indexOf('# 项目知识');
    const idxTask = out.indexOf('# Task');
    expect(idxSkill).toBeGreaterThan(-1);
    expect(idxSkill).toBeLessThan(idxRules);
    expect(idxRules).toBeLessThan(idxMem);
    expect(idxMem).toBeLessThan(idxWiki);
    expect(idxWiki).toBeLessThan(idxTask);
  });

  it('appends wikiUpdateReminder after `# How to Run`', () => {
    const out = buildPhasePrompt({
      ...baseCtx,
      phase: 'development',
      wikiUpdateReminder: '# Wiki Update Reminder\nremember to update wiki.',
    });
    const idxRun = out.indexOf('# How to Run');
    const idxReminder = out.indexOf('# Wiki Update Reminder');
    expect(idxRun).toBeGreaterThan(-1);
    expect(idxReminder).toBeGreaterThan(idxRun);
  });

  it('omits wiki sections cleanly when undefined', () => {
    const out = buildPhasePrompt({
      ...baseCtx,
      phase: 'development',
      knowledge: 'mem',
    });
    expect(out).toContain('mem');
    expect(out).not.toContain('# 项目知识');
    expect(out).not.toContain('# Wiki Update Reminder');
  });

  it('treats whitespace-only wikiContext / reminder as absent', () => {
    const out = buildPhasePrompt({
      ...baseCtx,
      phase: 'development',
      wikiContext: '   \n\n   ',
      wikiUpdateReminder: '\t  ',
    });
    expect(out).not.toContain('# 项目知识');
    expect(out).not.toContain('# Wiki Update Reminder');
  });
});

describe('buildTaskPrompt (non-git)', () => {
  it('inserts wikiContext between knowledge and Task header', () => {
    const out = buildTaskPrompt({
      ...baseCtx,
      knowledge: '# Memory\nmem',
      wikiContext: '# 项目知识 - 当前状态\nhot',
    });
    const idxMem = out.indexOf('# Memory');
    const idxWiki = out.indexOf('# 项目知识');
    const idxTask = out.indexOf('# Task');
    expect(idxMem).toBeLessThan(idxWiki);
    expect(idxWiki).toBeLessThan(idxTask);
  });

  it('appends wikiUpdateReminder after `# How to Run`', () => {
    const out = buildTaskPrompt({
      ...baseCtx,
      wikiUpdateReminder: '# Wiki Update Reminder\nflush manifest.',
    });
    const idxRun = out.indexOf('# How to Run');
    const idxReminder = out.indexOf('# Wiki Update Reminder');
    expect(idxRun).toBeGreaterThan(-1);
    expect(idxReminder).toBeGreaterThan(idxRun);
  });

  it('produces clean output without wiki sections', () => {
    const out = buildTaskPrompt({
      ...baseCtx,
    });
    expect(out).toContain('# Task');
    expect(out).toContain('# How to Run');
    expect(out).not.toContain('# 项目知识');
    expect(out).not.toContain('# Wiki Update Reminder');
  });
});
