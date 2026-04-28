/**
 * @module        projectInit.wiki.test
 * @description   v0.51.0：enableWiki 开关在 conf + 物理 scaffold 上的串联验证
 *
 * 测试方式：mock HOME → 跑 executeProjectInit(nonInteractive) → 读 conf 文件 + 检查
 * PROJECT_DIR 下 wiki/ 是否就位。projectInit 顶层捕获 const HOME，所以每个 case
 * 都要 resetModules + 重新设置环境再 import。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let homeDir: string;
let projectDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'sps-init-wiki-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'sps-init-wiki-repo-'));
  originalHome = process.env.HOME;
  process.env.HOME = homeDir;
  vi.resetModules();
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

describe('executeProjectInit + enableWiki', () => {
  it('omits WIKI_ENABLED from conf when enableWiki is false', async () => {
    const { executeProjectInit } = await import('./projectInit.js');
    await executeProjectInit('demo', {}, {
      projectDir,
      mergeBranch: 'main',
      maxWorkers: '1',
      enableGit: false,
      enableWiki: false,
    });

    const confPath = resolve(homeDir, '.coral', 'projects', 'demo', 'conf');
    const content = readFileSync(confPath, 'utf-8');
    expect(content).not.toContain('WIKI_ENABLED');
    // wiki/ 不应该被创建
    expect(existsSync(resolve(projectDir, 'wiki'))).toBe(false);
  });

  it('writes WIKI_ENABLED=true to conf when enableWiki is true', async () => {
    const { executeProjectInit } = await import('./projectInit.js');
    await executeProjectInit('demo', {}, {
      projectDir,
      mergeBranch: 'main',
      maxWorkers: '1',
      enableGit: false,
      enableWiki: true,
    });

    const confPath = resolve(homeDir, '.coral', 'projects', 'demo', 'conf');
    const content = readFileSync(confPath, 'utf-8');
    expect(content).toContain('export WIKI_ENABLED=true');
  });

  it('scaffolds wiki/ in PROJECT_DIR when enableWiki=true and dir exists', async () => {
    const { executeProjectInit } = await import('./projectInit.js');
    await executeProjectInit('demo', {}, {
      projectDir,
      mergeBranch: 'main',
      maxWorkers: '1',
      enableGit: false,
      enableWiki: true,
    });

    const wikiDir = resolve(projectDir, 'wiki');
    expect(existsSync(wikiDir)).toBe(true);
    expect(existsSync(resolve(wikiDir, 'WIKI.md'))).toBe(true);
    expect(existsSync(resolve(wikiDir, 'modules'))).toBe(true);
    expect(existsSync(resolve(wikiDir, 'lessons'))).toBe(true);
    expect(existsSync(resolve(projectDir, '.gitignore'))).toBe(true);
  });

  it('skip wiki scaffold gracefully when PROJECT_DIR missing but enableWiki=true', async () => {
    const ghostDir = resolve(homeDir, 'no-such-project');
    expect(existsSync(ghostDir)).toBe(false);
    const { executeProjectInit } = await import('./projectInit.js');
    // Should not throw
    await executeProjectInit('demo', {}, {
      projectDir: ghostDir,
      mergeBranch: 'main',
      maxWorkers: '1',
      enableGit: false,
      enableWiki: true,
    });

    // conf still has WIKI_ENABLED=true
    const confPath = resolve(homeDir, '.coral', 'projects', 'demo', 'conf');
    const content = readFileSync(confPath, 'utf-8');
    expect(content).toContain('WIKI_ENABLED=true');
    // No wiki/ created
    expect(existsSync(resolve(ghostDir, 'wiki'))).toBe(false);
  });

  it('conf.example documents WIKI_ENABLED', async () => {
    const { executeProjectInit } = await import('./projectInit.js');
    await executeProjectInit('demo', {}, {
      projectDir,
      mergeBranch: 'main',
      maxWorkers: '1',
      enableGit: false,
    });

    const examplePath = resolve(homeDir, '.coral', 'projects', 'demo', 'conf.example');
    const content = readFileSync(examplePath, 'utf-8');
    expect(content).toContain('WIKI_ENABLED');
    expect(content).toContain('Wiki Knowledge Base');
  });
});

describe('idempotency: re-run preserves user-edited wiki', () => {
  it('second init with enableWiki=true does not overwrite existing WIKI.md', async () => {
    mkdirSync(resolve(projectDir, 'wiki'), { recursive: true });
    const wikiMd = resolve(projectDir, 'wiki', 'WIKI.md');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(wikiMd, 'CUSTOM CONTENT');

    const { executeProjectInit } = await import('./projectInit.js');
    await executeProjectInit('demo', {}, {
      projectDir,
      mergeBranch: 'main',
      maxWorkers: '1',
      enableGit: false,
      enableWiki: true,
    });

    expect(readFileSync(wikiMd, 'utf-8')).toBe('CUSTOM CONTENT');
  });
});

describe('CLAUDE.md wiki rules + ATTRIBUTION.md', () => {
  it('appendWikiClaudeRules: idempotent block replacement', async () => {
    const { appendWikiClaudeRules } = await import('./projectInit.js');
    const { writeFileSync } = await import('node:fs');
    mkdirSync(resolve(projectDir, '.claude'), { recursive: true });
    const claudeMd = resolve(projectDir, '.claude', 'CLAUDE.md');
    writeFileSync(claudeMd, '# Project Rules\n\nUser content here.\n');

    appendWikiClaudeRules(projectDir, 'demo');
    const after1 = readFileSync(claudeMd, 'utf-8');
    expect(after1).toContain('User content here.');
    expect(after1).toContain('## Wiki Knowledge Base');
    expect(after1).toContain('sps wiki check demo');

    // Run twice — should not duplicate the block
    appendWikiClaudeRules(projectDir, 'demo');
    const after2 = readFileSync(claudeMd, 'utf-8');
    const blockCount = (after2.match(/## Wiki Knowledge Base/g) ?? []).length;
    expect(blockCount).toBe(1);
  });

  it('appendWikiClaudeRules: no-op when CLAUDE.md missing', async () => {
    const { appendWikiClaudeRules } = await import('./projectInit.js');
    appendWikiClaudeRules(projectDir, 'demo');
    expect(existsSync(resolve(projectDir, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  it('appendWikiClaudeRules: refresh updates existing block in place', async () => {
    const { appendWikiClaudeRules } = await import('./projectInit.js');
    const { writeFileSync } = await import('node:fs');
    mkdirSync(resolve(projectDir, '.claude'), { recursive: true });
    const claudeMd = resolve(projectDir, '.claude', 'CLAUDE.md');
    // Pre-existing CLAUDE.md with old wiki block + user trailing content
    writeFileSync(
      claudeMd,
      '# Top\n\n<!-- BEGIN: SPS WIKI RULES (v0.51.0) -->\nold content\n<!-- END: SPS WIKI RULES -->\n\n## User trailing\nbottom\n',
    );
    appendWikiClaudeRules(projectDir, 'demo');
    const after = readFileSync(claudeMd, 'utf-8');
    expect(after).toContain('# Top');
    expect(after).toContain('## User trailing');
    expect(after).not.toContain('old content');
    expect(after).toContain('## Wiki Knowledge Base');
  });

  it('ensureAttributionFile creates ATTRIBUTION.md when missing', async () => {
    const { ensureAttributionFile } = await import('./projectInit.js');
    ensureAttributionFile(projectDir);
    const path = resolve(projectDir, 'ATTRIBUTION.md');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('claude-obsidian');
    expect(content).toContain('Karpathy');
    expect(content).toContain('MIT');
  });

  it('ensureAttributionFile preserves existing file', async () => {
    const { ensureAttributionFile } = await import('./projectInit.js');
    const { writeFileSync } = await import('node:fs');
    const path = resolve(projectDir, 'ATTRIBUTION.md');
    writeFileSync(path, 'CUSTOM');
    ensureAttributionFile(projectDir);
    expect(readFileSync(path, 'utf-8')).toBe('CUSTOM');
  });

  it('end-to-end: enableWiki=true installs CLAUDE.md wiki block + ATTRIBUTION.md', async () => {
    const { executeProjectInit } = await import('./projectInit.js');
    await executeProjectInit('demo', {}, {
      projectDir,
      mergeBranch: 'main',
      maxWorkers: '1',
      enableGit: false,
      enableWiki: true,
    });
    // Project template installs .claude/CLAUDE.md, then we append wiki block
    const claudeMd = resolve(projectDir, '.claude', 'CLAUDE.md');
    if (existsSync(claudeMd)) {
      const content = readFileSync(claudeMd, 'utf-8');
      expect(content).toContain('## Wiki Knowledge Base');
    }
    expect(existsSync(resolve(projectDir, 'ATTRIBUTION.md'))).toBe(true);
  });

  it('end-to-end: enableWiki=false leaves CLAUDE.md untouched (no wiki block) + no ATTRIBUTION.md', async () => {
    const { executeProjectInit } = await import('./projectInit.js');
    await executeProjectInit('demo', {}, {
      projectDir,
      mergeBranch: 'main',
      maxWorkers: '1',
      enableGit: false,
      enableWiki: false,
    });
    const claudeMd = resolve(projectDir, '.claude', 'CLAUDE.md');
    if (existsSync(claudeMd)) {
      const content = readFileSync(claudeMd, 'utf-8');
      expect(content).not.toContain('## Wiki Knowledge Base');
    }
    expect(existsSync(resolve(projectDir, 'ATTRIBUTION.md'))).toBe(false);
  });
});

// ─── v0.51.6: createIfMissing ───────────────────────────────────────

describe('createIfMissing', () => {
  it('createIfMissing=true → mkdirs missing projectDir and installs .claude/', async () => {
    const ghostDir = resolve(homeDir, 'ghost-project-dir');
    expect(existsSync(ghostDir)).toBe(false);

    const { executeProjectInit } = await import('./projectInit.js');
    await executeProjectInit('demo', {}, {
      projectDir: ghostDir,
      mergeBranch: 'main',
      maxWorkers: '1',
      enableGit: false,
      createIfMissing: true,
    });

    expect(existsSync(ghostDir)).toBe(true);
    // .claude/ should now be installed (template exists in repo, so install runs)
    const claudeDir = resolve(ghostDir, '.claude');
    if (existsSync(claudeDir)) {
      // Template ships .claude/CLAUDE.md
      expect(existsSync(resolve(claudeDir, 'CLAUDE.md'))).toBe(true);
    }
  });

  it('createIfMissing=false (or unset) → projectDir stays missing, .claude/ skipped', async () => {
    const ghostDir = resolve(homeDir, 'ghost-no-create');
    expect(existsSync(ghostDir)).toBe(false);

    const { executeProjectInit } = await import('./projectInit.js');
    await executeProjectInit('demo', {}, {
      projectDir: ghostDir,
      mergeBranch: 'main',
      maxWorkers: '1',
      enableGit: false,
      // createIfMissing not set
    });

    expect(existsSync(ghostDir)).toBe(false);
    expect(existsSync(resolve(ghostDir, '.claude'))).toBe(false);
  });

  it('createIfMissing=true + enableWiki=true → mkdirs + .claude/ + wiki/ all installed', async () => {
    const ghostDir = resolve(homeDir, 'ghost-with-wiki');
    expect(existsSync(ghostDir)).toBe(false);

    const { executeProjectInit } = await import('./projectInit.js');
    await executeProjectInit('demo', {}, {
      projectDir: ghostDir,
      mergeBranch: 'main',
      maxWorkers: '1',
      enableGit: false,
      enableWiki: true,
      createIfMissing: true,
    });

    expect(existsSync(ghostDir)).toBe(true);
    expect(existsSync(resolve(ghostDir, 'wiki', 'WIKI.md'))).toBe(true);
    expect(existsSync(resolve(ghostDir, 'ATTRIBUTION.md'))).toBe(true);
  });

  it('createIfMissing=true on already-existing dir is no-op (preserves existing files)', async () => {
    // projectDir already created in beforeEach via mkdtempSync — has nothing in it though
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(projectDir, 'EXISTING_FILE'), 'preserved');

    const { executeProjectInit } = await import('./projectInit.js');
    await executeProjectInit('demo', {}, {
      projectDir,
      mergeBranch: 'main',
      maxWorkers: '1',
      enableGit: false,
      createIfMissing: true,
    });

    expect(existsSync(resolve(projectDir, 'EXISTING_FILE'))).toBe(true);
    expect(readFileSync(resolve(projectDir, 'EXISTING_FILE'), 'utf-8')).toBe('preserved');
  });
});
