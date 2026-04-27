/**
 * @module        searcher.test
 * @description   BM25F searcher 测试
 */
import { describe, expect, it } from 'vitest';
import {
  extractTLDR,
  type IndexedDoc,
  pageToIndexed,
  tokenize,
  WikiSearcher,
} from './searcher.js';
import type { Page } from './types.js';

// ─── Tokenizer ────────────────────────────────────────────────────

describe('tokenize', () => {
  it('splits ascii words and lowercases', () => {
    expect(tokenize('Pipeline Service')).toEqual(['pipeline', 'service']);
  });

  it('removes stop words', () => {
    expect(tokenize('the pipeline is broken')).toEqual(['pipeline', 'broken']);
  });

  it('keeps tokens with - and _', () => {
    expect(tokenize('stop_hook race-condition')).toEqual(['stop_hook', 'race-condition']);
  });

  it('keeps Chinese chars as individual tokens', () => {
    expect(tokenize('知识库')).toEqual(['知', '识', '库']);
  });

  it('removes Chinese stop words', () => {
    // 的 / 是 / 了 are stop words
    expect(tokenize('知识库的实现')).toEqual(['知', '识', '库', '实', '现']);
  });

  it('handles mixed ascii + chinese', () => {
    expect(tokenize('Pipeline 服务的实现')).toEqual([
      'pipeline',
      '服',
      '务',
      '实',
      '现',
    ]);
  });

  it('rejects single-char ascii tokens', () => {
    expect(tokenize('a b c d')).toEqual([]);
  });

  it('handles empty / whitespace', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('   ')).toEqual([]);
  });
});

// ─── extractTLDR ──────────────────────────────────────────────────

describe('extractTLDR', () => {
  it('extracts content between ## TL;DR and next ##', () => {
    const body = `## TL;DR
This is the summary.

## Body
More details.`;
    expect(extractTLDR(body)).toBe('This is the summary.');
  });

  it('handles TL;DR at end of body', () => {
    const body = `## TL;DR
Final summary line.
`;
    expect(extractTLDR(body)).toBe('Final summary line.');
  });

  it('falls back to first paragraph if no TL;DR section', () => {
    const body = `First paragraph here.
With multiple lines.

Second paragraph.`;
    expect(extractTLDR(body)).toBe('First paragraph here.\nWith multiple lines.');
  });

  it('truncates long fallback to 200 chars', () => {
    const body = 'a'.repeat(300);
    expect(extractTLDR(body)).toHaveLength(200);
  });
});

// ─── BM25F searcher ───────────────────────────────────────────────

function makeDoc(opts: {
  pageId: string;
  title?: string;
  tags?: string[];
  tldr?: string;
  body?: string;
}): IndexedDoc {
  return {
    pageId: opts.pageId,
    title: opts.title ?? '',
    tags: opts.tags ?? [],
    tldr: opts.tldr ?? '',
    body: opts.body ?? '',
    type: 'lesson',
  };
}

