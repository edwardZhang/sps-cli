/**
 * @module        commands/wikiCommand
 * @description   `sps wiki <init|update|read|check|add|list|get|status>` CLI 入口
 *
 * @layer         delivery
 *
 * 主命令（doc-28 §7）：
 *   - init   — 物理脚手架（建目录 + 写模板）
 *   - update — 计算 source diff，输出 plan / 写 finalize
 *   - read   — 5 层 wikiRead + format → 打印
 *
 * 辅助命令（doc-28 §10）：
 *   - check  — lint：orphan / dead-link / fm-gap / stale
 *   - add    — 复制外部源到 wiki/.raw/<type>/ 并触发更新
 *   - list   — 按 type/tag 过滤列页
 *   - get    — 取单页全文
 *   - status — 哪些 source 比对应 page 新（待 update）
 *
 * **commands/ 层只做参数解析 + I/O 编排**。所有逻辑下沉到 core/wiki/。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { ProjectContext } from '../core/context.js';
import {
  findOutdatedPages,
  type LintIssue,
  type LintReport,
  lintWiki,
} from '../core/wiki/linter.js';
import { appendLog } from '../core/wiki/log.js';
import { readManifest, writeManifest } from '../core/wiki/manifest.js';
import { getPageById, listValidPages } from '../core/wiki/page.js';
import { formatWikiContext, wikiRead } from '../core/wiki/reader.js';
import { initWiki } from '../core/wiki/scaffold.js';
import { diffAgainstManifest, discoverSources } from '../core/wiki/sources.js';
import type { Manifest, PageType } from '../core/wiki/types.js';
import { wikiManifestFile, wikiRawDir } from '../shared/wikiPaths.js';

// ─── Helpers ──────────────────────────────────────────────────────

interface ResolvedTarget {
  /** Project name as user passed it */
  readonly projectName: string;
  /** Repo dir (where wiki/ lives) */
  readonly repoDir: string;
}

function resolveTarget(projectName: string): ResolvedTarget {
  const ctx = ProjectContext.load(projectName);
  if (!existsSync(ctx.paths.repoDir)) {
    throw new Error(
      `Repo dir not found for project "${projectName}": ${ctx.paths.repoDir}`,
    );
  }
  return { projectName, repoDir: ctx.paths.repoDir };
}

// ─── Subcommand: init ─────────────────────────────────────────────

export interface WikiInitOptions {
  readonly json?: boolean;
}

export function executeWikiInit(
  projectName: string,
  opts: WikiInitOptions = {},
): void {
  const target = resolveTarget(projectName);
  const report = initWiki(target.repoDir, { projectName });

  // Best-effort log entry
  try {
    appendLog(target.repoDir, {
      action: 'init',
      target: 'wiki/',
      message: `Initialized wiki for ${projectName}`,
    });
  } catch {
    // log failure isn't fatal
  }

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`✓ Wiki ready at ${report.wikiDir}`);
  if (report.created.length > 0) {
    console.log(`  Created ${report.created.length} dir(s)`);
  }
  if (report.filesWritten.length > 0) {
    console.log(`  Wrote ${report.filesWritten.length} file(s):`);
    for (const f of report.filesWritten) console.log(`    + ${f}`);
  }
  if (report.filesSkipped.length > 0) {
    console.log(`  Preserved ${report.filesSkipped.length} existing file(s)`);
  }
  if (report.gitignoreUpdated) {
    console.log('  Updated .gitignore');
  }
  console.log('');
  console.log('Next: review wiki/WIKI.md sources config, then run:');
  console.log(`  sps wiki update ${projectName}`);
}

// ─── Subcommand: update ───────────────────────────────────────────

export interface WikiUpdateOptions {
  /** Skip Worker invocation; just print the diff */
  readonly plan?: boolean;
  /** Re-scan and rewrite manifest from current FS state (post-Worker finalize) */
  readonly finalize?: boolean;
  readonly json?: boolean;
}

interface UpdatePlan {
  readonly added: string[];
  readonly changed: string[];
  readonly removed: string[];
  readonly unchanged: string[];
  readonly emptyPatterns: string[];
}

