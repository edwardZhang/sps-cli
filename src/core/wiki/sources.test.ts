/**
 * @module        sources.test
 * @description   sources discovery + diff 测试
 */
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wikiMetaFile } from '../../shared/wikiPaths.js';
import { initWiki } from './scaffold.js';
import {
  diffAgainstManifest,
  discoverSources,
  expandPattern,
  parsePattern,
  readSourcesConfig,
} from './sources.js';
import type { Manifest } from './types.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wiki-sources-test-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

// ─── Helpers ──────────────────────────────────────────────────────

function writeFile(path: string, body = ''): void {
  const abs = resolve(repo, path);
  const dir = abs.split('/').slice(0, -1).join('/');
  if (dir) mkdirSync(dir, { recursive: true });
  writeFileSync(abs, body, 'utf-8');
}

// ─── parsePattern ─────────────────────────────────────────────────

describe('parsePattern', () => {
  it('handles "src/**/*.ts"', () => {
    const p = parsePattern('src/**/*.ts');
    expect(p.recursive).toBe(true);
    expect(p.extension).toBe('.ts');
    expect(p.base).toBe('src');
  });

  it('handles "src/**"', () => {
    const p = parsePattern('src/**');
    expect(p.recursive).toBe(true);
    expect(p.extension).toBe('');
    expect(p.base).toBe('src');
  });

  it('handles "docs/*.md"', () => {
    const p = parsePattern('docs/*.md');
    expect(p.recursive).toBe(false);
    expect(p.extension).toBe('.md');
    expect(p.base).toBe('docs');
  });

  it('handles literal file', () => {
    const p = parsePattern('README.md');
    expect(p.recursive).toBe(false);
    expect(p.extension).toBe('');
    expect(p.base).toBe('README.md');
  });
});

// ─── expandPattern ────────────────────────────────────────────────

describe('expandPattern', () => {
  it('expands recursive .ts pattern', () => {
    writeFile('src/a.ts', 'a');
    writeFile('src/sub/b.ts', 'b');
    writeFile('src/sub/c.txt', 'c');
    const out = expandPattern(repo, 'src/**/*.ts').sort();
    expect(out).toEqual(['src/a.ts', 'src/sub/b.ts']);
  });

  it('expands non-recursive ext pattern', () => {
    writeFile('docs/a.md', 'a');
    writeFile('docs/sub/b.md', 'b');
    const out = expandPattern(repo, 'docs/*.md');
    expect(out).toEqual(['docs/a.md']);
  });

  it('matches literal file', () => {
    writeFile('README.md', 'r');
    const out = expandPattern(repo, 'README.md');
    expect(out).toEqual(['README.md']);
  });

  it('returns empty when base missing', () => {
    expect(expandPattern(repo, 'nope/*.ts')).toEqual([]);
  });

  it('skips node_modules / .git / dist', () => {
    writeFile('src/keep.ts', 'k');
    writeFile('node_modules/x.ts', 'x');
    writeFile('.git/HEAD', 'g');
    writeFile('dist/out.ts', 'd');
    const out = expandPattern(repo, 'src/**/*.ts');
    expect(out).toEqual(['src/keep.ts']);
  });

  it('skips dotfiles by default', () => {
    writeFile('src/a.ts', 'a');
    writeFile('src/.secret.ts', 's');
    const out = expandPattern(repo, 'src/**/*.ts');
    expect(out).toEqual(['src/a.ts']);
  });

  it('allows dotfiles when base starts with dot', () => {
    writeFile('wiki/.raw/note.md', 'n');
    const out = expandPattern(repo, 'wiki/.raw/**/*.md');
    expect(out).toEqual(['wiki/.raw/note.md']);
  });
});

// ─── readSourcesConfig ────────────────────────────────────────────

describe('readSourcesConfig', () => {
  it('returns empty config when WIKI.md missing', () => {
    const cfg = readSourcesConfig(repo);
    expect(cfg.code).toEqual([]);
    expect(cfg.doc).toEqual([]);
    expect(cfg.raw).toEqual([]);
  });

  it('parses sources from WIKI.md frontmatter', () => {
    initWiki(repo, { projectName: 'demo', skipGitignore: true });
    const cfg = readSourcesConfig(repo);
    expect(cfg.code).toContain('src/**/*.ts');
    expect(cfg.doc).toContain('docs/**/*.md');
    expect(cfg.raw).toContain('wiki/.raw/**/*');
  });

  it('handles malformed yaml gracefully', () => {
    mkdirSync(resolve(repo, 'wiki'), { recursive: true });
    writeFileSync(wikiMetaFile(repo), '---\n  bad: : yaml ::\n---\nbody', 'utf-8');
    expect(() => readSourcesConfig(repo)).not.toThrow();
  });
});

