/**
 * @module        hot.test
 * @description   hot.md cache 测试
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wikiDir, wikiHotFile } from '../../shared/wikiPaths.js';
import { readHot, renderHot, writeHot } from './hot.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wiki-hot-test-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('readHot', () => {
  it('returns default template when file missing', () => {
    const content = readHot(repo);
    expect(content).toContain('Hot Cache');
    expect(content).toContain('# Recent Context');
    expect(content).toContain('1970-01-01');
  });

  it('returns existing content when file present', () => {
    mkdirSync(wikiDir(repo), { recursive: true });
    writeFileSync(wikiHotFile(repo), '---\ntype: meta\ntitle: Hot Cache\nupdated: 2026-04-27T10:00:00Z\n---\n\n# Custom\n');
    const content = readHot(repo);
    expect(content).toContain('# Custom');
  });
});

describe('renderHot', () => {
  it('produces valid markdown with frontmatter', () => {
    const out = renderHot({
      lastUpdate: '2026-04-27 — completed card #18',
      keyFacts: ['Fact 1', 'Fact 2'],
      recentChanges: ['[[modules/PipelineService]] updated'],
      activeThreads: ['Wiki MVP in progress'],
    });
    expect(out).toMatch(/^---\n/);
    expect(out).toContain('type: meta');
    expect(out).toContain('title: Hot Cache');
    expect(out).toContain('# Recent Context');
    expect(out).toContain('## Last Updated');
    expect(out).toContain('completed card #18');
    expect(out).toContain('- Fact 1');
    expect(out).toContain('- Fact 2');
    expect(out).toContain('[[modules/PipelineService]]');
    expect(out).toContain('Wiki MVP in progress');
  });

  it('shows "(none)" for empty lists', () => {
    const out = renderHot({ lastUpdate: 'something' });
    expect(out).toContain('（none）');
  });

  it('uses now() for updatedAt when not provided', () => {
    const before = Date.now();
    const out = renderHot({ lastUpdate: 'x' });
    const tsMatch = out.match(/updated: (\S+)/);
    expect(tsMatch).not.toBeNull();
    const ts = new Date(tsMatch![1]!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
  });

  it('warns when content exceeds soft limit', () => {
    const longFact = 'A'.repeat(5000);
    const out = renderHot({
      lastUpdate: 'x',
      keyFacts: [longFact],
    });
    expect(out).toContain('soft limit');
  });

  it('hard truncates beyond hard cap', () => {
    const longFact = 'A'.repeat(20_000);
    const out = renderHot({
      lastUpdate: 'x',
      keyFacts: [longFact],
    });
    expect(out.length).toBeLessThan(9_000);
    expect(out).toContain('truncated to hard cap');
  });
});

describe('writeHot', () => {
  it('writes hot.md to wiki/.hot.md', () => {
    writeHot(repo, { lastUpdate: 'completed card #1' });
    const written = readFileSync(wikiHotFile(repo), 'utf-8');
    expect(written).toContain('completed card #1');
  });

  it('creates wiki dir if missing', () => {
    writeHot(repo, { lastUpdate: 'x' });
    // 不应抛
  });

  it('overwrites existing content (cache, not journal)', () => {
    writeHot(repo, { lastUpdate: 'first' });
    writeHot(repo, { lastUpdate: 'second' });
    const content = readFileSync(wikiHotFile(repo), 'utf-8');
    expect(content).toContain('second');
    expect(content).not.toContain('first');
  });
});