export function executeWikiUpdate(
  projectName: string,
  opts: WikiUpdateOptions = {},
): void {
  const target = resolveTarget(projectName);
  const wikiPresent = existsSync(resolve(target.repoDir, 'wiki', 'WIKI.md'));
  if (!wikiPresent) {
    throw new Error(
      `wiki/WIKI.md missing — run "sps wiki init ${projectName}" first.`,
    );
  }

  const { sources, emptyPatterns } = discoverSources(target.repoDir);
  const manifestPath = wikiManifestFile(target.repoDir);
  const manifest = readManifest(manifestPath, (msg) =>
    console.warn(`  ⚠ ${msg}`),
  );
  const diff = diffAgainstManifest(sources, manifest);

  const plan: UpdatePlan = {
    added: [...diff.added],
    changed: [...diff.changed],
    removed: [...diff.removed],
    unchanged: [...diff.unchanged],
    emptyPatterns: [...emptyPatterns],
  };

  if (opts.finalize) {
    finalizeManifest(target.repoDir, sources, manifest, manifestPath);
    if (!opts.json) {
      console.log(`✓ Manifest finalized: ${sources.length} source(s) tracked`);
    } else {
      console.log(JSON.stringify({ ...plan, finalized: true }, null, 2));
    }
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  printPlan(plan, projectName);
}

function finalizeManifest(
  repoDir: string,
  sources: readonly { path: string; hash?: string }[],
  prev: Manifest,
  manifestPath: string,
): void {
  const now = new Date().toISOString();
  const next: Manifest = {
    version: 1,
    updated_at: now,
    sources: {},
  };
  for (const s of sources) {
    if (!s.hash) continue;
    const existing = prev.sources[s.path];
    next.sources[s.path] = {
      type: existing?.type ?? 'unknown',
      sha256: s.hash,
      ingested_at: existing?.sha256 === s.hash ? (existing.ingested_at ?? now) : now,
      pages: existing?.pages ?? [],
    };
  }
  writeManifest(manifestPath, next);
  try {
    appendLog(repoDir, {
      action: 'update',
      target: 'wiki/.manifest.json',
      message: `Finalized manifest with ${Object.keys(next.sources).length} source(s)`,
    });
  } catch {
    // non-fatal
  }
}

function printPlan(plan: UpdatePlan, projectName: string): void {
  const totalChanged = plan.added.length + plan.changed.length + plan.removed.length;
  console.log(`Wiki source diff for "${projectName}":`);
  console.log(`  ${plan.added.length} added · ${plan.changed.length} changed · ${plan.removed.length} removed · ${plan.unchanged.length} unchanged`);
  console.log('');

  if (plan.added.length > 0) {
    console.log('Added:');
    for (const p of plan.added.slice(0, 50)) console.log(`  + ${p}`);
    if (plan.added.length > 50) console.log(`  … (+${plan.added.length - 50} more)`);
    console.log('');
  }
  if (plan.changed.length > 0) {
    console.log('Changed:');
    for (const p of plan.changed.slice(0, 50)) console.log(`  ~ ${p}`);
    if (plan.changed.length > 50) console.log(`  … (+${plan.changed.length - 50} more)`);
    console.log('');
  }
  if (plan.removed.length > 0) {
    console.log('Removed:');
    for (const p of plan.removed.slice(0, 50)) console.log(`  - ${p}`);
    if (plan.removed.length > 50) console.log(`  … (+${plan.removed.length - 50} more)`);
    console.log('');
  }
  if (plan.emptyPatterns.length > 0) {
    console.log('Patterns matched 0 files (check WIKI.md):');
    for (const p of plan.emptyPatterns) console.log(`  ? ${p}`);
    console.log('');
  }

  if (totalChanged === 0) {
    console.log('✓ Wiki is up to date.');
    return;
  }

  console.log('Next steps:');
  console.log('  1. Open the wiki-update skill to ingest these sources via Worker');
  console.log('     (the skill walks Worker through reading sources + writing pages)');
  console.log(`  2. After pages are written, run:`);
  console.log(`        sps wiki update ${projectName} --finalize`);
  console.log('     to flush the manifest with current FS state.');
}

// ─── Subcommand: read ─────────────────────────────────────────────

export interface WikiReadOptions {
  readonly query: string;
  readonly skills?: readonly string[];
  readonly pinned?: readonly string[];
  readonly json?: boolean;
  readonly budgetTokens?: number;
}

export function executeWikiRead(projectName: string, opts: WikiReadOptions): void {
  const target = resolveTarget(projectName);
  const ctx = wikiRead(
    {
      repoDir: target.repoDir,
      cardTitle: opts.query,
      cardDesc: '',
      cardSkills: opts.skills ?? [],
      pinnedPages: opts.pinned ?? [],
    },
    opts.budgetTokens ? { budgetTokens: opts.budgetTokens } : {},
  );

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          tokensEstimate: ctx.tokensEstimate,
          hot: ctx.hot,
          indexSummary: ctx.indexSummary,
          pages: ctx.pages,
        },
        null,
        2,
      ),
    );
    return;
  }

  const md = formatWikiContext(ctx);
  console.log(md);
  console.error(
    `\n— ${ctx.pages.length} page(s) · ~${ctx.tokensEstimate} token(s)`,
  );
}

