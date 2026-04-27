/**
 * @module        core/wiki/page
 * @description   Wiki page CRUD：读 / 写 / 列表 / 取
 *
 * @layer         core
 *
 * 这层负责文件系统操作 + frontmatter 解析。**不做** schema 推断、不做内容生成、
 * 不做检索——那些是上层 reader/searcher 的事。
 *
 * 错误策略：
 *   - 不存在的 page：返 null，调用方决定怎么处理
 *   - 损坏的 page（frontmatter 解析失败）：返 ParseFailure，**不抛**——避免一页坏阻塞 list
 *   - 写入：写前校验 frontmatter，失败时抛 FrontmatterError
 *
 * 测试要点：
 *   - round-trip：write → read → frontmatter / body 等价
 *   - 损坏 page 不影响 list 其他页
 *   - parseWikiPageId 反推一致
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  parseWikiPageId,
  type WikiPageType,
  wikiPageDir,
  wikiPageFile,
  wikiPageId,
} from '../../shared/wikiPaths.js';
import { FrontmatterError, parseFrontmatter, serializeFrontmatter } from './frontmatter.js';
import type { Frontmatter, Page, PageType } from './types.js';

// ─── 单页读取 ─────────────────────────────────────────────────────

/**
 * 读单页。文件不存在返 null。frontmatter 损坏抛 FrontmatterError。
 */
export function readPage(filePath: string): Page | null {
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(content);

  // 文件路径反推 pageId
  // 文件路径形如 .../wiki/<type>s/<title>.md ——但我们这里只有绝对 filePath，
  // 没有 repoDir 上下文。所以 pageId 通过路径基础名推：
  const pageId = inferPageIdFromPath(filePath, frontmatter);

  return { pageId, filePath, frontmatter, body };
}

/**
 * 从绝对 filePath + frontmatter.type 推 pageId。
 * 假设：filePath 形如 `<...>/<type>s/<title>.md`。
 */
function inferPageIdFromPath(filePath: string, fm: Frontmatter): string {
  const base = filePath.replace(/\.md$/, '').split('/').pop() ?? fm.title;
  return wikiPageId(fm.type as WikiPageType, base);
}

/**
 * 读单页（宽松版本）：损坏不抛，返 ParseFailure 标记。
 * 用于 list 扫描时一页坏不阻塞整体。
 */
export type ReadResult =
  | { ok: true; page: Page }
  | { ok: false; filePath: string; error: FrontmatterError };

export function tryReadPage(filePath: string): ReadResult | null {
  if (!existsSync(filePath)) return null;
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      ok: false,
      filePath,
      error: new FrontmatterError(`read failed: ${errMsg(err)}`, err),
    };
  }
  try {
    const { frontmatter, body } = parseFrontmatter(content);
    const pageId = inferPageIdFromPath(filePath, frontmatter);
    return { ok: true, page: { pageId, filePath, frontmatter, body } };
  } catch (err) {
    return {
      ok: false,
      filePath,
      error:
        err instanceof FrontmatterError
          ? err
          : new FrontmatterError(`parse failed: ${errMsg(err)}`, err),
    };
  }
}

// ─── 单页写入 ─────────────────────────────────────────────────────

/**
 * 写一页。父目录不存在自动建。frontmatter 写前 zod 校验（serializeFrontmatter 内部
 * 假设已校验，这里通过 page.frontmatter 的类型推断保证）。
 *
 * - 已存在：覆盖
 * - 不存在：创建
 *
 * 返回写入的最终 filePath（绝对路径）。
 */
export function writePage(
  repoDir: string,
  type: PageType,
  title: string,
  frontmatter: Frontmatter,
  body: string,
): string {
  if (frontmatter.type !== type) {
    throw new Error(
      `Page type mismatch: dir says "${type}" but frontmatter says "${frontmatter.type}"`,
    );
  }
  const filePath = wikiPageFile(repoDir, type, title);
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const content = serializeFrontmatter(frontmatter, body);
  writeFileSync(filePath, content, { encoding: 'utf-8', mode: 0o644 });
  return filePath;
}

