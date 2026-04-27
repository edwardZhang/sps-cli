/**
 * @module        core/wiki/linter
 * @description   Wiki lint：orphan / dead link / frontmatter gap / stale 检查
 *
 * @layer         core
 *
 * doc-28 §10 wiki check 的代码实现。纯函数（除文件 mtime 读取）：给一组 Page +
 * manifest，返一份 Report。
 *
 * 四类问题：
 *   - orphan       — 页未被任何其他页 related[] 或 body wikilink 引用
 *   - dead-link    — wikilink 指向不存在的 page
 *   - fm-gap       — frontmatter 缺关键字段（其实 zod schema 已校验，这里防漏）
 *   - stale        — manifest 里 source 的 hash 跟当前文件不一致（content drift）
 *
 * 不做：
 *   - 自动修复（删 dead link、合并 orphan）—— 安全交给人决定
 *   - 跨项目检查
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { tryHashFile } from './manifest.js';
import type { Manifest, Page } from './types.js';

// ─── Issue types ──────────────────────────────────────────────────

export type IssueKind = 'orphan' | 'dead-link' | 'fm-gap' | 'stale';
export type IssueSeverity = 'warn' | 'error';

export interface LintIssue {
  readonly kind: IssueKind;
  readonly severity: IssueSeverity;
  /** Page id where issue was found; null when issue is repo-level (e.g. stale source) */
  readonly pageId: string | null;
  /** One-line message */
  readonly message: string;
  /** Optional context: target page id / source path / field name */
  readonly target?: string;
}

export interface LintReport {
  readonly issues: readonly LintIssue[];
  /** Counts grouped by kind for fast summary */
  readonly counts: Record<IssueKind, number>;
  readonly errorCount: number;
  readonly warnCount: number;
}

// ─── Public API ───────────────────────────────────────────────────

export interface LintInput {
  readonly pages: readonly Page[];
  readonly manifest: Manifest;
  readonly repoDir: string;
}

export function lintWiki(input: LintInput): LintReport {
  const issues: LintIssue[] = [];
  issues.push(...checkOrphans(input.pages));
  issues.push(...checkDeadLinks(input.pages));
  issues.push(...checkFrontmatterGaps(input.pages));
  issues.push(...checkStaleSources(input.manifest, input.repoDir));
  return summarize(issues);
}

// ─── Orphan detection ────────────────────────────────────────────

/**
 * Orphan = page that nobody links to (via frontmatter related[] OR body wikilink).
 *
 * A solo page can still be valuable (e.g. just-written lesson) — orphan is **warn**,
 * not error.
 */
export function checkOrphans(pages: readonly Page[]): LintIssue[] {
  const ids = new Set(pages.map((p) => p.pageId));
  const refCount = new Map<string, number>();
  for (const id of ids) refCount.set(id, 0);

  for (const p of pages) {
    // related[] is wikilinks "[[Page Name]]" — strip brackets and check both
    // bare-title and "type/title" forms against ids.
    for (const link of p.frontmatter.related) {
      const target = resolveLinkToId(link, ids);
      if (target) refCount.set(target, (refCount.get(target) ?? 0) + 1);
    }
    // Body wikilinks
    for (const link of extractBodyWikilinks(p.body)) {
      const target = resolveLinkToId(`[[${link}]]`, ids);
      if (target) refCount.set(target, (refCount.get(target) ?? 0) + 1);
    }
  }

  const out: LintIssue[] = [];
  for (const [pageId, count] of refCount) {
    if (count === 0) {
      out.push({
        kind: 'orphan',
        severity: 'warn',
        pageId,
        message: `Page "${pageId}" is not referenced by any other page.`,
      });
    }
  }
  return out;
}

// ─── Dead-link detection ─────────────────────────────────────────

/**
 * Dead link = wikilink "[[X]]" where X (resolved) is not in the page set.
 *
 * Errors for related[] (frontmatter); warnings for body links (in-flight writing).
 */
export function checkDeadLinks(pages: readonly Page[]): LintIssue[] {
  const ids = new Set(pages.map((p) => p.pageId));
  const out: LintIssue[] = [];
  for (const p of pages) {
    for (const link of p.frontmatter.related) {
      if (!resolveLinkToId(link, ids)) {
        out.push({
          kind: 'dead-link',
          severity: 'error',
          pageId: p.pageId,
          target: link,
          message: `frontmatter related: "${link}" does not resolve to any page.`,
        });
      }
    }
    for (const link of extractBodyWikilinks(p.body)) {
      if (!resolveLinkToId(`[[${link}]]`, ids)) {
        out.push({
          kind: 'dead-link',
          severity: 'warn',
          pageId: p.pageId,
          target: link,
          message: `body wikilink: "[[${link}]]" does not resolve.`,
        });
      }
    }
  }
  return out;
}

// ─── Frontmatter gap detection ───────────────────────────────────

/**
 * Catches missing soft-required fields the zod schema can't enforce
 * (e.g. empty title, empty TL;DR, all default tags). Schema-level errors
 * are caught at parse time — this is a content sniff.
 */
