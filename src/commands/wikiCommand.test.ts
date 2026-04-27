/**
 * @module        wikiCommand.test
 * @description   `sps wiki <init|update|read>` 命令测试
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let repo: string;

// Mock ProjectContext to point at our test repo without needing a real ~/.coral fixture.
vi.mock('../core/context.js', () => ({
  ProjectContext: {
    load: vi.fn((name: string) => ({
      projectName: name,
      config: { raw: {} },
      paths: {
        repoDir: repo,
        instanceDir: '/tmp/x',
        confFile: '/tmp/x/conf',
        logsDir: '/tmp/x/logs',
        runtimeDir: '/tmp/x/runtime',
        stateFile: '/tmp/x/state',
        acpStateFile: '/tmp/x/acp',
        tickLockFile: '/tmp/x/tick',
        pmMetaDir: '/tmp/x/pm',
        pipelineOrderFile: '/tmp/x/pipe',
        worktreeRoot: '/tmp/x/wt',
      },
    })),
  },
}));

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wiki-cmd-test-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('executeWikiInit', () => {
  it('scaffolds wiki/ in repo', async () => {
    const { executeWikiInit } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');
    logSpy.mockRestore();
    expect(existsSync(resolve(repo, 'wiki', 'WIKI.md'))).toBe(true);
    expect(existsSync(resolve(repo, 'wiki', 'modules'))).toBe(true);
    expect(existsSync(resolve(repo, 'wiki', '.hot.md'))).toBe(true);
  });

  it('json mode prints structured report', async () => {
    const { executeWikiInit } = await import('./wikiCommand.js');
    let captured = '';
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      captured += String(msg) + '\n';
    });
    executeWikiInit('demo', { json: true });
    logSpy.mockRestore();
    const parsed = JSON.parse(captured);
    expect(parsed.wikiDir).toBe(resolve(repo, 'wiki'));
    expect(Array.isArray(parsed.created)).toBe(true);
  });

  it('idempotent on second run', async () => {
    const { executeWikiInit } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');
    writeFileSync(resolve(repo, 'wiki', 'WIKI.md'), 'CUSTOM\n');
    executeWikiInit('demo');
    logSpy.mockRestore();
    const content = readFileSync(resolve(repo, 'wiki', 'WIKI.md'), 'utf-8');
    expect(content).toBe('CUSTOM\n');
  });
});

describe('executeWikiUpdate', () => {
  it('throws when wiki/WIKI.md missing', async () => {
    const { executeWikiUpdate } = await import('./wikiCommand.js');
    expect(() => executeWikiUpdate('demo')).toThrow(/wiki\/WIKI\.md missing/);
  });

  it('prints plan with diff against empty manifest', async () => {
    const { executeWikiInit, executeWikiUpdate } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');
    // Add a source file matching default WIKI.md sources
    mkdirSync(resolve(repo, 'src'), { recursive: true });
    writeFileSync(resolve(repo, 'src', 'a.ts'), 'export {};', 'utf-8');

    let captured = '';
    logSpy.mockRestore();
    const logSpy2 = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      captured += String(msg) + '\n';
    });
    executeWikiUpdate('demo', { json: true });
    logSpy2.mockRestore();
    const parsed = JSON.parse(captured);
    expect(parsed.added).toContain('src/a.ts');
    expect(parsed.changed).toEqual([]);
    expect(parsed.removed).toEqual([]);
  });

  it('finalize writes manifest with all current sources', async () => {
    const { executeWikiInit, executeWikiUpdate } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');
    mkdirSync(resolve(repo, 'src'), { recursive: true });
    writeFileSync(resolve(repo, 'src', 'a.ts'), 'export {};', 'utf-8');
    executeWikiUpdate('demo', { finalize: true });
    logSpy.mockRestore();
    const manifest = JSON.parse(
      readFileSync(resolve(repo, 'wiki', '.manifest.json'), 'utf-8'),
    );
    expect(manifest.sources['src/a.ts']).toBeDefined();
    expect(manifest.sources['src/a.ts'].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('after finalize, second update shows unchanged', async () => {
    const { executeWikiInit, executeWikiUpdate } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');
    mkdirSync(resolve(repo, 'src'), { recursive: true });
    writeFileSync(resolve(repo, 'src', 'a.ts'), 'export {};', 'utf-8');
    executeWikiUpdate('demo', { finalize: true });
    logSpy.mockRestore();

    let captured = '';
    const logSpy2 = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      captured += String(msg) + '\n';
    });
    executeWikiUpdate('demo', { json: true });
    logSpy2.mockRestore();
    const parsed = JSON.parse(captured);
    expect(parsed.added).toEqual([]);
    expect(parsed.unchanged).toContain('src/a.ts');
  });
});

describe('executeWikiRead', () => {
  it('prints empty context for fresh wiki', async () => {
    const { executeWikiInit, executeWikiRead } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    executeWikiInit('demo');
    executeWikiRead('demo', { query: 'anything' });
    logSpy.mockRestore();
    errSpy.mockRestore();
    // doesn't throw
  });

  it('json mode returns structured WikiContext', async () => {
    const { executeWikiInit, executeWikiRead } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');
    logSpy.mockRestore();

    let captured = '';
    const logSpy2 = vi.spyOn(console, 'log').mockImplementation((msg: unknown) => {
      captured += String(msg) + '\n';
    });
    executeWikiRead('demo', { query: 'pipeline', json: true });
    logSpy2.mockRestore();
    const parsed = JSON.parse(captured);
    expect(parsed).toHaveProperty('hot');
    expect(parsed).toHaveProperty('indexSummary');
    expect(parsed).toHaveProperty('pages');
    expect(parsed).toHaveProperty('tokensEstimate');
  });
});

describe('executeWikiCheck', () => {
  it('reports clean wiki', async () => {
    const { executeWikiInit, executeWikiCheck } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');
    executeWikiCheck('demo');
    logSpy.mockRestore();
    // no throw
  });

  it('throws LintFailure on dead-link error', async () => {
    const { executeWikiInit, executeWikiCheck } = await import('./wikiCommand.js');
    const { writePage } = await import('../core/wiki/page.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');

    writePage(
      repo,
      'lesson',
      'A',
      {
        type: 'lesson',
        title: 'A',
        created: '2026-04-27',
        updated: '2026-04-27',
        tags: ['t'],
        status: 'developing',
        related: ['[[Ghost]]'],
        sources: [],
        generated: 'manual',
        severity: 'major',
      },
      '## TL;DR\nbody',
    );

    expect(() => executeWikiCheck('demo')).toThrow(/Wiki lint failed/);
    logSpy.mockRestore();
  });

  it('json output structured', async () => {
    const { executeWikiInit, executeWikiCheck } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');

    let captured = '';
    logSpy.mockRestore();
    const log2 = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      captured += String(m) + '\n';
    });
    executeWikiCheck('demo', { json: true });
    log2.mockRestore();
    const parsed = JSON.parse(captured);
    expect(parsed).toHaveProperty('issues');
    expect(parsed).toHaveProperty('errorCount');
    expect(parsed).toHaveProperty('warnCount');
  });
});

describe('executeWikiAdd', () => {
  it('throws when wiki not initialized', async () => {
    const { executeWikiAdd } = await import('./wikiCommand.js');
    expect(() => executeWikiAdd('demo', { src: '/etc/hostname' })).toThrow(
      /wiki\/WIKI\.md missing/,
    );
  });

  it('copies source file into wiki/.raw/<category>/', async () => {
    const { executeWikiInit, executeWikiAdd } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');

    const srcDir = mkdtempSync(join(tmpdir(), 'wiki-add-src-'));
    const srcFile = resolve(srcDir, 'note.md');
    writeFileSync(srcFile, '# hello\n');

    executeWikiAdd('demo', { src: srcFile, category: 'transcripts' });
    logSpy.mockRestore();

    const expected = resolve(repo, 'wiki', '.raw', 'transcripts', 'note.md');
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected, 'utf-8')).toBe('# hello\n');

    rmSync(srcDir, { recursive: true, force: true });
  });

  it('throws for missing source', async () => {
    const { executeWikiInit, executeWikiAdd } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');
    logSpy.mockRestore();
    expect(() => executeWikiAdd('demo', { src: '/no/such/file' })).toThrow(
      /Source not found/,
    );
  });

  it('rejects directories', async () => {
    const { executeWikiInit, executeWikiAdd } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');
    logSpy.mockRestore();
    expect(() => executeWikiAdd('demo', { src: repo })).toThrow(/must be a file/);
  });

  it('sanitizes category to safe chars', async () => {
    const { executeWikiInit, executeWikiAdd } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');

    const srcDir = mkdtempSync(join(tmpdir(), 'wiki-add-src-'));
    const srcFile = resolve(srcDir, 'note.md');
    writeFileSync(srcFile, 'x');

    executeWikiAdd('demo', { src: srcFile, category: '../escape/here' });
    logSpy.mockRestore();

    // Sanitized: dots and slashes become _ (3 disallowed → 3 underscores at start)
    expect(existsSync(resolve(repo, 'wiki', '.raw', '___escape_here'))).toBe(true);
    rmSync(srcDir, { recursive: true, force: true });
  });
});

describe('executeWikiList', () => {
  it('returns empty list for fresh wiki', async () => {
    const { executeWikiInit, executeWikiList } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');

    let captured = '';
    logSpy.mockRestore();
    const log2 = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      captured += String(m) + '\n';
    });
    executeWikiList('demo', { json: true });
    log2.mockRestore();
    const parsed = JSON.parse(captured);
    expect(parsed).toEqual([]);
  });

  it('lists pages and filters by type', async () => {
    const { executeWikiInit, executeWikiList } = await import('./wikiCommand.js');
    const { writePage } = await import('../core/wiki/page.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');

    writePage(repo, 'lesson', 'L1', {
      type: 'lesson',
      title: 'L1',
      created: '2026-04-27',
      updated: '2026-04-27',
      tags: ['x'],
      status: 'developing',
      related: [],
      sources: [],
      generated: 'manual',
      severity: 'major',
    }, '## TL;DR\nx');
    writePage(repo, 'module', 'M1', {
      type: 'module',
      title: 'M1',
      created: '2026-04-27',
      updated: '2026-04-27',
      tags: ['y'],
      status: 'developing',
      related: [],
      sources: [],
      generated: 'auto',
      module_path: 'src/M1.ts',
    }, '## TL;DR\ny');

    let captured = '';
    logSpy.mockRestore();
    const log2 = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      captured += String(m) + '\n';
    });
    executeWikiList('demo', { type: 'lesson', json: true });
    log2.mockRestore();
    const parsed = JSON.parse(captured);
    expect(parsed.map((p: { pageId: string }) => p.pageId)).toEqual(['lessons/L1']);
  });

  it('filters by tag', async () => {
    const { executeWikiInit, executeWikiList } = await import('./wikiCommand.js');
    const { writePage } = await import('../core/wiki/page.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');

    writePage(repo, 'lesson', 'A', {
      type: 'lesson', title: 'A', created: '2026-04-27', updated: '2026-04-27',
      tags: ['frontend'], status: 'developing', related: [], sources: [],
      generated: 'manual', severity: 'major',
    }, '## TL;DR\nx');
    writePage(repo, 'lesson', 'B', {
      type: 'lesson', title: 'B', created: '2026-04-27', updated: '2026-04-27',
      tags: ['backend'], status: 'developing', related: [], sources: [],
      generated: 'manual', severity: 'major',
    }, '## TL;DR\ny');

    let captured = '';
    logSpy.mockRestore();
    const log2 = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      captured += String(m) + '\n';
    });
    executeWikiList('demo', { tag: 'frontend', json: true });
    log2.mockRestore();
    const parsed = JSON.parse(captured);
    expect(parsed.map((p: { pageId: string }) => p.pageId)).toEqual(['lessons/A']);
  });
});

describe('executeWikiGet', () => {
  it('throws for missing page', async () => {
    const { executeWikiInit, executeWikiGet } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');
    logSpy.mockRestore();
    expect(() => executeWikiGet('demo', { pageId: 'lessons/Ghost' })).toThrow(
      /Page not found/,
    );
  });

  it('prints raw page content', async () => {
    const { executeWikiInit, executeWikiGet } = await import('./wikiCommand.js');
    const { writePage } = await import('../core/wiki/page.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');

    writePage(repo, 'lesson', 'A', {
      type: 'lesson', title: 'A', created: '2026-04-27', updated: '2026-04-27',
      tags: ['t'], status: 'developing', related: [], sources: [],
      generated: 'manual', severity: 'major',
    }, '## TL;DR\nshort summary');

    let captured = '';
    logSpy.mockRestore();
    const log2 = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      captured += String(m) + '\n';
    });
    executeWikiGet('demo', { pageId: 'lessons/A' });
    log2.mockRestore();
    expect(captured).toContain('title: A');
    expect(captured).toContain('## TL;DR');
    expect(captured).toContain('short summary');
  });

  it('json output includes structured page', async () => {
    const { executeWikiInit, executeWikiGet } = await import('./wikiCommand.js');
    const { writePage } = await import('../core/wiki/page.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');

    writePage(repo, 'lesson', 'A', {
      type: 'lesson', title: 'A', created: '2026-04-27', updated: '2026-04-27',
      tags: ['t'], status: 'developing', related: [], sources: [],
      generated: 'manual', severity: 'major',
    }, '## TL;DR\nshort');

    let captured = '';
    logSpy.mockRestore();
    const log2 = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      captured += String(m) + '\n';
    });
    executeWikiGet('demo', { pageId: 'lessons/A', json: true });
    log2.mockRestore();
    const parsed = JSON.parse(captured);
    expect(parsed.frontmatter.title).toBe('A');
    expect(parsed.body).toContain('TL;DR');
  });
});

describe('executeWikiStatus', () => {
  it('throws when wiki not initialized', async () => {
    const { executeWikiStatus } = await import('./wikiCommand.js');
    expect(() => executeWikiStatus('demo')).toThrow(/wiki\/WIKI\.md missing/);
  });

  it('reports zero diff for empty repo', async () => {
    const { executeWikiInit, executeWikiStatus } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');

    let captured = '';
    logSpy.mockRestore();
    const log2 = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      captured += String(m) + '\n';
    });
    executeWikiStatus('demo', { json: true });
    log2.mockRestore();
    const parsed = JSON.parse(captured);
    expect(parsed.diff).toEqual({ added: 0, changed: 0, removed: 0, unchanged: 0 });
    expect(parsed.outdated).toEqual([]);
  });

  it('reports added sources after files appear', async () => {
    const { executeWikiInit, executeWikiStatus } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');
    mkdirSync(resolve(repo, 'src'), { recursive: true });
    writeFileSync(resolve(repo, 'src', 'a.ts'), 'export {};');

    let captured = '';
    logSpy.mockRestore();
    const log2 = vi.spyOn(console, 'log').mockImplementation((m: unknown) => {
      captured += String(m) + '\n';
    });
    executeWikiStatus('demo', { json: true });
    log2.mockRestore();
    const parsed = JSON.parse(captured);
    expect(parsed.diff.added).toBe(1);
  });
});

describe('executeWikiCommand router', () => {
  it('throws on missing subcommand', async () => {
    const { executeWikiCommand } = await import('./wikiCommand.js');
    expect(() =>
      executeWikiCommand({
        subcommand: null,
        project: 'demo',
        positionals: [],
        flags: {},
      }),
    ).toThrow(/Usage/);
  });

  it('throws on unknown subcommand', async () => {
    const { executeWikiCommand } = await import('./wikiCommand.js');
    expect(() =>
      executeWikiCommand({
        subcommand: 'frob',
        project: 'demo',
        positionals: [],
        flags: {},
      }),
    ).toThrow(/Unknown wiki subcommand/);
  });

  it('throws when read missing query', async () => {
    const { executeWikiCommand, executeWikiInit } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiInit('demo');
    logSpy.mockRestore();
    expect(() =>
      executeWikiCommand({
        subcommand: 'read',
        project: 'demo',
        positionals: [],
        flags: {},
      }),
    ).toThrow(/Usage:.*wiki read/);
  });

  it('routes init', async () => {
    const { executeWikiCommand } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiCommand({
      subcommand: 'init',
      project: 'demo',
      positionals: [],
      flags: {},
    });
    logSpy.mockRestore();
    expect(existsSync(resolve(repo, 'wiki', 'WIKI.md'))).toBe(true);
  });

  it('routes update with --finalize flag', async () => {
    const { executeWikiCommand } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiCommand({
      subcommand: 'init',
      project: 'demo',
      positionals: [],
      flags: {},
    });
    executeWikiCommand({
      subcommand: 'update',
      project: 'demo',
      positionals: [],
      flags: { finalize: true },
    });
    logSpy.mockRestore();
    expect(existsSync(resolve(repo, 'wiki', '.manifest.json'))).toBe(true);
  });

  it('routes check', async () => {
    const { executeWikiCommand } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiCommand({
      subcommand: 'init',
      project: 'demo',
      positionals: [],
      flags: {},
    });
    expect(() =>
      executeWikiCommand({
        subcommand: 'check',
        project: 'demo',
        positionals: [],
        flags: {},
      }),
    ).not.toThrow();
    logSpy.mockRestore();
  });

  it('routes add (throws missing src)', async () => {
    const { executeWikiCommand } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiCommand({
      subcommand: 'init',
      project: 'demo',
      positionals: [],
      flags: {},
    });
    expect(() =>
      executeWikiCommand({
        subcommand: 'add',
        project: 'demo',
        positionals: [],
        flags: {},
      }),
    ).toThrow(/Usage:.*wiki add/);
    logSpy.mockRestore();
  });

  it('routes list', async () => {
    const { executeWikiCommand } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiCommand({
      subcommand: 'init',
      project: 'demo',
      positionals: [],
      flags: {},
    });
    executeWikiCommand({
      subcommand: 'list',
      project: 'demo',
      positionals: [],
      flags: { json: true },
      type: 'lesson',
    });
    logSpy.mockRestore();
  });

  it('routes get (throws missing pageId)', async () => {
    const { executeWikiCommand } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiCommand({
      subcommand: 'init',
      project: 'demo',
      positionals: [],
      flags: {},
    });
    expect(() =>
      executeWikiCommand({
        subcommand: 'get',
        project: 'demo',
        positionals: [],
        flags: {},
      }),
    ).toThrow(/Usage:.*wiki get/);
    logSpy.mockRestore();
  });

  it('routes status', async () => {
    const { executeWikiCommand } = await import('./wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiCommand({
      subcommand: 'init',
      project: 'demo',
      positionals: [],
      flags: {},
    });
    executeWikiCommand({
      subcommand: 'status',
      project: 'demo',
      positionals: [],
      flags: { json: true },
    });
    logSpy.mockRestore();
  });
});
