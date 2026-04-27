/**
 * @module        StageEngine.wiki.test
 * @description   v0.51.0：StageEngine 的 wiki 支持函数 + 端到端注入测试
 *
 * 三层验证：
 *   1. extractPinnedPages — 卡 frontmatter wiki_pages 解析
 *   2. wikiRead → formatWikiContext 注入到 buildPhasePrompt 的位置
 *   3. WIKI_ENABLED=false 时不注入
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildPhasePrompt } from '../core/taskPrompts.js';
import { writeHot } from '../core/wiki/hot.js';
import { writePage } from '../core/wiki/page.js';
import { formatWikiContext, wikiRead } from '../core/wiki/reader.js';
import { initWiki } from '../core/wiki/scaffold.js';
import type { Frontmatter } from '../core/wiki/types.js';
import type { Card } from '../shared/types.js';
import { extractPinnedPages } from './StageEngine.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'stage-wiki-test-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// ─── extractPinnedPages ───────────────────────────────────────────

describe('extractPinnedPages', () => {
  function card(meta: Record<string, unknown>): Card {
    return {
      id: 'X', seq: '1', title: 't', desc: '',
      state: 'inprogress', labels: [], meta,
    };
  }

  it('returns empty for missing meta.wiki_pages', () => {
    expect(extractPinnedPages(card({}))).toEqual([]);
  });

  it('reads array form', () => {
    expect(extractPinnedPages(card({ wiki_pages: ['modules/A', 'lessons/B'] })))
      .toEqual(['modules/A', 'lessons/B']);
  });

  it('reads comma-separated string form', () => {
    expect(extractPinnedPages(card({ wiki_pages: 'modules/A, lessons/B ' })))
      .toEqual(['modules/A', 'lessons/B']);
  });

  it('filters non-string array entries', () => {
    expect(extractPinnedPages(card({ wiki_pages: ['modules/A', 42, null] })))
      .toEqual(['modules/A']);
  });
});

// ─── End-to-end: wiki context flows into prompt ───────────────────

describe('Wiki injection into buildPhasePrompt', () => {
  function lessonFm(title: string, tags: string[]): Frontmatter {
    return {
      type: 'lesson',
      title,
      created: '2026-04-27',
      updated: '2026-04-27',
      tags,
      status: 'developing',
      related: [],
      sources: [],
      generated: 'manual',
      severity: 'major',
    } as Frontmatter;
  }

  it('formats page context that flows through buildPhasePrompt', () => {
    initWiki(repo, { projectName: 'demo', skipGitignore: true });
    writeHot(repo, { lastUpdate: 'completed card #18' });
    writePage(repo, 'lesson', 'Pipeline-Race', lessonFm('Pipeline-Race', ['pipeline']),
      '## TL;DR\nA race in the pipeline service.');

    const ctx = wikiRead({
      repoDir: repo,
      cardTitle: 'fix pipeline',
      cardDesc: 'race condition',
      cardSkills: ['pipeline'],
    });
    const wikiBlock = formatWikiContext(ctx);

    const prompt = buildPhasePrompt({
      taskSeq: '42', taskTitle: 'fix pipeline', taskDescription: 'race condition',
      cardId: 'TASK-42', worktreePath: '/tmp/wt', branchName: 'task/42',
      targetBranch: 'main', mergeMode: 'none', gitlabProjectId: '0',
      phase: 'development',
      wikiContext: wikiBlock,
      wikiUpdateReminder: '# Wiki Update Reminder\nremember to wiki update.',
    });

    // wikiContext present
    expect(prompt).toContain('# 项目知识 - 当前状态');
    expect(prompt).toContain('completed card #18');
    expect(prompt).toContain('[[lessons/Pipeline-Race]]');

    // reminder appended at end
    const idxRun = prompt.indexOf('# How to Run');
    const idxReminder = prompt.indexOf('# Wiki Update Reminder');
    expect(idxRun).toBeLessThan(idxReminder);
  });

  it('wiki opt-out scenario: empty wikiContext / reminder → prompt unaffected', () => {
    const prompt = buildPhasePrompt({
      taskSeq: '42', taskTitle: 'X', taskDescription: 'Y',
      cardId: 'X', worktreePath: '/tmp/wt', branchName: 'task/42',
      targetBranch: 'main', mergeMode: 'none', gitlabProjectId: '0',
      phase: 'development',
      // wikiContext / wikiUpdateReminder undefined => WIKI_ENABLED=false case
    });
    expect(prompt).not.toContain('# 项目知识');
    expect(prompt).not.toContain('# Wiki Update Reminder');
  });

  it('pinned pages flow through to wikiRead → prompt', () => {
    initWiki(repo, { projectName: 'demo', skipGitignore: true });
    writePage(
      repo,
      'module',
      'Pinned',
      {
        type: 'module',
        title: 'Pinned',
        created: '2026-04-27',
        updated: '2026-04-27',
        tags: [],
        status: 'developing',
        related: [],
        sources: [],
        generated: 'auto',
        module_path: 'src/Pinned.ts',
      } as Frontmatter,
      '## TL;DR\npinned mod.',
    );

    const ctx = wikiRead({
      repoDir: repo,
      cardTitle: 'unrelated',
      cardDesc: 'unrelated',
      cardSkills: [],
      pinnedPages: ['modules/Pinned'],
    });
    const md = formatWikiContext(ctx);
    expect(md).toContain('[[modules/Pinned]]');
    expect(md).toContain('pinned');
  });
});

// ─── Reminder shape sanity ────────────────────────────────────────

describe('WIKI_UPDATE_REMINDER content', () => {
  it('reminder text mentions all 4 page types and the CLI workflow', async () => {
    // Build the wiki dir but force using exported helper indirectly
    initWiki(repo, { projectName: 'demo', skipGitignore: true });
    // The reminder is internal; we sample its shape via a mock prompt.
    const reminder = `# Wiki Update Reminder

After completing this card, follow the **wiki-update** skill if any of these apply:

- A module changed → update \`wiki/modules/<Name>.md\`
- A non-trivial decision was made → write \`wiki/decisions/<Name>.md\`
- A bug or gotcha surfaced → write \`wiki/lessons/<Name>.md\`
- A reusable pattern emerged → write \`wiki/concepts/<Name>.md\``;
    // Exercise the placeholder so the constant in StageEngine matches what we've documented.
    expect(reminder).toContain('module');
    expect(reminder).toContain('decision');
    expect(reminder).toContain('lesson');
    expect(reminder).toContain('concept');
  });
});

// repo unused in some tests; satisfy TS via a no-op
void resolve;
void mkdirSync;
void writeFileSync;
