/**
 * @module        reader.test
 * @description   wikiRead 5-layer 检索 + formatWikiContext 渲染测试
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeHot } from './hot.js';
import { writeIndex } from './index-builder.js';
import { writePage } from './page.js';
import { formatWikiContext, wikiRead } from './reader.js';
import type { Frontmatter, Page } from './types.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wiki-reader-test-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// ─── Frontmatter factories ────────────────────────────────────────

function lessonFm(overrides: Partial<Frontmatter> = {}): Frontmatter {
  return {
    type: 'lesson',
    title: 'Stop Hook Race',
    created: '2026-04-27',
    updated: '2026-04-27',
    tags: [],
    status: 'developing',
    related: [],
    sources: [],
    generated: 'manual',
    severity: 'major',
    ...overrides,
  } as Frontmatter;
}

function moduleFm(overrides: Partial<Frontmatter> = {}): Frontmatter {
  return {
    type: 'module',
    title: 'PipelineService',
    created: '2026-04-27',
    updated: '2026-04-27',
    tags: [],
    status: 'developing',
    related: [],
    sources: [],
    generated: 'auto',
    module_path: 'src/services/PipelineService.ts',
    ...overrides,
  } as Frontmatter;
}

function decisionFm(overrides: Partial<Frontmatter> = {}): Frontmatter {
  return {
    type: 'decision',
    title: 'Use Karpathy Wiki',
    created: '2026-04-27',
    updated: '2026-04-27',
    tags: [],
    status: 'developing',
    related: [],
    sources: [],
    generated: 'manual',
    ...overrides,
  } as Frontmatter;
}

function conceptFm(overrides: Partial<Frontmatter> = {}): Frontmatter {
  return {
    type: 'concept',
    title: 'BM25F',
    created: '2026-04-27',
    updated: '2026-04-27',
    tags: [],
    status: 'developing',
    related: [],
    sources: [],
    generated: 'manual',
    ...overrides,
  } as Frontmatter;
}

const TLDR_BODY = '## TL;DR\nA pipeline service.\n\n## Body\nDetails here.';

// ─── wikiRead ─────────────────────────────────────────────────────

describe('wikiRead', () => {
  describe('Layer 1: hot.md', () => {
    it('returns default template when hot.md absent', () => {
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'card',
        cardDesc: 'desc',
        cardSkills: [],
      });
      expect(ctx.hot).toContain('Hot Cache');
      expect(ctx.hot).toContain('# Recent Context');
    });

    it('returns existing hot.md content', () => {
      writeHot(repo, { lastUpdate: 'card #18 done' });
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'card',
        cardDesc: 'desc',
        cardSkills: [],
      });
      expect(ctx.hot).toContain('card #18 done');
    });
  });

  describe('Layer 2: index summary', () => {
    it('is empty when index.md absent', () => {
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'x',
        cardDesc: 'y',
        cardSkills: [],
      });
      expect(ctx.indexSummary).toBe('');
    });

    it('returns index summary when present', () => {
      writePage(repo, 'lesson', 'Stop Hook Race', lessonFm(), TLDR_BODY);
      writeIndex(repo, [
        {
          pageId: 'lessons/Stop Hook Race',
          filePath: '/x',
          frontmatter: lessonFm(),
          body: TLDR_BODY,
        },
      ]);
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'x',
        cardDesc: 'y',
        cardSkills: [],
      });
      expect(ctx.indexSummary).toContain('Lessons');
    });

    it('respects indexLines option', () => {
      writePage(repo, 'lesson', 'Stop Hook Race', lessonFm(), TLDR_BODY);
      writeIndex(repo, [
        {
          pageId: 'lessons/Stop Hook Race',
          filePath: '/x',
          frontmatter: lessonFm(),
          body: TLDR_BODY,
        },
      ]);
      const ctx = wikiRead(
        { repoDir: repo, cardTitle: 'x', cardDesc: 'y', cardSkills: [] },
        { indexLines: 3 },
      );
      const lineCount = ctx.indexSummary.split('\n').length;
      expect(lineCount).toBeLessThanOrEqual(3);
    });
  });

  describe('Layer 3: pinned pages', () => {
    it('includes explicitly pinned pages with source=pinned', () => {
      writePage(repo, 'module', 'PipelineService', moduleFm(), TLDR_BODY);
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'unrelated',
        cardDesc: 'unrelated',
        cardSkills: [],
        pinnedPages: ['modules/PipelineService'],
      });
      expect(ctx.pages).toHaveLength(1);
      expect(ctx.pages[0]?.pageId).toBe('modules/PipelineService');
      expect(ctx.pages[0]?.source).toBe('pinned');
    });

    it('skips non-existent pinned ids silently', () => {
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'x',
        cardDesc: 'y',
        cardSkills: [],
        pinnedPages: ['modules/Ghost'],
      });
      expect(ctx.pages).toHaveLength(0);
    });
  });

  describe('Layer 4: skill tag match', () => {
    it('includes pages whose tags overlap cardSkills', () => {
      writePage(
        repo,
        'lesson',
        'Pipeline Lesson',
        lessonFm({ title: 'Pipeline Lesson', tags: ['pipeline'] }),
        TLDR_BODY,
      );
      writePage(
        repo,
        'lesson',
        'Other',
        lessonFm({ title: 'Other', tags: ['frontend'] }),
        TLDR_BODY,
      );
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'unrelated',
        cardDesc: 'unrelated',
        cardSkills: ['pipeline'],
      });
      const ids = ctx.pages.map((p) => p.pageId);
      expect(ids).toContain('lessons/Pipeline Lesson');
      expect(ids).not.toContain('lessons/Other');
      const matched = ctx.pages.find((p) => p.pageId === 'lessons/Pipeline Lesson');
      expect(matched?.source).toBe('skill');
    });

    it('does nothing when cardSkills empty', () => {
      writePage(
        repo,
        'lesson',
        'Tagged',
        lessonFm({ title: 'Tagged', tags: ['x'] }),
        TLDR_BODY,
      );
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: '___',
        cardDesc: '___',
        cardSkills: [],
      });
      expect(ctx.pages).toHaveLength(0);
    });
  });

  describe('Layer 5: keyword (BM25) match', () => {
    it('matches by card title/desc against page title/body', () => {
      writePage(
        repo,
        'module',
        'PipelineService',
        moduleFm(),
        '## TL;DR\nPipeline service for stages.',
      );
      writePage(
        repo,
        'module',
        'WorkerManager',
        moduleFm({
          title: 'WorkerManager',
          module_path: 'src/services/WorkerManager.ts',
        }),
        '## TL;DR\nWorker spawning logic.',
      );
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'pipeline refactor',
        cardDesc: 'rework PipelineService',
        cardSkills: [],
      });
      const ids = ctx.pages.map((p) => p.pageId);
      expect(ids).toContain('modules/PipelineService');
      const found = ctx.pages.find((p) => p.pageId === 'modules/PipelineService');
      expect(found?.source).toBe('keyword');
    });
  });

  describe('dedup across layers', () => {
    it('pinned wins over skill', () => {
      writePage(
        repo,
        'module',
        'PipelineService',
        moduleFm({ tags: ['pipeline'] }),
        TLDR_BODY,
      );
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'x',
        cardDesc: 'y',
        cardSkills: ['pipeline'],
        pinnedPages: ['modules/PipelineService'],
      });
      const matches = ctx.pages.filter((p) => p.pageId === 'modules/PipelineService');
      expect(matches).toHaveLength(1);
      expect(matches[0]?.source).toBe('pinned');
    });

    it('skill wins over keyword', () => {
      writePage(
        repo,
        'module',
        'PipelineService',
        moduleFm({ tags: ['pipeline'] }),
        '## TL;DR\nPipeline service.',
      );
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'pipeline',
        cardDesc: 'pipeline',
        cardSkills: ['pipeline'],
      });
      const matches = ctx.pages.filter((p) => p.pageId === 'modules/PipelineService');
      expect(matches).toHaveLength(1);
      expect(matches[0]?.source).toBe('skill');
    });
  });

  describe('priority sort by type', () => {
    it('lesson outranks module', () => {
      writePage(
        repo,
        'lesson',
        'L1',
        lessonFm({ title: 'L1', tags: ['x'] }),
        '## TL;DR\nlesson body',
      );
      writePage(
        repo,
        'module',
        'M1',
        moduleFm({ title: 'M1', tags: ['x'], module_path: 'src/M1.ts' }),
        '## TL;DR\nmodule body',
      );
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'unrelated',
        cardDesc: 'unrelated',
        cardSkills: ['x'],
      });
      const ids = ctx.pages.map((p) => p.pageId);
      expect(ids.indexOf('lessons/L1')).toBeLessThan(ids.indexOf('modules/M1'));
    });

    it('decision tied with lesson; both rank above concept', () => {
      writePage(
        repo,
        'decision',
        'D1',
        decisionFm({ title: 'D1', tags: ['x'] }),
        '## TL;DR\nd',
      );
      writePage(
        repo,
        'concept',
        'C1',
        conceptFm({ title: 'C1', tags: ['x'] }),
        '## TL;DR\nc',
      );
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'q',
        cardDesc: 'q',
        cardSkills: ['x'],
      });
      const ids = ctx.pages.map((p) => p.pageId);
      expect(ids.indexOf('decisions/D1')).toBeLessThan(ids.indexOf('concepts/C1'));
    });

    it('pinned source bonus puts module above lesson if module pinned', () => {
      writePage(repo, 'module', 'M1', moduleFm({ title: 'M1' }), TLDR_BODY);
      writePage(
        repo,
        'lesson',
        'L1',
        lessonFm({ title: 'L1', tags: ['x'] }),
        TLDR_BODY,
      );
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'q',
        cardDesc: 'q',
        cardSkills: ['x'],
        pinnedPages: ['modules/M1'],
      });
      const ids = ctx.pages.map((p) => p.pageId);
      expect(ids.indexOf('modules/M1')).toBeLessThan(ids.indexOf('lessons/L1'));
    });
  });

  describe('stale page exclusion', () => {
    it('skips pages with status=stale even when pinned', () => {
      writePage(
        repo,
        'module',
        'OldThing',
        moduleFm({ title: 'OldThing', status: 'stale', module_path: 'src/Old.ts' }),
        TLDR_BODY,
      );
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'x',
        cardDesc: 'y',
        cardSkills: [],
        pinnedPages: ['modules/OldThing'],
      });
      expect(ctx.pages).toHaveLength(0);
    });

    it('skips stale page from skill match', () => {
      writePage(
        repo,
        'lesson',
        'Stale',
        lessonFm({ title: 'Stale', tags: ['x'], status: 'stale' }),
        TLDR_BODY,
      );
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'q',
        cardDesc: 'q',
        cardSkills: ['x'],
      });
      expect(ctx.pages).toHaveLength(0);
    });
  });

  describe('TL;DR extraction', () => {
    it('extracts TL;DR from page body', () => {
      writePage(
        repo,
        'lesson',
        'X',
        lessonFm({ title: 'X', tags: ['t'] }),
        '## TL;DR\nShort summary.\n\n## Body\nLong body here.',
      );
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'q',
        cardDesc: 'q',
        cardSkills: ['t'],
      });
      expect(ctx.pages[0]?.tldr).toBe('Short summary.');
    });
  });

  describe('budget enforcement', () => {
    it('cuts keyword matches first when over budget', () => {
      // 1 pinned + many keyword candidates
      writePage(
        repo,
        'module',
        'Pinned',
        moduleFm({ title: 'Pinned', module_path: 'src/Pinned.ts' }),
        TLDR_BODY,
      );
      // Long body to bias keyword search
      const longBody = '## TL;DR\npipeline pipeline pipeline pipeline pipeline.';
      for (let i = 0; i < 8; i++) {
        writePage(
          repo,
          'module',
          `K${i}`,
          moduleFm({ title: `K${i}`, module_path: `src/K${i}.ts` }),
          longBody,
        );
      }
      const ctx = wikiRead(
        {
          repoDir: repo,
          cardTitle: 'pipeline',
          cardDesc: 'pipeline',
          cardSkills: [],
          pinnedPages: ['modules/Pinned'],
        },
        { budgetTokens: 200, keywordTopN: 10 },
      );
      // Pinned must survive
      const ids = ctx.pages.map((p) => p.pageId);
      expect(ids).toContain('modules/Pinned');
    });

    it('returns no pages when hot+index already exceed budget', () => {
      // Make hot enormous
      const bigFacts = Array.from({ length: 100 }, () => 'x'.repeat(100));
      writeHot(repo, { lastUpdate: 'big', keyFacts: bigFacts });
      writePage(
        repo,
        'lesson',
        'L',
        lessonFm({ title: 'L', tags: ['t'] }),
        TLDR_BODY,
      );
      const ctx = wikiRead(
        {
          repoDir: repo,
          cardTitle: 'q',
          cardDesc: 'q',
          cardSkills: ['t'],
        },
        { budgetTokens: 100 },
      );
      expect(ctx.pages).toHaveLength(0);
    });
  });

  describe('observability', () => {
    it('returns tokensEstimate >= 0', () => {
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'x',
        cardDesc: 'y',
        cardSkills: [],
      });
      expect(ctx.tokensEstimate).toBeGreaterThanOrEqual(0);
    });

    it('tokensEstimate grows with content', () => {
      const empty = wikiRead({
        repoDir: repo,
        cardTitle: 'x',
        cardDesc: 'y',
        cardSkills: [],
      });
      writeHot(repo, {
        lastUpdate: 'a'.repeat(500),
        keyFacts: ['fact one', 'fact two', 'fact three'],
      });
      const filled = wikiRead({
        repoDir: repo,
        cardTitle: 'x',
        cardDesc: 'y',
        cardSkills: [],
      });
      expect(filled.tokensEstimate).toBeGreaterThan(empty.tokensEstimate);
    });
  });

  describe('failure isolation', () => {
    it('survives missing wiki dir entirely', () => {
      const ctx = wikiRead({
        repoDir: repo,
        cardTitle: 'x',
        cardDesc: 'y',
        cardSkills: ['s'],
        pinnedPages: ['modules/X'],
      });
      // Doesn't throw; returns hot default + empty rest
      expect(ctx.hot).toContain('Hot Cache');
      expect(ctx.pages).toEqual([]);
    });
  });
});

// ─── formatWikiContext ────────────────────────────────────────────

describe('formatWikiContext', () => {
  function makeCtx(overrides: Partial<{
    hot: string;
    indexSummary: string;
    pages: Array<{
      pageId: string;
      title: string;
      type: 'module' | 'concept' | 'decision' | 'lesson' | 'source';
      tldr: string;
      source: 'pinned' | 'skill' | 'keyword';
      priority: number;
    }>;
    tokensEstimate: number;
  }> = {}) {
    return {
      hot: '',
      indexSummary: '',
      pages: [],
      tokensEstimate: 0,
      ...overrides,
    };
  }

  it('returns empty string for empty context', () => {
    expect(formatWikiContext(makeCtx())).toBe('');
  });

  it('includes hot section with header when hot present', () => {
    const out = formatWikiContext(
      makeCtx({ hot: '---\ntype: meta\n---\n# Recent Context\nstuff' }),
    );
    expect(out).toContain('# 项目知识 - 当前状态');
    expect(out).toContain('# Recent Context');
    expect(out).toContain('stuff');
  });

  it('strips frontmatter from hot when rendering', () => {
    const out = formatWikiContext(
      makeCtx({ hot: '---\ntype: meta\nupdated: 2026-04-27\n---\n\n# Body\n' }),
    );
    expect(out).not.toContain('updated: 2026-04-27');
    expect(out).toContain('# Body');
  });

  it('includes index section when present', () => {
    const out = formatWikiContext(
      makeCtx({ indexSummary: '## Lessons (1)\n- [[lessons/X]]' }),
    );
    expect(out).toContain('# 知识地图（节选）');
    expect(out).toContain('## Lessons');
  });

  it('renders pages with source labels', () => {
    const out = formatWikiContext(
      makeCtx({
        pages: [
          {
            pageId: 'modules/A',
            title: 'A',
            type: 'module',
            tldr: 'tldr A',
            source: 'pinned',
            priority: 100,
          },
          {
            pageId: 'lessons/B',
            title: 'B',
            type: 'lesson',
            tldr: 'tldr B',
            source: 'skill',
            priority: 13,
          },
          {
            pageId: 'concepts/C',
            title: 'C',
            type: 'concept',
            tldr: 'tldr C',
            source: 'keyword',
            priority: 2,
          },
        ],
      }),
    );
    expect(out).toContain('# 与本任务相关的页');
    expect(out).toContain('[[modules/A]]');
    expect(out).toContain('pinned');
    expect(out).toContain('[[lessons/B]]');
    expect(out).toContain('via skill');
    expect(out).toContain('[[concepts/C]]');
    expect(out).toContain('via keyword');
    expect(out).toContain('TL;DR: tldr A');
  });

  it('separates sections by ---', () => {
    const out = formatWikiContext(
      makeCtx({
        hot: '---\ntype: meta\n---\nhot content',
        indexSummary: 'index content',
        pages: [
          {
            pageId: 'modules/A',
            title: 'A',
            type: 'module',
            tldr: 'tldr',
            source: 'pinned',
            priority: 100,
          },
        ],
      }),
    );
    const sepCount = (out.match(/\n---\n/g) ?? []).length;
    expect(sepCount).toBeGreaterThanOrEqual(2);
  });

  it('truncates long TL;DR to 300 chars in render', () => {
    const longTldr = 'x'.repeat(500);
    const out = formatWikiContext(
      makeCtx({
        pages: [
          {
            pageId: 'modules/A',
            title: 'A',
            type: 'module',
            tldr: longTldr,
            source: 'pinned',
            priority: 100,
          },
        ],
      }),
    );
    const tldrLine = out.split('\n').find((l) => l.startsWith('TL;DR:'))!;
    // "TL;DR: " is 7 chars; content portion 300
    expect(tldrLine.length).toBeLessThanOrEqual(7 + 300);
  });
});

// ─── Sanity helper: end-to-end smoke ───────────────────────────────

describe('wikiRead → formatWikiContext smoke', () => {
  it('writes pages, reads context, formats prompt', () => {
    writeHot(repo, {
      lastUpdate: 'completed card #18',
      keyFacts: ['Fact A'],
    });
    writePage(
      repo,
      'lesson',
      'Stop Hook Race',
      lessonFm({ title: 'Stop Hook Race', tags: ['pipeline'] }),
      '## TL;DR\nA race condition in stop hook.\n\n## Body\nDetails.',
    );
    writePage(
      repo,
      'module',
      'PipelineService',
      moduleFm(),
      '## TL;DR\nPipeline orchestration service.',
    );
    const allPages: Page[] = [
      {
        pageId: 'lessons/Stop Hook Race',
        filePath: '/x',
        frontmatter: lessonFm({ title: 'Stop Hook Race', tags: ['pipeline'] }),
        body: '## TL;DR\nA race.',
      },
      {
        pageId: 'modules/PipelineService',
        filePath: '/y',
        frontmatter: moduleFm(),
        body: '## TL;DR\nA service.',
      },
    ];
    writeIndex(repo, allPages);

    const ctx = wikiRead({
      repoDir: repo,
      cardTitle: 'fix pipeline race',
      cardDesc: 'race condition in pipeline',
      cardSkills: ['pipeline'],
    });
    const md = formatWikiContext(ctx);

    expect(md).toContain('# 项目知识 - 当前状态');
    expect(md).toContain('completed card #18');
    expect(md).toContain('# 知识地图（节选）');
    expect(md).toContain('# 与本任务相关的页');
    // Lesson should appear because of skill (pipeline tag) AND keyword
    expect(md).toContain('[[lessons/Stop Hook Race]]');
  });
});
