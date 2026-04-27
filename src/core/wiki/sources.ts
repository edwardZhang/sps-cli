/**
 * @module        core/wiki/sources
 * @description   Wiki 源材料发现：扫 WIKI.md sources 模式 → 文件列表 + diff
 *
 * @layer         core
 *
 * 不依赖 micromatch / fast-glob —— SPS 模式很简单（**+扩展名过滤），手写够用且
 * 避免再多 50 KB 依赖。
 *
 * 支持的模式：
 *   - "src/**\/*.ts"        递归 + 扩展名过滤
 *   - "src/**"              递归全部
 *   - "docs/*.md"           平铺扩展名过滤
 *   - "README.md"           字面量
 *
 * 不支持（也不需要）：
 *   - { } alternation, [chars] character class, ! negation
 *   - 多扩展名（"*.{ts,tsx}"）—— 用两条 pattern 代替
 *
 * **路径都相对 repoDir**——manifest 里也用相对路径，跨机器一致。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { wikiMetaFile } from '../../shared/wikiPaths.js';
import { type DiffInputSource, diffSources, hashFile } from './manifest.js';
import type { Manifest, SourceDiff } from './types.js';

// ─── Source category ──────────────────────────────────────────────

/** WIKI.md sources 字段定义的 4 个 bucket */
export type SourceCategory = 'code' | 'doc' | 'raw' | 'data';

export interface DiscoveredSource {
  /** Path relative to repoDir, posix-style */
  readonly path: string;
  /** Which sources bucket the file belongs to */
  readonly category: SourceCategory;
  /** sha256 hex; computed lazily by callers (use hashSource) */
  readonly hash?: string;
}

// ─── WIKI.md parsing ──────────────────────────────────────────────

export interface SourcesConfig {
  /** Globs per bucket; absent bucket = empty array */
  readonly code: readonly string[];
  readonly doc: readonly string[];
  readonly raw: readonly string[];
  readonly data: readonly string[];
}

const EMPTY_SOURCES: SourcesConfig = { code: [], doc: [], raw: [], data: [] };

/**
 * 从 WIKI.md 顶部 frontmatter 抽 sources 配置。
 *
 * 容错：
 *   - WIKI.md 不存在 → 返默认（空配置）
 *   - frontmatter 缺失 / sources 字段缺失 → 返默认
 *   - 类型不对（非数组 / 非字符串）→ 跳过该 bucket
 */
export function readSourcesConfig(repoDir: string): SourcesConfig {
  const path = wikiMetaFile(repoDir);
  if (!existsSync(path)) return EMPTY_SOURCES;

  const content = readFileSync(path, 'utf-8');
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return EMPTY_SOURCES;

  let parsed: unknown;
  try {
    parsed = parseYaml(fmMatch[1]!);
  } catch {
    return EMPTY_SOURCES;
  }

  if (!parsed || typeof parsed !== 'object') return EMPTY_SOURCES;
  const obj = parsed as Record<string, unknown>;
  const sources = obj.sources;
  if (!sources || typeof sources !== 'object') return EMPTY_SOURCES;

  const buckets = sources as Record<string, unknown>;
  return {
    code: pickStringArray(buckets.code),
    doc: pickStringArray(buckets.doc),
    raw: pickStringArray(buckets.raw),
    data: pickStringArray(buckets.data),
  };
}

function pickStringArray(v: unknown): readonly string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

// ─── Glob matcher (minimal, no deps) ──────────────────────────────

interface ParsedPattern {
  /** Anchor directory relative to repoDir (no trailing slash) */
  readonly base: string;
  /** Should match recursively? (true if pattern contains ** ) */
  readonly recursive: boolean;
  /** Optional file extension filter (e.g. ".ts"); '' for all files */
  readonly extension: string;
  /** Original pattern (for debug) */
  readonly raw: string;
}

/**
 * Parse a simple glob pattern into base + recursion + extension filter.
 *
 * Examples:
 *   "src/**\/*.ts"  → base=src,  recursive=true,  ext=.ts
 *   "src/**"        → base=src,  recursive=true,  ext=''
 *   "docs/*.md"     → base=docs, recursive=false, ext=.md
 *   "README.md"     → base=.,    recursive=false, ext=.md  (treated as flat single)
 *
 * Unsupported patterns (e.g. with `{}`) are passed through but won't match anything.
 */
export function parsePattern(pattern: string): ParsedPattern {
  const norm = pattern.replace(/\\/g, '/').trim();
  const recursive = norm.includes('**');

  // Strip trailing pattern segments
  let base = norm;
  let ext = '';

  // Pull off the file pattern (last segment)
  const lastSlash = norm.lastIndexOf('/');
  const lastSeg = lastSlash >= 0 ? norm.slice(lastSlash + 1) : norm;
  const beforeLast = lastSlash >= 0 ? norm.slice(0, lastSlash) : '';

  if (lastSeg === '*' || lastSeg === '**') {
    ext = '';
    base = beforeLast.replace(/\/\*\*$/, '');
  } else if (/^\*\.[a-z0-9]+$/i.test(lastSeg)) {
    ext = lastSeg.slice(1);
    base = beforeLast.replace(/\/\*\*$/, '');
  } else if (recursive) {
    // pattern like "src/**/file.md" or "src/**/foo/bar.md" — we don't fully
    // support; treat as recursive over base, no ext filter, callers can post-filter.
    ext = '';
    base = norm.replace(/\/\*\*.*$/, '');
  } else {
    // Literal path
    ext = '';
    base = norm;
  }

  if (base === '' || base === '.') base = '.';
  return { base, recursive, extension: ext, raw: pattern };
}