/**
 * 删除一页。文件不存在 = no-op。
 */
export function deletePage(repoDir: string, type: PageType, title: string): boolean {
  const filePath = wikiPageFile(repoDir, type, title);
  if (!existsSync(filePath)) return false;
  rmSync(filePath, { force: true });
  return true;
}

// ─── 列表 ─────────────────────────────────────────────────────────

export interface ListOptions {
  /** 限定类型（默认全部 5 类） */
  readonly types?: readonly PageType[];
  /** 是否包含损坏的页（带 ok=false 的 entry）；默认 false（只返成功的） */
  readonly includeFailures?: boolean;
}

const ALL_PAGE_TYPES: readonly PageType[] = [
  'module',
  'concept',
  'decision',
  'lesson',
  'source',
];

/**
 * 列出指定项目下所有 wiki page。
 *
 * 类型 dir 不存在 → 跳过（不算错误，project 可能没创建那种类型）。
 * 单页损坏 → 默认跳过；includeFailures=true 时保留。
 */
export function listPages(repoDir: string, opts: ListOptions = {}): ReadResult[] {
  const types = opts.types ?? ALL_PAGE_TYPES;
  const out: ReadResult[] = [];

  for (const t of types) {
    const dir = wikiPageDir(repoDir, t);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.endsWith('.md')) continue;
      // _index.md 是辅助索引，不算 page
      if (name.startsWith('_')) continue;
      const filePath = resolve(dir, name);
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
      const result = tryReadPage(filePath);
      if (!result) continue;
      if (!result.ok && !opts.includeFailures) continue;
      out.push(result);
    }
  }

  return out;
}

/**
 * 仅返成功读取的页。语法糖（list 90% 场景）。
 */
export function listValidPages(repoDir: string, opts: ListOptions = {}): Page[] {
  return listPages(repoDir, { ...opts, includeFailures: false })
    .filter((r): r is { ok: true; page: Page } => r.ok)
    .map((r) => r.page);
}

// ─── 按 id 取 ─────────────────────────────────────────────────────

/**
 * 按 pageId（如 "modules/PipelineService"）查找 page。
 * 自动从 id 拆出 type 和 title。
 */
export function getPageById(repoDir: string, pageId: string): Page | null {
  const slashIdx = pageId.indexOf('/');
  if (slashIdx === -1) return null;
  const typeWithS = pageId.slice(0, slashIdx);
  const title = pageId.slice(slashIdx + 1);
  // typeWithS 是复数（"modules"），去 s 得到 type
  if (!typeWithS.endsWith('s')) return null;
  const type = typeWithS.slice(0, -1) as PageType;
  if (!ALL_PAGE_TYPES.includes(type)) return null;

  const filePath = wikiPageFile(repoDir, type, title);
  return readPage(filePath);
}

/**
 * 按 wikilink "[[Page Name]]" 查找 page。会扫所有 type 直到找到第一个 title 匹配。
 * 用于解析 frontmatter related 字段或 body 里的 wikilink。
 *
 * Wikilink 可以带 type 前缀 "[[modules/PipelineService]]" —— 这种走 getPageById。
 */
export function findPageByWikilink(repoDir: string, wikilink: string): Page | null {
  const stripped = wikilink.replace(/^\[\[/, '').replace(/\]\]$/, '');
  if (stripped.includes('/')) {
    return getPageById(repoDir, stripped);
  }
  // 无前缀：扫所有 type 找 title 匹配（注意可能多个 type 同名，按数组顺序取第一个）
  for (const type of ALL_PAGE_TYPES) {
    const filePath = wikiPageFile(repoDir, type, stripped);
    if (existsSync(filePath)) {
      return readPage(filePath);
    }
  }
  return null;
}

// ─── 反向查询：路径 → page meta ───────────────────────────────────

/**
 * 给定文件绝对路径，反推 pageId（type + title）。
 * 无效路径返 null。
 */
export function resolvePageId(
  repoDir: string,
  filePath: string,
): { type: PageType; title: string; pageId: string } | null {
  return parseWikiPageId(repoDir, filePath);
}

// ─── helpers ──────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
