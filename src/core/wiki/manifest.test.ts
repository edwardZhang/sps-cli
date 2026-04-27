/**
 * @module        manifest.test
 * @description   Wiki manifest（hash 增量索引）测试
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  diffSources,
  hashFile,
  isSourceStale,
  readManifest,
  recordIngest,
  removeFromManifest,
  tryHashFile,
  writeManifest,
} from './manifest.js';
import { EMPTY_MANIFEST, type Manifest } from './types.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wiki-manifest-test-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('hashFile', () => {
  it('produces deterministic sha256 hex', () => {
    const f = join(dir, 'test.txt');
    writeFileSync(f, 'hello world');
    const h1 = hashFile(f);
    const h2 = hashFile(f);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
    // 已知 sha256 of "hello world"
    expect(h1).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('throws on missing file', () => {
    expect(() => hashFile(join(dir, 'nonexistent'))).toThrow();
  });

  it('tryHashFile returns null on missing', () => {
    expect(tryHashFile(join(dir, 'nonexistent'))).toBeNull();
  });
});

describe('readManifest / writeManifest', () => {
  it('reads empty manifest when file missing', () => {
    const path = join(dir, '.manifest.json');
    expect(readManifest(path)).toEqual(EMPTY_MANIFEST);
  });

  it('round-trips a manifest', () => {
    const path = join(dir, '.manifest.json');
    const manifest: Manifest = {
      version: 1,
      updated_at: '2026-04-27T10:00:00Z',
      sources: {
        'src/foo.ts': {
          type: 'code',
          sha256: 'a'.repeat(64),
          ingested_at: '2026-04-27T10:00:00Z',
          pages: ['modules/Foo'],
        },
      },
    };
    writeManifest(path, manifest);
    const read = readManifest(path);
    expect(read).toEqual(manifest);
  });

  it('returns EMPTY on JSON parse failure (with onWarn)', () => {
    const path = join(dir, '.manifest.json');
    writeFileSync(path, 'not json {{{');
    const warnings: string[] = [];
    const m = readManifest(path, (w) => warnings.push(w));
    expect(m).toEqual(EMPTY_MANIFEST);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('JSON parse failed');
  });

  it('returns EMPTY on schema validation failure', () => {
    const path = join(dir, '.manifest.json');
    writeFileSync(path, JSON.stringify({ version: 99, sources: 'not an object' }));
    const warnings: string[] = [];
    const m = readManifest(path, (w) => warnings.push(w));
    expect(m).toEqual(EMPTY_MANIFEST);
    expect(warnings.length).toBe(1);
  });

  it('rejects invalid manifest at write time', () => {
    const path = join(dir, '.manifest.json');
    const bad = {
      version: 1,
      updated_at: '2026-04-27T10:00:00Z',
      sources: {
        'src/x.ts': {
          type: 'code',
          sha256: 'short-hash', // not 64 hex
          ingested_at: '2026-04-27T10:00:00Z',
          pages: [],
        },
      },
    };
    expect(() => writeManifest(path, bad as unknown as Manifest)).toThrow();
  });
});

describe('diffSources', () => {
  const baseManifest: Manifest = {
    version: 1,
    updated_at: '2026-04-27T10:00:00Z',
    sources: {
      'src/a.ts': {
        type: 'code',
        sha256: 'a'.repeat(64),
        ingested_at: '2026-04-27T10:00:00Z',
        pages: ['modules/A'],
      },
      'src/b.ts': {
        type: 'code',
        sha256: 'b'.repeat(64),
        ingested_at: '2026-04-27T10:00:00Z',
        pages: ['modules/B'],
      },
    },
  };

  it('detects added (new in current, not in manifest)', () => {
    const diff = diffSources(
      [
        { path: 'src/a.ts', hash: 'a'.repeat(64) },
        { path: 'src/b.ts', hash: 'b'.repeat(64) },
        { path: 'src/c.ts', hash: 'c'.repeat(64) },
      ],
      baseManifest,
    );
    expect(diff.added).toEqual(['src/c.ts']);
    expect(diff.changed).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged.sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('detects changed (hash mismatch)', () => {
    const diff = diffSources(
      [
        { path: 'src/a.ts', hash: 'NEW'.padEnd(64, '0') },
        { path: 'src/b.ts', hash: 'b'.repeat(64) },
      ],
      baseManifest,
    );
    expect(diff.changed).toEqual(['src/a.ts']);
    expect(diff.unchanged).toEqual(['src/b.ts']);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
  });

  it('detects removed (in manifest but not in current)', () => {
    const diff = diffSources(
      [{ path: 'src/a.ts', hash: 'a'.repeat(64) }],
      baseManifest,
    );
    expect(diff.removed).toEqual(['src/b.ts']);
    expect(diff.unchanged).toEqual(['src/a.ts']);
  });

  it('handles empty current (everything removed)', () => {
    const diff = diffSources([], baseManifest);
    expect(diff.removed.sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(diff.added).toEqual([]);
    expect(diff.unchanged).toEqual([]);
  });

  it('handles empty manifest (everything added)', () => {
    const diff = diffSources(
      [{ path: 'src/a.ts', hash: 'a'.repeat(64) }],
      EMPTY_MANIFEST,
    );
    expect(diff.added).toEqual(['src/a.ts']);
  });
});

describe('recordIngest / removeFromManifest', () => {
  it('records new source entry', () => {
    const m = recordIngest(EMPTY_MANIFEST, 'src/x.ts', {
      type: 'code',
      sha256: 'a'.repeat(64),
      ingested_at: '2026-04-27T11:00:00Z',
      pages: ['modules/X'],
    });
    expect(m.sources['src/x.ts']?.pages).toEqual(['modules/X']);
    expect(m.updated_at).not.toBe(EMPTY_MANIFEST.updated_at);
  });

  it('overwrites existing entry', () => {
    let m = recordIngest(EMPTY_MANIFEST, 'src/x.ts', {
      type: 'code',
      sha256: 'a'.repeat(64),
      ingested_at: '2026-04-27T11:00:00Z',
      pages: ['modules/X'],
    });
    m = recordIngest(m, 'src/x.ts', {
      type: 'code',
      sha256: 'b'.repeat(64),
      ingested_at: '2026-04-27T12:00:00Z',
      pages: ['modules/X', 'lessons/X Bug'],
    });
    expect(m.sources['src/x.ts']?.sha256).toBe('b'.repeat(64));
    expect(m.sources['src/x.ts']?.pages).toEqual(['modules/X', 'lessons/X Bug']);
  });

  it('does not mutate input manifest', () => {
    const original = EMPTY_MANIFEST;
    const next = recordIngest(original, 'a.ts', {
      type: 'code',
      sha256: 'a'.repeat(64),
      ingested_at: '2026-04-27T10:00:00Z',
      pages: [],
    });
    expect(original.sources).toEqual({});
    expect(next.sources['a.ts']).toBeDefined();
  });

  it('removeFromManifest removes existing entry', () => {
    let m = recordIngest(EMPTY_MANIFEST, 'src/x.ts', {
      type: 'code',
      sha256: 'a'.repeat(64),
      ingested_at: 't',
      pages: [],
    });
    m = removeFromManifest(m, 'src/x.ts');
    expect(m.sources['src/x.ts']).toBeUndefined();
  });

  it('removeFromManifest is no-op for missing path', () => {
    const m = removeFromManifest(EMPTY_MANIFEST, 'src/nonexistent');
    expect(m.sources).toEqual({});
  });
});

describe('isSourceStale', () => {
  it('returns false when source mtime <= page mtime', () => {
    const f = join(dir, 'src.ts');
    writeFileSync(f, 'old content');
    const pageMtime = new Date(Date.now() + 60_000); // page is newer
    expect(isSourceStale(f, pageMtime)).toBe(false);
  });

  it('returns true when source is significantly newer than page', () => {
    const f = join(dir, 'src.ts');
    writeFileSync(f, 'new content');
    const pageMtime = new Date(Date.now() - 5 * 60_000); // page is 5 min older
    expect(isSourceStale(f, pageMtime)).toBe(true);
  });

  it('returns false within 60s slop tolerance (FS precision)', () => {
    const f = join(dir, 'src.ts');
    writeFileSync(f, 'content');
    const pageMtime = new Date(Date.now() - 10_000); // 10s, within tolerance
    expect(isSourceStale(f, pageMtime)).toBe(false);
  });

  it('returns false when source missing', () => {
    expect(isSourceStale(join(dir, 'nonexistent'), new Date())).toBe(false);
  });

  it('returns false when no page mtime', () => {
    const f = join(dir, 'src.ts');
    writeFileSync(f, 'x');
    expect(isSourceStale(f, null)).toBe(false);
  });
});

describe('writeManifest atomicity', () => {
  it('uses temp file + rename', () => {
    const path = join(dir, '.manifest.json');
    writeManifest(path, EMPTY_MANIFEST);
    expect(readFileSync(path, 'utf-8')).toContain('"version": 1');
    // tmp file should be cleaned up
    let dirEntries: string[];
    try {
      dirEntries = require('node:fs').readdirSync(dir);
    } catch {
      dirEntries = [];
    }
    const tmpRemains = dirEntries.filter((f: string) => f.endsWith('.tmp'));
    expect(tmpRemains).toEqual([]);
  });
});

describe('integration: full write→read→diff loop', () => {
  it('captures incremental change after write', () => {
    const path = join(dir, '.manifest.json');
    writeManifest(path, EMPTY_MANIFEST);

    // 写第一个文件 + record
    const f1 = join(dir, 'a.ts');
    writeFileSync(f1, 'v1');
    const h1 = hashFile(f1);
    let m = readManifest(path);
    m = recordIngest(m, 'a.ts', {
      type: 'code',
      sha256: h1,
      ingested_at: new Date().toISOString(),
      pages: ['modules/A'],
    });
    writeManifest(path, m);

    // 修改文件
    writeFileSync(f1, 'v2');
    const h2 = hashFile(f1);
    expect(h2).not.toBe(h1);

    // diff 应识别 changed
    const m2 = readManifest(path);
    const diff = diffSources([{ path: 'a.ts', hash: h2 }], m2);
    expect(diff.changed).toEqual(['a.ts']);
  });
});
