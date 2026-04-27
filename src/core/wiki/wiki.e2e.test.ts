/**
 * @module        wiki.e2e.test
 * @description   v0.51.0 wiki 端到端冒烟测试
 *
 * 走一遍 doc-28 §7 描述的完整流程：
 *   1. project init --wiki  → conf 有 WIKI_ENABLED=true、wiki/ 骨架存在、
 *                              CLAUDE.md 有 wiki 段、ATTRIBUTION.md 在仓库根
 *   2. 添加源文件（src/X.ts），sps wiki update 看到 added
 *   3. 模拟 Worker 写 lessons/ + modules/ 页（手动 writePage）
 *   4. sps wiki update --finalize 写 manifest，diff 清空
 *   5. sps wiki check 通过
 *   6. sps wiki read 注入 hot/index/pages → format 成 prompt
 *   7. 修改源文件 → sps wiki status 报 changed
 *
 * 不启动真 Worker；prompt 构造由 taskPrompts.test.ts 验证。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let homeDir: string;
let projectDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  homeDir = mkdtempSync(join(tmpdir(), 'wiki-e2e-home-'));
  projectDir = mkdtempSync(join(tmpdir(), 'wiki-e2e-repo-'));
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

describe('Wiki E2E: project init → ingest → read flow', () => {
  it('happy path: full lifecycle', async () => {
    // ─── Step 1: project init with wiki enabled ───────────────
    const { executeProjectInit } = await import('../../commands/projectInit.js');
    await executeProjectInit('e2e-demo', {}, {
      projectDir,
      mergeBranch: 'main',
      maxWorkers: '1',
      enableGit: false,
      enableWiki: true,
    });

    const wikiDir = resolve(projectDir, 'wiki');
    const wikiMeta = resolve(wikiDir, 'WIKI.md');
    const claudeMd = resolve(projectDir, '.claude', 'CLAUDE.md');
    const attribution = resolve(projectDir, 'ATTRIBUTION.md');

    // Conf has WIKI_ENABLED=true
    const confPath = resolve(homeDir, '.coral', 'projects', 'e2e-demo', 'conf');
    expect(readFileSync(confPath, 'utf-8')).toContain('WIKI_ENABLED=true');

    // wiki/ scaffolded
    expect(existsSync(wikiDir)).toBe(true);
    expect(existsSync(wikiMeta)).toBe(true);
    for (const t of ['modules', 'concepts', 'decisions', 'lessons', 'sources']) {
      expect(existsSync(resolve(wikiDir, t))).toBe(true);
    }
    expect(existsSync(resolve(wikiDir, '.raw'))).toBe(true);
    expect(existsSync(resolve(wikiDir, '.hot.md'))).toBe(true);
    // index.md is created by initWiki as placeholder
    expect(existsSync(resolve(wikiDir, 'index.md'))).toBe(true);

    // .gitignore registered drift entries
    const gitignore = readFileSync(resolve(projectDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('wiki/.hot.md');
    expect(gitignore).toContain('wiki/.log.md');
    expect(gitignore).toContain('wiki/.manifest.json');

    // CLAUDE.md has wiki block (if it exists; project template installs it)
    if (existsSync(claudeMd)) {
      expect(readFileSync(claudeMd, 'utf-8')).toContain('## Wiki Knowledge Base');
    }

    // ATTRIBUTION.md is dropped at repo root
    expect(existsSync(attribution)).toBe(true);
    expect(readFileSync(attribution, 'utf-8')).toContain('claude-obsidian');

    // ─── Step 2: add a source file → wiki update sees it as added ──
    mkdirSync(resolve(projectDir, 'src'), { recursive: true });
    writeFileSync(
      resolve(projectDir, 'src', 'PipelineService.ts'),
      'export class PipelineService { run() {} }\n',
    );

    const { discoverSources, diffAgainstManifest } = await import('./sources.js');
    const { readManifest } = await import('./manifest.js');
    const { wikiManifestFile } = await import('../../shared/wikiPaths.js');

    const { sources } = discoverSources(projectDir);
    expect(sources.find((s) => s.path === 'src/PipelineService.ts')).toBeDefined();

    const manifest0 = readManifest(wikiManifestFile(projectDir));
    const diff0 = diffAgainstManifest(sources, manifest0);
    expect(diff0.added).toContain('src/PipelineService.ts');

    // ─── Step 3: simulate Worker writing pages ────────────────────
    const { writePage } = await import('./page.js');
    const { writeIndex } = await import('./index-builder.js');

    writePage(projectDir, 'module', 'PipelineService', {
      type: 'module',
      title: 'PipelineService',
      created: '2026-04-27',
      updated: '2026-04-27',
      tags: ['pipeline', 'service'],
      status: 'developing',
      related: [],
      sources: [{ path: 'src/PipelineService.ts' }],
      generated: 'auto',
      module_path: 'src/PipelineService.ts',
    } as never, '## TL;DR\nThe pipeline orchestration service.\n\n## Body\nDetails of the orchestration.');

    writePage(projectDir, 'lesson', 'Stop-Hook-Race', {
      type: 'lesson',
      title: 'Stop-Hook-Race',
      created: '2026-04-27',
      updated: '2026-04-27',
      tags: ['pipeline', 'race-condition'],
      status: 'developing',
      related: ['[[modules/PipelineService]]'],
      sources: [{ card: '42' }],
      generated: 'manual',
      severity: 'major',
    } as never, '## TL;DR\nA race in the stop hook caused worker leaks.\n\n## Body\nFixed by registering listener synchronously.');

    // Build index.md
    const { listValidPages } = await import('./page.js');
    writeIndex(projectDir, listValidPages(projectDir));

    // ─── Step 4: finalize manifest ────────────────────────────────
    const { executeWikiCommand } = await import('../../commands/wikiCommand.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    executeWikiCommand({
      subcommand: 'update',
      project: 'e2e-demo',
      positionals: [],
      flags: { finalize: true },
    });
    logSpy.mockRestore();

    // Manifest now tracks the source
    const manifest1 = readManifest(wikiManifestFile(projectDir));
    expect(manifest1.sources['src/PipelineService.ts']).toBeDefined();

    // Second wiki update plan = unchanged
    const sources2 = discoverSources(projectDir).sources;
    const diff2 = diffAgainstManifest(sources2, manifest1);
    expect(diff2.added).toEqual([]);
    expect(diff2.changed).toEqual([]);
    expect(diff2.unchanged).toContain('src/PipelineService.ts');

    // ─── Step 5: wiki check passes (no errors) ────────────────────
    const { lintWiki } = await import('./linter.js');
    const pages = listValidPages(projectDir);
    const report = lintWiki({
      pages,
      manifest: manifest1,
      repoDir: projectDir,
    });
    expect(report.errorCount).toBe(0);

    // ─── Step 6: wiki read injects pages relevant to a card ──────
    const { wikiRead, formatWikiContext } = await import('./reader.js');
    const ctx = wikiRead({
      repoDir: projectDir,
      cardTitle: 'fix pipeline race',
      cardDesc: 'race condition in pipeline service',
      cardSkills: ['pipeline'],
    });

    // Both pages should surface (matching skill + keyword)
    const pageIds = ctx.pages.map((p) => p.pageId).sort();
    expect(pageIds).toContain('lessons/Stop-Hook-Race');
    expect(pageIds).toContain('modules/PipelineService');

    // Lesson should rank above module (TYPE_PRIORITY: lesson=3, module=1)
    const lessonIdx = ctx.pages.findIndex((p) => p.pageId === 'lessons/Stop-Hook-Race');
    const moduleIdx = ctx.pages.findIndex((p) => p.pageId === 'modules/PipelineService');
    expect(lessonIdx).toBeLessThan(moduleIdx);

    // formatWikiContext renders all 3 sections
    const formatted = formatWikiContext(ctx);
    expect(formatted).toContain('# 项目知识 - 当前状态');
    expect(formatted).toContain('# 知识地图（节选）');
    expect(formatted).toContain('# 与本任务相关的页');
    expect(formatted).toContain('[[lessons/Stop-Hook-Race]]');
    expect(formatted).toContain('[[modules/PipelineService]]');

    // Token budget is reasonable
    expect(ctx.tokensEstimate).toBeGreaterThan(0);
    expect(ctx.tokensEstimate).toBeLessThan(2000);

    // ─── Step 7: modify source → status reports stale ─────────────
    writeFileSync(
      resolve(projectDir, 'src', 'PipelineService.ts'),
      'export class PipelineService { run() { /* changed */ } }\n',
    );

    const sources3 = discoverSources(projectDir).sources;
    const diff3 = diffAgainstManifest(sources3, manifest1);
    expect(diff3.changed).toContain('src/PipelineService.ts');

    // checkStaleSources flags content drift
    const { checkStaleSources } = await import('./linter.js');
    const staleIssues = checkStaleSources(manifest1, projectDir);
    expect(staleIssues.length).toBeGreaterThan(0);
    expect(staleIssues[0]?.target).toBe('src/PipelineService.ts');
  });

  it('Worker prompt includes wiki context only when WIKI_ENABLED=true', async () => {
    // Init project WITHOUT wiki
    const { executeProjectInit } = await import('../../commands/projectInit.js');
    await executeProjectInit('no-wiki', {}, {
      projectDir,
      mergeBranch: 'main',
      maxWorkers: '1',
      enableGit: false,
      enableWiki: false,
    });

    const confPath = resolve(homeDir, '.coral', 'projects', 'no-wiki', 'conf');
    expect(readFileSync(confPath, 'utf-8')).not.toContain('WIKI_ENABLED');
    expect(existsSync(resolve(projectDir, 'wiki'))).toBe(false);

    // Worker prompt builder will see wikiContext undefined, output should not
    // contain any wiki section (verified in taskPrompts.test.ts).
  });
});