export function checkFrontmatterGaps(pages: readonly Page[]): LintIssue[] {
  const out: LintIssue[] = [];
  for (const p of pages) {
    const fm = p.frontmatter;
    if (!fm.title.trim()) {
      out.push({
        kind: 'fm-gap',
        severity: 'error',
        pageId: p.pageId,
        target: 'title',
        message: 'frontmatter title is empty.',
      });
    }
    if (fm.tags.length === 0) {
      out.push({
        kind: 'fm-gap',
        severity: 'warn',
        pageId: p.pageId,
        target: 'tags',
        message: 'frontmatter tags is empty (page won\'t match any skill).',
      });
    }
    if (!hasTLDR(p.body)) {
      out.push({
        kind: 'fm-gap',
        severity: 'warn',
        pageId: p.pageId,
        target: 'body',
        message: 'body has no `## TL;DR` section (search/preview will use fallback).',
      });
    }
  }
  return out;
}

// ─── Stale source detection ──────────────────────────────────────

/**
 * Compare manifest's stored sha256 against current file hash on disk.
 * Mismatch = source has drifted since last ingest → its derived pages may be stale.
 *
 * Files that don't exist on disk anymore are flagged as 'stale' too (they should
 * be removed from manifest via finalize).
 */
export function checkStaleSources(manifest: Manifest, repoDir: string): LintIssue[] {
  const out: LintIssue[] = [];
  for (const [path, entry] of Object.entries(manifest.sources)) {
    const abs = resolve(repoDir, path);
    if (!existsSync(abs)) {
      out.push({
        kind: 'stale',
        severity: 'warn',
        pageId: null,
        target: path,
        message: `Source "${path}" no longer exists. Run \`sps wiki update <project> --finalize\` to clean.`,
      });
      continue;
    }
    const currentHash = tryHashFile(abs);
    if (currentHash && currentHash !== entry.sha256) {
      // Best effort: include affected pages
      const affected = entry.pages.length > 0 ? ` (affects: ${entry.pages.join(', ')})` : '';
      out.push({
        kind: 'stale',
        severity: 'warn',
        pageId: null,
        target: path,
        message: `Source "${path}" has changed since ingest${affected}.`,
      });
    }
  }
  return out;
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Resolve a "[[X]]" or "[[type/X]]" wikilink against the known pageId set.
 *
 * Strategy:
 *   - "[[type/X]]" → look up exact pageId
 *   - "[[X]]" → look up any pageId ending with "/X" (any type matches)
 *
 * Returns the resolved pageId, or null if unresolvable.
 */
export function resolveLinkToId(
  wikilink: string,
  ids: ReadonlySet<string>,
): string | null {
  const m = wikilink.match(/^\[\[([^[\]]+)\]\]$/);
  if (!m) return null;
  const target = m[1]!.trim();
  if (target.includes('/')) {
    return ids.has(target) ? target : null;
  }
  // No prefix — find any pageId whose title matches
  for (const id of ids) {
    const slash = id.lastIndexOf('/');
    if (slash >= 0 && id.slice(slash + 1) === target) return id;
  }
  return null;
}

const BODY_LINK_RE = /\[\[([^[\]]+)\]\]/g;

export function extractBodyWikilinks(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(BODY_LINK_RE)) {
    out.push(m[1]!.trim());
  }
  return out;
}

const TLDR_RE = /^##\s+TL;DR\b/m;
function hasTLDR(body: string): boolean {
  return TLDR_RE.test(body);
}

function summarize(issues: readonly LintIssue[]): LintReport {
  const counts: Record<IssueKind, number> = {
    orphan: 0,
    'dead-link': 0,
    'fm-gap': 0,
    stale: 0,
  };
  let errorCount = 0;
  let warnCount = 0;
  for (const i of issues) {
    counts[i.kind] += 1;
    if (i.severity === 'error') errorCount += 1;
    else warnCount += 1;
  }
  return { issues: [...issues], counts, errorCount, warnCount };
}

// ─── Mtime helper (used by status command) ────────────────────────

/**
 * Compare source mtime vs page mtime. Returns paths whose source is newer.
 *
 * Best-effort — file mtime precision varies (ext4 ns vs HFS+ 1s); we use a
 * 60s threshold to avoid false positives.
 */
export function findOutdatedPages(
  manifest: Manifest,
  pages: readonly Page[],
  repoDir: string,
  thresholdMs = 60_000,
): { sourcePath: string; pageIds: string[]; sourceMtime: Date }[] {
  const out: { sourcePath: string; pageIds: string[]; sourceMtime: Date }[] = [];
  const pageMtimeById = new Map<string, Date>();
  for (const p of pages) {
    try {
      pageMtimeById.set(p.pageId, statSync(p.filePath).mtime);
    } catch {
      // ignore
    }
  }

  for (const [sourcePath, entry] of Object.entries(manifest.sources)) {
    if (entry.pages.length === 0) continue;
    let sourceMtime: Date;
    try {
      sourceMtime = statSync(resolve(repoDir, sourcePath)).mtime;
    } catch {
      continue;
    }
    const outdated: string[] = [];
    for (const pid of entry.pages) {
      const pmtime = pageMtimeById.get(pid);
      if (!pmtime) continue;
      if (sourceMtime.getTime() - pmtime.getTime() > thresholdMs) outdated.push(pid);
    }
    if (outdated.length > 0) out.push({ sourcePath, pageIds: outdated, sourceMtime });
  }
  return out;
}