describe('WikiSearcher.search', () => {
  it('returns empty for empty corpus', () => {
    const s = new WikiSearcher([]);
    expect(s.search('anything')).toEqual([]);
  });

  it('returns empty for empty query', () => {
    const s = new WikiSearcher([makeDoc({ pageId: 'a', body: 'hello' })]);
    expect(s.search('')).toEqual([]);
  });

  it('finds doc with matching term', () => {
    const s = new WikiSearcher([
      makeDoc({ pageId: 'a', title: 'Pipeline service', body: 'about pipeline' }),
      makeDoc({ pageId: 'b', title: 'Worker manager', body: 'about workers' }),
    ]);
    const results = s.search('pipeline');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.pageId).toBe('a');
  });

  it('ranks docs by relevance', () => {
    const s = new WikiSearcher([
      makeDoc({ pageId: 'much', title: 'pipeline pipeline pipeline', body: 'pipeline' }),
      makeDoc({ pageId: 'little', title: 'foo', body: 'pipeline' }),
    ]);
    const results = s.search('pipeline');
    expect(results[0]?.pageId).toBe('much');
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('title weight beats body weight', () => {
    const s = new WikiSearcher([
      makeDoc({ pageId: 'title-hit', title: 'race condition' }),
      makeDoc({
        pageId: 'body-hit',
        title: 'foo',
        body: 'race condition mentioned here in body only',
      }),
    ]);
    const results = s.search('race condition');
    expect(results[0]?.pageId).toBe('title-hit');
  });

  it('limits results', () => {
    const docs = Array.from({ length: 20 }, (_, i) =>
      makeDoc({ pageId: `doc${i}`, body: 'pipeline' }),
    );
    const s = new WikiSearcher(docs);
    expect(s.search('pipeline', 5)).toHaveLength(5);
  });

  it('multi-term query: each match contributes', () => {
    const s = new WikiSearcher([
      makeDoc({ pageId: 'both', title: 'pipeline service' }),
      makeDoc({ pageId: 'pipe-only', title: 'pipeline' }),
      makeDoc({ pageId: 'svc-only', title: 'service' }),
    ]);
    const results = s.search('pipeline service');
    expect(results[0]?.pageId).toBe('both');
  });

  it('handles tags as searchable field', () => {
    const s = new WikiSearcher([
      makeDoc({ pageId: 'tagged', tags: ['frontend', 'react'], body: 'something' }),
      makeDoc({ pageId: 'untagged', tags: [], body: 'something' }),
    ]);
    const results = s.search('frontend');
    expect(results[0]?.pageId).toBe('tagged');
  });

  it('returns no result for term not in corpus', () => {
    const s = new WikiSearcher([makeDoc({ pageId: 'a', body: 'hello world' })]);
    expect(s.search('xenomorph')).toEqual([]);
  });
});

describe('WikiSearcher.searchByTags', () => {
  it('returns docs whose tags overlap with query tags', () => {
    const s = new WikiSearcher([
      makeDoc({ pageId: 'a', tags: ['python', 'backend'] }),
      makeDoc({ pageId: 'b', tags: ['frontend'] }),
      makeDoc({ pageId: 'c', tags: ['python'] }),
    ]);
    const results = s.searchByTags(['python']);
    const ids = results.map((r) => r.pageId).sort();
    expect(ids).toEqual(['a', 'c']);
  });

  it('ranks higher overlap first', () => {
    const s = new WikiSearcher([
      makeDoc({ pageId: 'two', tags: ['python', 'backend'] }),
      makeDoc({ pageId: 'one', tags: ['python', 'frontend'] }),
    ]);
    const results = s.searchByTags(['python', 'backend']);
    expect(results[0]?.pageId).toBe('two');
  });

  it('case-insensitive', () => {
    const s = new WikiSearcher([makeDoc({ pageId: 'a', tags: ['Python'] })]);
    expect(s.searchByTags(['python'])).toHaveLength(1);
  });

  it('returns empty for empty tag query', () => {
    const s = new WikiSearcher([makeDoc({ pageId: 'a', tags: ['x'] })]);
    expect(s.searchByTags([])).toEqual([]);
  });
});

describe('WikiSearcher.byType', () => {
  it('filters docs by type', () => {
    const s = new WikiSearcher([
      { ...makeDoc({ pageId: 'a' }), type: 'module' },
      { ...makeDoc({ pageId: 'b' }), type: 'lesson' },
      { ...makeDoc({ pageId: 'c' }), type: 'module' },
    ]);
    expect(s.byType('module').map((d) => d.pageId).sort()).toEqual(['a', 'c']);
    expect(s.byType('lesson').map((d) => d.pageId)).toEqual(['b']);
  });
});

describe('pageToIndexed', () => {
  it('converts Page to IndexedDoc', () => {
    const page: Page = {
      pageId: 'lessons/Stop Hook Race',
      filePath: '/x',
      frontmatter: {
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
      },
      body: '## TL;DR\nA race condition.\n\n## Body\nDetails.',
    };
    const doc = pageToIndexed(page);
    expect(doc.title).toBe('Stop Hook Race');
    expect(doc.tags).toEqual(['pipeline']);
    expect(doc.tldr).toBe('A race condition.');
    expect(doc.type).toBe('lesson');
  });
});
