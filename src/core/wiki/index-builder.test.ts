/**
 * @module        index-builder.test
 * @description   index.md 渲染测试
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readIndexSummary, renderIndex, writeIndex } from './index-builder.js';
import { writePage } from './page.js';
import type { Frontmatter, Page } from './types.js';

let repo: string;

const lessonFm: Frontmatter = {
  type: 'lesson',
  title: 'Stop Hook Race',
  created: '2026-04-27',
  updated: '2026-04-27',
  tags: ['pipeline'],
  status: 'developing',
  related: [],
  sources: [],
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
  sources: [],
  generated: 'auto',
  module_path: 'src/services/PipelineService.ts',
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wiki-index-test-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function makePage(fm: Frontmatter, body: string): Page {
  return {
    pageId: `${fm.type}s/${fm.title}`,
    filePath: '/x',
    frontmatter: fm,
    body,
  };
}

describe('renderIndex', () => {
  it('handles empty corpus', () => {
    const out = renderIndex([]);
    expect(out).toContain('# Wiki Index');
    expect(out).toContain('Pages: 0');
    expect(out).toContain('empty');
  });

  it('groups pages by type', () => {
    const out = renderIndex([
      makePage(lessonFm, '## TL;DR\nA race condition.'),
      makePage(moduleFm, '## TL;DR\nA service.'),
    ]);
    expect(out).toContain('## Modules (1)');
    expect(out).toContain('## Lessons (1)');
    expect(out).toContain('[[modules/PipelineService]]');
    expect(out).toContain('[[lessons/Stop Hook Race]]');
  });

  it('orders sections by SECTIONS array (modules → concepts → decisions → lessons → sources)', () => {
    const lessonPage = makePage(lessonFm, 'TL;DR');
    const modulePage = makePage(moduleFm, 'TL;DR');
    const out = renderIndex([lessonPage, modulePage]);
    const idxModules = out.indexOf('## Modules');
    const idxLessons = out.indexOf('## Lessons');
    expect(idxModules).toBeLessThan(idxLessons);
  });

  it('renders TL;DR snippet inline', () => {
    const page = makePage(lessonFm, '## TL;DR\nQuick summary here.\n\n## Body\nDetails.');
    const out = renderIndex([page]);
    expect(out).toContain('Quick summary here.');
  });

  it('truncates long TL;DR', () => {
    const longTldr = '## TL;DR\n' + 'word '.repeat(100);
    const page = makePage(lessonFm, longTldr);
    const out = renderIndex([page]);
    // 应包含截断符
    expect(out).toContain('…');
  });

  it('sorts pages within section by title', () => {
    const a = makePage({ ...lessonFm, title: 'Apple' }, 'TL;DR');
    const z = makePage({ ...lessonFm, title: 'Zebra' }, 'TL;DR');
    const out = renderIndex([z, a]);
    const idxA = out.indexOf('Apple');
    const idxZ = out.indexOf('Zebra');
    expect(idxA).toBeLessThan(idxZ);
  });
});

describe('writeIndex', () => {
  it('writes index.md to repo/wiki/', () => {
    writeIndex(repo, [makePage(lessonFm, 'TL;DR\nfoo')]);
    const summary = readIndexSummary(repo);
    expect(summary).toContain('## Lessons');
  });

  it('creates wiki dir if missing', () => {
    writeIndex(repo, []);
    // 不应抛
  });
});

describe('readIndexSummary', () => {
  it('returns empty when index.md missing', () => {
    expect(readIndexSummary(repo)).toBe('');
  });

  it('strips frontmatter', () => {
    writePage(repo, 'lesson', 'X', lessonFm, 'TL;DR');
    writePage(repo, 'lesson', 'Y', lessonFm, 'TL;DR');
    writeIndex(repo, [makePage(lessonFm, 'TL;DR')]);
    const summary = readIndexSummary(repo);
    expect(summary).not.toContain('---');
    expect(summary).not.toContain('updated:');
  });

  it('caps at maxLines', () => {
    // 生成 100 个 page 测截断
    const pages: Page[] = [];
    for (let i = 0; i < 100; i++) {
      pages.push(
        makePage({ ...lessonFm, title: `Lesson ${String(i).padStart(3, '0')}` }, 'TL;DR'),
      );
    }
    writeIndex(repo, pages);
    const summary = readIndexSummary(repo, 10);
    const lineCount = summary.split('\n').length;
    expect(lineCount).toBeLessThanOrEqual(10);
  });
});