// ─── Subcommand: check ────────────────────────────────────────────

export interface WikiCheckOptions {
  readonly json?: boolean;
  /** Reserved for future auto-fix; v0 only reports. */
  readonly fix?: boolean;
}

export function executeWikiCheck(
  projectName: string,
  opts: WikiCheckOptions = {},
): void {
  const target = resolveTarget(projectName);
  const pages = listValidPages(target.repoDir);
  const manifest = readManifest(wikiManifestFile(target.repoDir));
  const report = lintWiki({ pages, manifest, repoDir: target.repoDir });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printLintReport(report);
  }

  if (opts.fix) {
    console.error(
      '\nNote: --fix is not yet implemented. Open issues are reported above; resolve manually.',
    );
  }

  // Exit code is set by the caller (router); leave that to main.ts after
  // we throw / return.
  if (report.errorCount > 0) {
    throw new LintFailure(report);
  }
}

class LintFailure extends Error {
  constructor(public readonly report: LintReport) {
    super(`Wiki lint failed: ${report.errorCount} error(s), ${report.warnCount} warning(s)`);
    this.name = 'LintFailure';
  }
}

function printLintReport(report: LintReport): void {
  if (report.issues.length === 0) {
    console.log('✓ Wiki check passed: no issues.');
    return;
  }
  console.log(
    `Wiki check: ${report.errorCount} error(s), ${report.warnCount} warning(s)`,
  );
  console.log(
    `  by kind — orphan: ${report.counts.orphan}, dead-link: ${report.counts['dead-link']}, fm-gap: ${report.counts['fm-gap']}, stale: ${report.counts.stale}`,
  );
  console.log('');

  const grouped = new Map<string, LintIssue[]>();
  for (const issue of report.issues) {
    const key = issue.kind;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(issue);
  }
  for (const [kind, list] of grouped) {
    console.log(`── ${kind} (${list.length}) ──`);
    for (const i of list.slice(0, 30)) {
      const sev = i.severity === 'error' ? '✗' : '!';
      const where = i.pageId ?? i.target ?? '(repo)';
      console.log(`  ${sev} [${where}] ${i.message}`);
    }
    if (list.length > 30) console.log(`  … (+${list.length - 30} more)`);
    console.log('');
  }
}

// ─── Subcommand: add ──────────────────────────────────────────────

export interface WikiAddOptions {
  readonly src: string;
  /** Subdir under .raw/ to drop the file in (default: 'misc') */
  readonly category?: string;
  /** Suppress the post-copy update --plan invocation */
  readonly noIngest?: boolean;
  readonly json?: boolean;
}