describe('Wiki E2E: degraded modes', () => {
  it('reading wiki when no pages exist returns just hot + empty pages', async () => {
    const { initWiki } = await import('./scaffold.js');
    initWiki(projectDir, { projectName: 'demo', skipGitignore: true });

    const { wikiRead } = await import('./reader.js');
    const ctx = wikiRead({
      repoDir: projectDir,
      cardTitle: 'q',
      cardDesc: 'd',
      cardSkills: [],
    });
    expect(ctx.hot).toContain('Hot Cache');
    expect(ctx.pages).toEqual([]);
  });

  it('check survives broken page (does not crash list)', async () => {
    const { initWiki } = await import('./scaffold.js');
    initWiki(projectDir, { projectName: 'demo', skipGitignore: true });
    // Drop a broken page (invalid frontmatter)
    writeFileSync(
      resolve(projectDir, 'wiki', 'lessons', 'Broken.md'),
      '---\nthis is not valid yaml: : ::\n---\nbody',
    );

    const { listValidPages } = await import('./page.js');
    const pages = listValidPages(projectDir);
    // Should not include broken page
    expect(pages.find((p) => p.pageId.endsWith('Broken'))).toBeUndefined();
  });

  it('budget exhausted returns empty pages but keeps hot/index', async () => {
    const { initWiki } = await import('./scaffold.js');
    const { writeHot } = await import('./hot.js');
    initWiki(projectDir, { projectName: 'demo', skipGitignore: true });
    writeHot(projectDir, {
      lastUpdate: 'big',
      keyFacts: Array.from({ length: 100 }, () => 'x'.repeat(100)),
    });

    const { wikiRead } = await import('./reader.js');
    const ctx = wikiRead(
      {
        repoDir: projectDir,
        cardTitle: 'x',
        cardDesc: 'y',
        cardSkills: [],
      },
      { budgetTokens: 50 },
    );
    expect(ctx.hot.length).toBeGreaterThan(0);
    expect(ctx.pages).toEqual([]);
  });
});