// ─── discoverSources ──────────────────────────────────────────────

describe('discoverSources', () => {
  it('returns empty when no sources defined', () => {
    const out = discoverSources(repo);
    expect(out.sources).toEqual([]);
  });

  it('discovers files matching configured patterns', () => {
    initWiki(repo, { projectName: 'demo', skipGitignore: true });
    writeFile('src/a.ts', 'a');
    writeFile('src/sub/b.ts', 'b');
    writeFile('docs/x.md', 'x');
    writeFile('README.md', 'r');

    const out = discoverSources(repo);
    const paths = out.sources.map((s) => s.path).sort();
    expect(paths).toContain('src/a.ts');
    expect(paths).toContain('src/sub/b.ts');
    expect(paths).toContain('docs/x.md');
    expect(paths).toContain('README.md');
  });

  it('reports empty patterns', () => {
    initWiki(repo, { projectName: 'demo', skipGitignore: true });
    // No source files match any pattern
    const out = discoverSources(repo);
    expect(out.emptyPatterns.length).toBeGreaterThan(0);
  });

  it('hashes are sha256 hex (64 chars)', () => {
    initWiki(repo, { projectName: 'demo', skipGitignore: true });
    writeFile('src/a.ts', 'hello world');
    const out = discoverSources(repo);
    const file = out.sources.find((s) => s.path === 'src/a.ts');
    expect(file?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('dedups across buckets (code wins)', () => {
    // Configure raw to overlap with code
    initWiki(repo, { projectName: 'demo', skipGitignore: true });
    // overwrite WIKI.md with overlapping patterns
    writeFileSync(
      wikiMetaFile(repo),
      '---\ntype: meta\ntitle: x\nversion: 1\ncreated: 2026-04-27\nupdated: 2026-04-27\nsources:\n  code:\n    - "shared/**/*.ts"\n  raw:\n    - "shared/**/*.ts"\n---\n',
      'utf-8',
    );
    writeFile('shared/a.ts', 'x');
    const out = discoverSources(repo);
    const file = out.sources.find((s) => s.path === 'shared/a.ts');
    expect(file?.category).toBe('code');
  });

  it('sorts results stably by path', () => {
    initWiki(repo, { projectName: 'demo', skipGitignore: true });
    writeFile('src/z.ts', 'z');
    writeFile('src/a.ts', 'a');
    writeFile('src/m.ts', 'm');
    const out = discoverSources(repo);
    const codePaths = out.sources
      .filter((s) => s.category === 'code')
      .map((s) => s.path);
    expect(codePaths).toEqual([...codePaths].sort());
  });
});

// ─── diffAgainstManifest ──────────────────────────────────────────

describe('diffAgainstManifest', () => {
  const emptyManifest: Manifest = {
    version: 1,
    updated_at: '2026-04-27T00:00:00Z',
    sources: {},
  };

  it('treats all as added when manifest empty', () => {
    const diff = diffAgainstManifest(
      [
        { path: 'a.ts', category: 'code', hash: 'h1' },
        { path: 'b.ts', category: 'code', hash: 'h2' },
      ],
      emptyManifest,
    );
    expect(diff.added.sort()).toEqual(['a.ts', 'b.ts']);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('detects changed by hash', () => {
    const manifest: Manifest = {
      version: 1,
      updated_at: '2026-04-27T00:00:00Z',
      sources: {
        'a.ts': { type: 'code', sha256: 'h-old', ingested_at: '2026-04-26T00:00:00Z', pages: [] },
      },
    };
    const diff = diffAgainstManifest(
      [{ path: 'a.ts', category: 'code', hash: 'h-new' }],
      manifest,
    );
    expect(diff.changed).toEqual(['a.ts']);
    expect(diff.added).toEqual([]);
  });

  it('detects removed', () => {
    const manifest: Manifest = {
      version: 1,
      updated_at: 't',
      sources: {
        'gone.ts': { type: 'code', sha256: 'h', ingested_at: 't', pages: [] },
      },
    };
    const diff = diffAgainstManifest([], manifest);
    expect(diff.removed).toEqual(['gone.ts']);
  });

  it('detects unchanged when hash matches', () => {
    const manifest: Manifest = {
      version: 1,
      updated_at: 't',
      sources: {
        'a.ts': { type: 'code', sha256: 'h1', ingested_at: 't', pages: [] },
      },
    };
    const diff = diffAgainstManifest(
      [{ path: 'a.ts', category: 'code', hash: 'h1' }],
      manifest,
    );
    expect(diff.unchanged).toEqual(['a.ts']);
  });

  it('skips sources without hash', () => {
    const diff = diffAgainstManifest(
      [{ path: 'a.ts', category: 'code' }],
      emptyManifest,
    );
    expect(diff.added).toEqual([]);
  });
});