export function executeWikiAdd(projectName: string, opts: WikiAddOptions): void {
  const target = resolveTarget(projectName);
  if (!existsSync(resolve(target.repoDir, 'wiki', 'WIKI.md'))) {
    throw new Error(
      `wiki/WIKI.md missing — run "sps wiki init ${projectName}" first.`,
    );
  }

  const srcPath = isAbsolute(opts.src) ? opts.src : resolve(process.cwd(), opts.src);
  if (!existsSync(srcPath)) {
    throw new Error(`Source not found: ${srcPath}`);
  }
  const st = statSync(srcPath);
  if (!st.isFile()) {
    throw new Error(`Source must be a file (got: ${srcPath})`);
  }

  const category = (opts.category ?? 'misc').replace(/[^a-z0-9_-]/gi, '_');
  const destDir = resolve(wikiRawDir(target.repoDir), category);
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  const destPath = resolve(destDir, basename(srcPath));

  copyFileSync(srcPath, destPath);
  try {
    appendLog(target.repoDir, {
      action: 'add',
      target: destPath,
      message: `Copied ${basename(srcPath)} → wiki/.raw/${category}/`,
    });
  } catch {
    // non-fatal
  }

  const result = {
    src: srcPath,
    dest: destPath,
    category,
  };

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`✓ Copied: ${srcPath}`);
    console.log(`         → ${destPath}`);
    if (!opts.noIngest) {
      console.log('');
      console.log(`Run \`sps wiki update ${projectName}\` to ingest the new source.`);
    }
  }
}

// ─── Subcommand: list ─────────────────────────────────────────────

export interface WikiListOptions {
  readonly type?: string;
  readonly tag?: string;
  readonly json?: boolean;
}

export function executeWikiList(
  projectName: string,
  opts: WikiListOptions = {},
): void {
  const target = resolveTarget(projectName);
  const types = opts.type ? [opts.type as PageType] : undefined;
  const pages = listValidPages(target.repoDir, types ? { types } : {});
  const filtered = opts.tag
    ? pages.filter((p) =>
        p.frontmatter.tags.some((t) => t.toLowerCase() === opts.tag!.toLowerCase()),
      )
    : pages;

  filtered.sort((a, b) => a.pageId.localeCompare(b.pageId));

  if (opts.json) {
    const out = filtered.map((p) => ({
      pageId: p.pageId,
      title: p.frontmatter.title,
      type: p.frontmatter.type,
      tags: p.frontmatter.tags,
      status: p.frontmatter.status,
    }));
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (filtered.length === 0) {
    console.log('(no pages match)');
    return;
  }

  for (const p of filtered) {
    const tags = p.frontmatter.tags.length > 0 ? `[${p.frontmatter.tags.join(', ')}]` : '';
    console.log(
      `  ${p.frontmatter.type.padEnd(8)} ${p.pageId.padEnd(40)} ${p.frontmatter.status.padEnd(11)} ${tags}`,
    );
  }
  console.log(`\n— ${filtered.length} page(s)`);
}

// ─── Subcommand: get ──────────────────────────────────────────────

export interface WikiGetOptions {
  readonly pageId: string;
  readonly json?: boolean;
}

export function executeWikiGet(projectName: string, opts: WikiGetOptions): void {
  const target = resolveTarget(projectName);
  const page = getPageById(target.repoDir, opts.pageId);
  if (!page) {
    throw new Error(`Page not found: ${opts.pageId}`);
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          pageId: page.pageId,
          filePath: page.filePath,
          frontmatter: page.frontmatter,
          body: page.body,
        },
        null,
        2,
      ),
    );
    return;
  }

  // Print the raw file contents to stdout (frontmatter + body)
  const raw = readFileSync(page.filePath, 'utf-8');
  console.log(raw);
}

// ─── Subcommand: status ───────────────────────────────────────────

export interface WikiStatusOptions {
  readonly json?: boolean;
}

