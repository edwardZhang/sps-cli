/**
 * @module        linter.test
 * @description   wiki check 各类 lint 测试
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkDeadLinks,
  checkFrontmatterGaps,
  checkOrphans,
  checkStaleSources,
  extractBodyWikilinks,
  findOutdatedPages,
  lintWiki,
  resolveLinkToId,
} from './linter.js';
import type { Frontmatter, Manifest, Page } from './types.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wiki-linter-test-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// ─── Page factory ─────────────────────────────────────────────────

function lessonFm(title: string, overrides: Partial<Frontmatter> = {}): Frontmatter {
  return {
    type: 'lesson',
    title,
    created: '2026-04-27',
    updated: '2026-04-27',
    tags: ['t'],
    status: 'developing',
    related: [],
    sources: [],
    generated: 'manual',
    severity: 'major',
    ...overrides,
  } as Frontmatter;
}

function makePage(
  title: string,
  body: string,
  fmOverrides: Partial<Frontmatter> = {},
): Page {
  return {
    pageId: `lessons/${title}`,
    filePath: `/x/${title}.md`,
    frontmatter: lessonFm(title, fmOverrides),
    body,
  };
}

// ─── extractBodyWikilinks ─────────────────────────────────────────

describe('extractBodyWikilinks', () => {
  it('extracts all wikilinks', () => {
    const body = 'See [[A]] and [[modules/B]] for details.';
    expect(extractBodyWikilinks(body)).toEqual(['A', 'modules/B']);
  });

  it('returns empty for body without wikilinks', () => {
    expect(extractBodyWikilinks('plain text')).toEqual([]);
  });
});

// ─── resolveLinkToId ──────────────────────────────────────────────

describe('resolveLinkToId', () => {
  it('resolves typed wikilink', () => {
    const ids = new Set(['lessons/A', 'modules/B']);
    expect(resolveLinkToId('[[lessons/A]]', ids)).toBe('lessons/A');
  });

  it('resolves bare wikilink by title match', () => {
    const ids = new Set(['lessons/A', 'modules/B']);
    expect(resolveLinkToId('[[B]]', ids)).toBe('modules/B');
  });

  it('returns null for unresolvable', () => {
    const ids = new Set(['lessons/A']);
    expect(resolveLinkToId('[[Missing]]', ids)).toBeNull();
  });

  it('returns null for malformed', () => {
    const ids = new Set(['lessons/A']);
    expect(resolveLinkToId('not a link', ids)).toBeNull();
  });
});

// ─── checkOrphans ─────────────────────────────────────────────────

describe('checkOrphans', () => {
  it('flags pages that nothing links to', () => {
    const a = makePage('A', '## TL;DR\nrefs [[B]].');
    const b = makePage('B', '## TL;DR\nstandalone.');
    const c = makePage('C', '## TL;DR\nstandalone.');
    const issues = checkOrphans([a, b, c]);
    const orphanIds = issues.map((i) => i.pageId).sort();
    expect(orphanIds).toEqual(['lessons/A', 'lessons/C']);
  });

  it('counts frontmatter related[] as references', () => {
    const a = makePage('A', '', { related: ['[[B]]'] });
    const b = makePage('B', '');
    const issues = checkOrphans([a, b]);
    const orphans = issues.map((i) => i.pageId);
    expect(orphans).toContain('lessons/A');
    expect(orphans).not.toContain('lessons/B');
  });

  it('counts body wikilinks as references', () => {
    const a = makePage('A', 'See [[lessons/B]].');
    const b = makePage('B', 'standalone.');
    const issues = checkOrphans([a, b]);
    const orphans = issues.map((i) => i.pageId);
    expect(orphans).toContain('lessons/A');
    expect(orphans).not.toContain('lessons/B');
  });

  it('all issues are warn severity', () => {
    const a = makePage('A', '');
    const issues = checkOrphans([a]);
    expect(issues.every((i) => i.severity === 'warn')).toBe(true);
  });
});

// ─── checkDeadLinks ───────────────────────────────────────────────

describe('checkDeadLinks', () => {
  it('flags frontmatter related[] dead links as error', () => {
    const a = makePage('A', '', { related: ['[[GhostPage]]'] });
    const issues = checkDeadLinks([a]);
    const errs = issues.filter((i) => i.severity === 'error');
    expect(errs.length).toBe(1);
    expect(errs[0]?.target).toBe('[[GhostPage]]');
  });

  it('flags body dead wikilinks as warn', () => {
    const a = makePage('A', 'See [[Ghost]] for details.');
    const issues = checkDeadLinks([a]);
    const warns = issues.filter((i) => i.severity === 'warn');
    expect(warns.length).toBe(1);
    expect(warns[0]?.target).toBe('Ghost');
  });

  it('does not flag valid links', () => {
    const a = makePage('A', 'See [[B]].', { related: ['[[B]]'] });
    const b = makePage('B', '');
    const issues = checkDeadLinks([a, b]);
    expect(issues).toEqual([]);
  });
});

// ─── checkFrontmatterGaps ─────────────────────────────────────────

describe('checkFrontmatterGaps', () => {
  it('flags empty title as error', () => {
    const a = makePage(' ', '## TL;DR\nx', { title: '   ' });
    const issues = checkFrontmatterGaps([a]);
    const errs = issues.filter((i) => i.severity === 'error');
    expect(errs.some((i) => i.target === 'title')).toBe(true);
  });

  it('warns on empty tags', () => {
    const a = makePage('A', '## TL;DR\nx', { tags: [] });
    const issues = checkFrontmatterGaps([a]);
    expect(issues.some((i) => i.target === 'tags' && i.severity === 'warn')).toBe(true);
  });

  it('warns when body has no TL;DR section', () => {
    const a = makePage('A', 'plain body, no tldr');
    const issues = checkFrontmatterGaps([a]);
    expect(issues.some((i) => i.target === 'body')).toBe(true);
  });

  it('does not warn on healthy page', () => {
    const a = makePage('A', '## TL;DR\nshort.', { tags: ['t'] });
    const issues = checkFrontmatterGaps([a]);
    expect(issues).toEqual([]);
  });
});

// ─── checkStaleSources ────────────────────────────────────────────

describe('checkStaleSources', () => {
  it('flags missing source files', () => {
    const manifest: Manifest = {
      version: 1,
      updated_at: 't',
      sources: {
        'src/gone.ts': {
          type: 'code',
          sha256: 'a'.repeat(64),
          ingested_at: 't',
          pages: [],
        },
      },
    };
    const issues = checkStaleSources(manifest, repo);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.target).toBe('src/gone.ts');
  });

  it('flags content drift (hash mismatch)', () => {
    mkdirSync(resolve(repo, 'src'), { recursive: true });
    writeFileSync(resolve(repo, 'src', 'a.ts'), 'new content');
    const manifest: Manifest = {
      version: 1,
      updated_at: 't',
      sources: {
        'src/a.ts': {
          type: 'code',
          sha256: 'b'.repeat(64), // wrong hash
          ingested_at: 't',
          pages: ['lessons/X'],
        },
      },
    };
    const issues = checkStaleSources(manifest, repo);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.message).toContain('changed since ingest');
    expect(issues[0]?.message).toContain('lessons/X');
  });

  it('does not flag matching hash', () => {
    mkdirSync(resolve(repo, 'src'), { recursive: true });
    writeFileSync(resolve(repo, 'src', 'a.ts'), 'content');
    // sha256 of 'content' = ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73
    const manifest: Manifest = {
      version: 1,
      updated_at: 't',
      sources: {
        'src/a.ts': {
          type: 'code',
          sha256: 'ed7002b439e9ac845f22357d822bac1444730fbdb6016d3ec9432297b9ec9f73',
          ingested_at: 't',
          pages: [],
        },
      },
    };
    const issues = checkStaleSources(manifest, repo);
    expect(issues).toEqual([]);
  });
});

// ─── lintWiki integration ─────────────────────────────────────────

describe('lintWiki', () => {
  it('aggregates and counts issues', () => {
    const a = makePage('A', '', { tags: [] }); // orphan + fm-gap (no tldr, no tags)
    const report = lintWiki({
      pages: [a],
      manifest: { version: 1, updated_at: 't', sources: {} },
      repoDir: repo,
    });
    expect(report.issues.length).toBeGreaterThan(0);
    expect(report.counts.orphan).toBeGreaterThanOrEqual(1);
    expect(report.counts['fm-gap']).toBeGreaterThanOrEqual(1);
    expect(report.warnCount).toBeGreaterThan(0);
  });
});

// ─── findOutdatedPages ────────────────────────────────────────────

describe('findOutdatedPages', () => {
  it('finds pages whose source mtime is newer than page', () => {
    // Write source and page files with controlled mtimes
    mkdirSync(resolve(repo, 'src'), { recursive: true });
    const sourcePath = resolve(repo, 'src', 'a.ts');
    const pagePath = resolve(repo, 'page.md');
    writeFileSync(sourcePath, 'new');
    writeFileSync(pagePath, 'page');

    // Page is ancient
    const oldDate = new Date('2020-01-01');
    utimesSync(pagePath, oldDate, oldDate);

    const page: Page = {
      pageId: 'lessons/A',
      filePath: pagePath,
      frontmatter: lessonFm('A'),
      body: '',
    };
    const manifest: Manifest = {
      version: 1,
      updated_at: 't',
      sources: {
        'src/a.ts': {
          type: 'code',
          sha256: 'h',
          ingested_at: 't',
          pages: ['lessons/A'],
        },
      },
    };

    const outdated = findOutdatedPages(manifest, [page], repo);
    expect(outdated).toHaveLength(1);
    expect(outdated[0]?.pageIds).toEqual(['lessons/A']);
  });

  it('skips when within threshold', () => {
    mkdirSync(resolve(repo, 'src'), { recursive: true });
    const sourcePath = resolve(repo, 'src', 'a.ts');
    const pagePath = resolve(repo, 'page.md');
    writeFileSync(sourcePath, 'x');
    writeFileSync(pagePath, 'y');
    const page: Page = {
      pageId: 'lessons/A',
      filePath: pagePath,
      frontmatter: lessonFm('A'),
      body: '',
    };
    const manifest: Manifest = {
      version: 1,
      updated_at: 't',
      sources: {
        'src/a.ts': {
          type: 'code',
          sha256: 'h',
          ingested_at: 't',
          pages: ['lessons/A'],
        },
      },
    };
    const outdated = findOutdatedPages(manifest, [page], repo, 60_000);
    expect(outdated).toEqual([]);
  });
});