/**
 * Walk filesystem from `repoDir/<base>` and collect files that match the pattern.
 *
 * - Skips dotfiles starting with `.` UNLESS the base itself starts with `.`
 *   (e.g. wiki/.raw/** — user wants those).
 * - Always skips node_modules / .git anywhere in the tree.
 *
 * Returns paths relative to repoDir, posix-normalized.
 */
export function expandPattern(repoDir: string, pattern: string): string[] {
  const parsed = parsePattern(pattern);
  const baseAbs = resolve(repoDir, parsed.base);

  // Literal file (e.g. README.md): just check existence
  if (!parsed.recursive && parsed.extension === '' && parsed.base !== '.') {
    if (existsSync(baseAbs)) {
      try {
        const st = statSync(baseAbs);
        if (st.isFile()) {
          return [toRelPosix(repoDir, baseAbs)];
        }
        if (st.isDirectory()) {
          return walkDir(repoDir, baseAbs, false, '', baseStartsWithDot(parsed.base));
        }
      } catch {
        return [];
      }
    }
    return [];
  }

  if (!existsSync(baseAbs)) return [];
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(baseAbs);
  } catch {
    return [];
  }
  if (!st.isDirectory()) return [];

  return walkDir(
    repoDir,
    baseAbs,
    parsed.recursive,
    parsed.extension,
    baseStartsWithDot(parsed.base),
  );
}

function baseStartsWithDot(base: string): boolean {
  // Any segment of base starts with `.` (e.g. ".raw" or "wiki/.raw")
  return base.split('/').some((s) => s.startsWith('.'));
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

function walkDir(
  repoDir: string,
  dir: string,
  recursive: boolean,
  extension: string,
  allowDotFiles: boolean,
): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    if (!allowDotFiles && name.startsWith('.')) continue;

    const abs = resolve(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (recursive) {
        out.push(...walkDir(repoDir, abs, recursive, extension, allowDotFiles));
      }
    } else if (st.isFile()) {
      if (extension && !name.endsWith(extension)) continue;
      out.push(toRelPosix(repoDir, abs));
    }
  }
  return out;
}

function toRelPosix(repoDir: string, abs: string): string {
  const rel = relative(repoDir, abs);
  return sep === '\\' ? rel.replace(/\\/g, '/') : rel;
}

// ─── Top-level discovery ──────────────────────────────────────────

export interface DiscoverResult {
  /** Discovered sources with hashes */
  readonly sources: readonly DiscoveredSource[];
  /** Patterns that returned 0 files (warning candidates) */
  readonly emptyPatterns: readonly string[];
}

/**
 * Discover all sources from WIKI.md config + hash them.
 *
 * Buckets are merged; if the same path is matched by multiple buckets, the first
 * winning bucket (in code → doc → data → raw order) is used.
 *
 * Caller is responsible for I/O fault tolerance — this throws on individual hash
 * failures only via `tryHashFile` semantics (skip).
 */
export function discoverSources(repoDir: string): DiscoverResult {
  const config = readSourcesConfig(repoDir);
  const seen = new Map<string, SourceCategory>();
  const emptyPatterns: string[] = [];

  const buckets: Array<readonly [SourceCategory, readonly string[]]> = [
    ['code', config.code],
    ['doc', config.doc],
    ['data', config.data],
    ['raw', config.raw],
  ];

  for (const [category, patterns] of buckets) {
    for (const pattern of patterns) {
      const matched = expandPattern(repoDir, pattern);
      if (matched.length === 0) {
        emptyPatterns.push(pattern);
        continue;
      }
      for (const p of matched) {
        if (!seen.has(p)) seen.set(p, category);
      }
    }
  }

  const sources: DiscoveredSource[] = [];
  for (const [path, category] of seen) {
    let hash: string;
    try {
      hash = hashFile(resolve(repoDir, path));
    } catch {
      continue; // unreadable file = drop silently
    }
    sources.push({ path, category, hash });
  }
  // Stable sort for deterministic output
  sources.sort((a, b) => a.path.localeCompare(b.path));

  return { sources, emptyPatterns };
}

// ─── Diff helper (manifest aware) ─────────────────────────────────

/**
 * Compute diff between current discovered sources and saved manifest.
 *
 * Wraps diffSources() with a typed input so callers don't have to remember
 * the DiffInputSource shape.
 */
export function diffAgainstManifest(
  sources: readonly DiscoveredSource[],
  manifest: Manifest,
): SourceDiff {
  const inputs: DiffInputSource[] = sources
    .filter((s): s is DiscoveredSource & { hash: string } => typeof s.hash === 'string')
    .map((s) => ({ path: s.path, hash: s.hash }));
  return diffSources(inputs, manifest);
}