export function executeWikiStatus(
  projectName: string,
  opts: WikiStatusOptions = {},
): void {
  const target = resolveTarget(projectName);
  const wikiPresent = existsSync(resolve(target.repoDir, 'wiki', 'WIKI.md'));
  if (!wikiPresent) {
    throw new Error(
      `wiki/WIKI.md missing — run "sps wiki init ${projectName}" first.`,
    );
  }

  const { sources } = discoverSources(target.repoDir);
  const manifest = readManifest(wikiManifestFile(target.repoDir));
  const diff = diffAgainstManifest(sources, manifest);
  const pages = listValidPages(target.repoDir);
  const outdated = findOutdatedPages(manifest, pages, target.repoDir);

  const status = {
    pages: pages.length,
    sources: sources.length,
    sourcesTracked: Object.keys(manifest.sources).length,
    diff: {
      added: diff.added.length,
      changed: diff.changed.length,
      removed: diff.removed.length,
      unchanged: diff.unchanged.length,
    },
    outdated: outdated.map((o) => ({
      sourcePath: o.sourcePath,
      pageIds: o.pageIds,
      sourceMtime: o.sourceMtime.toISOString(),
    })),
  };

  if (opts.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  console.log(`Wiki status — ${projectName}`);
  console.log(`  Pages tracked: ${status.pages}`);
  console.log(`  Sources discovered: ${status.sources}`);
  console.log(`  Sources in manifest: ${status.sourcesTracked}`);
  console.log('');
  console.log(
    `  Diff: +${status.diff.added} ~${status.diff.changed} -${status.diff.removed} =${status.diff.unchanged}`,
  );
  if (status.diff.added + status.diff.changed + status.diff.removed > 0) {
    console.log(`  Run \`sps wiki update ${projectName}\` to see details.`);
  }
  if (status.outdated.length > 0) {
    console.log('');
    console.log(`  Pages with stale source (${status.outdated.length}):`);
    for (const o of status.outdated.slice(0, 10)) {
      console.log(`    ${o.sourcePath}`);
      for (const pid of o.pageIds) console.log(`      → ${pid}`);
    }
    if (status.outdated.length > 10) {
      console.log(`    … (+${status.outdated.length - 10} more)`);
    }
  }
}

// ─── Router ───────────────────────────────────────────────────────

export interface WikiRouteArgs {
  /** Subcommand: init / update / read / check / add / list / get / status */
  readonly subcommand: string | null;
  /** Project name */
  readonly project: string;
  /** Positional args after project */
  readonly positionals: readonly string[];
  /** Boolean flag map */
  readonly flags: Record<string, boolean>;
  /** Optional skills array (parsed by main.ts from --skills) */
  readonly skills?: readonly string[];
  /** Optional pinned pages array */
  readonly pinned?: readonly string[];
  /** Optional budget tokens override */
  readonly budgetTokens?: number;
  /** Filter values for list */
  readonly type?: string;
  readonly tag?: string;
  /** Add subcommand options */
  readonly category?: string;
}

/**
 * Dispatches to the correct subcommand. Throws on usage errors so main.ts can
 * print + exit(2).
 */
export function executeWikiCommand(args: WikiRouteArgs): void {
  const sub = args.subcommand;
  if (!sub) {
    throw new Error(
      'Usage: sps wiki <init|update|read|check|add|list|get|status> <project> [args]',
    );
  }

  if (sub === 'init') {
    executeWikiInit(args.project, { json: args.flags.json });
    return;
  }

  if (sub === 'update') {
    executeWikiUpdate(args.project, {
      plan: args.flags.plan,
      finalize: args.flags.finalize,
      json: args.flags.json,
    });
    return;
  }

  if (sub === 'read') {
    const query = args.positionals.join(' ').trim();
    if (!query) {
      throw new Error(`Usage: sps wiki read <project> "<query>"`);
    }
    executeWikiRead(args.project, {
      query,
      skills: args.skills,
      pinned: args.pinned,
      json: args.flags.json,
      budgetTokens: args.budgetTokens,
    });
    return;
  }

  if (sub === 'check') {
    executeWikiCheck(args.project, {
      json: args.flags.json,
      fix: args.flags.fix,
    });
    return;
  }

  if (sub === 'add') {
    const src = args.positionals[0];
    if (!src) {
      throw new Error(
        'Usage: sps wiki add <project> <file> [--category <name>] [--no-ingest]',
      );
    }
    executeWikiAdd(args.project, {
      src,
      category: args.category,
      noIngest: args.flags['no-ingest'],
      json: args.flags.json,
    });
    return;
  }

  if (sub === 'list') {
    executeWikiList(args.project, {
      type: args.type,
      tag: args.tag,
      json: args.flags.json,
    });
    return;
  }

  if (sub === 'get') {
    const pageId = args.positionals[0];
    if (!pageId) {
      throw new Error('Usage: sps wiki get <project> <pageId>');
    }
    executeWikiGet(args.project, {
      pageId,
      json: args.flags.json,
    });
    return;
  }

  if (sub === 'status') {
    executeWikiStatus(args.project, { json: args.flags.json });
    return;
  }

  throw new Error(
    `Unknown wiki subcommand: "${sub}". Expected one of: init, update, read, check, add, list, get, status.`,
  );
}
