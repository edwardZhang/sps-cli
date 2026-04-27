/**
 * @module        page.test
 * @description   Wiki page CRUD 测试
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wikiPageDir, wikiPageFile } from '../../shared/wikiPaths.js';
import {
  deletePage,
  findPageByWikilink,
  getPageById,
  listPages,
  listValidPages,
  readPage,
  resolvePageId,
  tryReadPage,
  writePage,
} from './page.js';
import type { Frontmatter } from './types.js';

let repo: string;

const lessonFm: Frontmatter = {
  type: 'lesson',
  title: 'Stop Hook Race',
  created: '2026-04-27',
  updated: '2026-04-27',
  tags: ['pipeline', 'race-condition'],
  status: 'developing',
  related: ['[[modules/PipelineService]]'],
  sources: [{ commit: 'abc123' }],
  generated: 'manual',
  severity: 'major',
};

const moduleFm: Frontmatter = {
  type: 'module',
  title: 'PipelineService',
  created: '2026-04-27',
  updated: '2026-04-27',
  tags: ['pipeline'],
  status: 'mature',
  related: [],
  sources: [{ path: 'src/services/PipelineService.ts' }],
  generated: 'auto',
  module_path: 'src/services/PipelineService.ts',
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wiki-page-test-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('writePage / readPage round-trip', () => {
  it('writes a lesson and reads it back identical', () => {
    const filePath = writePage(repo, 'lesson', 'Stop Hook Race', lessonFm, '## TL;DR\n\nA race.');
    expect(filePath).toBe(wikiPageFile(repo, 'lesson', 'Stop Hook Race'));

    const read = readPage(filePath);
    expect(read).not.toBeNull();
    expect(read?.frontmatter.type).toBe('lesson');
    expect(read?.frontmatter.title).toBe('Stop Hook Race');
    expect(read?.body).toContain('## TL;DR');
    expect(read?.pageId).toBe('lessons/Stop Hook Race');
  });

  it('writes a module and reads it back', () => {
    const filePath = writePage(repo, 'module', 'PipelineService', moduleFm, '## TL;DR\nstart 4 steps.');
    const read = readPage(filePath);
    expect(read?.pageId).toBe('modules/PipelineService');
    if (read?.frontmatter.type === 'module') {
      expect(read.frontmatter.module_path).toBe('src/services/PipelineService.ts');
    }
  });

  it('writePage creates parent dirs if missing', () => {
    // 第一次写时 modules/ 目录不存在
    expect(() =>
      writePage(repo, 'module', 'X', moduleFm, 'body'),
    ).not.toThrow();
  });

  it('throws when type doesnt match frontmatter.type', () => {
    expect(() =>
      writePage(repo, 'module', 'Foo', lessonFm, 'body'),
    ).toThrow(/type mismatch/);
  });

  it('returns null when reading non-existent file', () => {
    expect(readPage(join(repo, 'wiki/lessons/Nonexistent.md'))).toBeNull();
  });
});

describe('tryReadPage', () => {
  it('returns null for missing file', () => {
    expect(tryReadPage(join(repo, 'wiki/lessons/X.md'))).toBeNull();
  });

  it('returns ok=true on valid page', () => {
    const fp = writePage(repo, 'lesson', 'X', lessonFm, 'body');
    const r = tryReadPage(fp);
    expect(r?.ok).toBe(true);
  });

  it('returns ok=false on broken frontmatter (does NOT throw)', () => {
    // 手动写一个坏 frontmatter
    const fp = wikiPageFile(repo, 'lesson', 'Broken');
    mkdirSync(wikiPageDir(repo, 'lesson'), { recursive: true });
    writeFileSync(fp, 'no frontmatter at all\njust text\n');
    const r = tryReadPage(fp);
    expect(r?.ok).toBe(false);
    if (r && !r.ok) {
      expect(r.filePath).toBe(fp);
      expect(r.error.message).toMatch(/[Nn]o frontmatter/);
    }
  });
});

describe('listPages', () => {
  it('returns empty array when wiki dir does not exist', () => {
    expect(listPages(repo)).toEqual([]);
  });

  it('lists multiple pages across types', () => {
    writePage(repo, 'lesson', 'L1', lessonFm, 'body');
    writePage(repo, 'lesson', 'L2', lessonFm, 'body');
    writePage(repo, 'module', 'M1', moduleFm, 'body');

    const pages = listValidPages(repo);
    expect(pages).toHaveLength(3);
    const ids = pages.map((p) => p.pageId).sort();
    expect(ids).toEqual(['lessons/L1', 'lessons/L2', 'modules/M1']);
  });

  it('filters by type', () => {
    writePage(repo, 'lesson', 'L1', lessonFm, 'body');
    writePage(repo, 'module', 'M1', moduleFm, 'body');

    const lessons = listValidPages(repo, { types: ['lesson'] });
    expect(lessons.map((p) => p.frontmatter.type)).toEqual(['lesson']);
  });

  it('skips _index.md and other underscore-prefixed files', () => {
    writePage(repo, 'lesson', 'Real', lessonFm, 'body');
    // 写一个 _index.md
    const indexFile = resolve(wikiPageDir(repo, 'lesson'), '_index.md');
    writeFileSync(indexFile, '## index\nstuff\n');

    const pages = listValidPages(repo);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.pageId).toBe('lessons/Real');
  });

  it('skips non-md files', () => {
    writePage(repo, 'lesson', 'Real', lessonFm, 'body');
    const txtFile = resolve(wikiPageDir(repo, 'lesson'), 'note.txt');
    writeFileSync(txtFile, 'just a text file');

    const pages = listValidPages(repo);
    expect(pages).toHaveLength(1);
  });

  it('default skips broken pages, includeFailures=true exposes them', () => {
    writePage(repo, 'lesson', 'Good', lessonFm, 'body');
    const badFp = wikiPageFile(repo, 'lesson', 'Bad');
    mkdirSync(wikiPageDir(repo, 'lesson'), { recursive: true });
    writeFileSync(badFp, 'no frontmatter');

    const valid = listValidPages(repo);
    expect(valid).toHaveLength(1);
    expect(valid[0]?.pageId).toBe('lessons/Good');

    const all = listPages(repo, { includeFailures: true });
    expect(all).toHaveLength(2);
    const failures = all.filter((r) => !r.ok);
    expect(failures).toHaveLength(1);
  });
});

describe('getPageById', () => {
  it('finds existing page by id', () => {
    writePage(repo, 'lesson', 'X Bug', lessonFm, 'body');
    const p = getPageById(repo, 'lessons/X Bug');
    expect(p?.frontmatter.title).toBe('Stop Hook Race');
  });

  it('returns null for unknown id', () => {
    expect(getPageById(repo, 'lessons/Nonexistent')).toBeNull();
  });

  it('returns null for malformed id (no slash)', () => {
    expect(getPageById(repo, 'just-text')).toBeNull();
  });

  it('returns null for unknown type prefix', () => {
    expect(getPageById(repo, 'foos/Bar')).toBeNull();
  });
});

describe('findPageByWikilink', () => {
  it('finds by full wikilink with type prefix', () => {
    writePage(repo, 'lesson', 'X', lessonFm, 'body');
    const p = findPageByWikilink(repo, '[[lessons/X]]');
    expect(p?.pageId).toBe('lessons/X');
  });

  it('finds by title-only wikilink (scans all types)', () => {
    writePage(repo, 'module', 'PipelineService', moduleFm, 'body');
    const p = findPageByWikilink(repo, '[[PipelineService]]');
    expect(p?.pageId).toBe('modules/PipelineService');
  });

  it('returns null when wikilink does not match any page', () => {
    expect(findPageByWikilink(repo, '[[Nothing]]')).toBeNull();
  });
});

describe('deletePage', () => {
  it('deletes existing page returns true', () => {
    writePage(repo, 'lesson', 'X', lessonFm, 'body');
    expect(deletePage(repo, 'lesson', 'X')).toBe(true);
    expect(getPageById(repo, 'lessons/X')).toBeNull();
  });

  it('returns false for non-existing page', () => {
    expect(deletePage(repo, 'lesson', 'Nonexistent')).toBe(false);
  });
});

describe('resolvePageId', () => {
  it('resolves page file path back to id', () => {
    const fp = writePage(repo, 'lesson', 'Stop Hook Race', lessonFm, 'body');
    const r = resolvePageId(repo, fp);
    expect(r).toEqual({
      type: 'lesson',
      title: 'Stop Hook Race',
      pageId: 'lessons/Stop Hook Race',
    });
  });

  it('returns null for non-page paths', () => {
    expect(resolvePageId(repo, join(repo, 'wiki/index.md'))).toBeNull();
  });
});
