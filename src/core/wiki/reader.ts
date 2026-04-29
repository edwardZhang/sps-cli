/**
 * @module        core/wiki/reader
 * @description   wikiRead()：5 层确定性检索 + 类型优先级 + token 预算
 *
 * @layer         core
 *
 * doc-28 §10 Wiki 读取原则的代码实现。**这是 Worker prompt 注入的入口**。
 *
 * 5 层叠加：
 *   L1 永远 — hot.md 全文                           ~500 字
 *   L2 永远 — index.md 节选 top-N 行                ~500 字
 *   L3 优先 — pinned wiki_pages（card frontmatter）  ~50×N 字
 *   L4 按 skill — 卡 skills ∩ 页 tags → top-3        ~50×3 字
 *   L5 按关键词 — BM25(card.title + card.desc)→top-3 ~50×3 字
 *
 * 优先级排序（命中多页）：
 *   lesson = 3 / decision = 3 / concept = 2 / module = 1 / source = 1
 *   stale page → 跳过（status=stale 或 mtime 太老）
 *
 * Token 预算硬上限 1500 字（~2000 token），超出砍 L5 keyword 命中。
 *
 * 设计原则（Karpathy）：
 *   - **确定性**——同输入同输出，纯函数（除文件 I/O）
 *   - **Push 而非 Pull**——Worker 不需要学怎么查，结果已经摆好
 *   - **TL;DR 而非全文**——让 Worker 自己决定要不要 Read 完整 page
 */

import { readHot } from './hot.js';
import { readIndexSummary } from './index-builder.js';
import { getPageById, listValidPages } from './page.js';
import { extractTLDR, WikiSearcher } from './searcher.js';
import type { Page, PageType } from './types.js';

// ─── Input / Output ───────────────────────────────────────────────

export interface ReadInput {
  /** Repo 根目录（用于查 wiki/） */
  readonly repoDir: string;
  /** 当前卡片 title + description（用作 BM25 查询） */
  readonly cardTitle: string;
  readonly cardDesc: string;
  /** 卡 frontmatter 的 skills（用作 tag 匹配） */
  readonly cardSkills: readonly string[];
  /** 卡 labels（暂未用，预留扩展） */
  readonly cardLabels?: readonly string[];
  /** 卡 frontmatter wiki_pages 显式 pin 的 page ids */
  readonly pinnedPages?: readonly string[];
}

export interface PageContextEntry {
  readonly pageId: string;
  readonly title: string;
  readonly type: PageType;
  readonly tldr: string;
  /** 命中来源——用于 prompt 渲染时分组显示 */
  readonly source: 'pinned' | 'skill' | 'keyword';
  /** 内部排序权重（debug） */
  readonly priority: number;
}

export interface WikiContext {
  /** L1: hot.md 全文 */
  readonly hot: string;
  /** L2: index.md 节选 top-N 行 */
  readonly indexSummary: string;
  /** L3+L4+L5 合并去重 + 预算后的 page 列表 */
  readonly pages: readonly PageContextEntry[];
  /** 可观察性：本次注入的 token 预估 */
  readonly tokensEstimate: number;
}

// ─── Configuration ────────────────────────────────────────────────

export interface ReadOptions {
  /** Layer 2 节选行数（默认 30） */
  readonly indexLines?: number;
  /** Layer 4 skill 命中 top-N（默认 3） */
  readonly skillTopN?: number;
  /** Layer 5 keyword 命中 top-N（默认 3） */
  readonly keywordTopN?: number;
  /** Token 预算硬上限（默认 2000） */
  readonly budgetTokens?: number;
}

const DEFAULT_OPTS: Required<ReadOptions> = {
  indexLines: 30,
  skillTopN: 3,
  keywordTopN: 3,
  budgetTokens: 2000,
};

// 类型优先级（数字越大越靠前）
const TYPE_PRIORITY: Record<PageType, number> = {
  lesson: 3,
  decision: 3,
  concept: 2,
  module: 1,
  source: 1,
};

// 启发式：1 个汉字/英文单词 ≈ 1.5 token（粗估）
const CHARS_PER_TOKEN = 1.5;

// ─── 主入口 ───────────────────────────────────────────────────────

/**
 * 读取 wiki 注入到 Worker prompt 的上下文。
 *
 * 步骤：
 *   1. Layer 1: hot.md 全文
 *   2. Layer 2: index.md 节选
 *   3. Layer 3: pinned pages（按 id 取）
 *   4. 列所有 page 建临时 searcher
 *   5. Layer 4: skill 匹配
 *   6. Layer 5: BM25 关键词
 *   7. 合并去重 → 类型优先级排序 → 预算截断
 *   8. 装载 TL;DR 入 PageContextEntry
 *
 * 失败模式：任何 layer 失败（文件丢/解析错）单独 swallow，不阻塞其他 layer。
 */
export function wikiRead(
  input: ReadInput,
  opts: ReadOptions = {},
): WikiContext {
  const cfg = { ...DEFAULT_OPTS, ...opts };

  // L1
  const hot = safeRead(() => readHot(input.repoDir), '');

  // L2
  const indexSummary = safeRead(
    () => readIndexSummary(input.repoDir, cfg.indexLines),
    '',
  );

  // 拉所有 page 一次（reader.ts 调用频率低 = 卡启动一次；现读 OK）
  const pages = safeRead(() => listValidPages(input.repoDir), []);

  // L3: pinned
  const pinned = (input.pinnedPages ?? [])
    .map((id) => getPageById(input.repoDir, id))
    .filter((p): p is Page => p !== null);

  // 临时 searcher 用 IndexedDoc（pageToIndexed 来自 searcher.ts）
  const searcher = new WikiSearcher(pages.map(pageToIndexedAdapter));

  // L4: skill
  const bySkill = searcher
    .searchByTags(input.cardSkills, cfg.skillTopN)
    .map((r) => ({ pageId: r.pageId, source: 'skill' as const }));

  // L5: keyword
  const byKeyword = searcher
    .search(`${input.cardTitle} ${input.cardDesc}`, cfg.keywordTopN)
    .map((r) => ({ pageId: r.pageId, source: 'keyword' as const }));

  // 合并去重（按 source 优先级：pinned > skill > keyword）
  const dedup = new Map<string, { source: 'pinned' | 'skill' | 'keyword' }>();
  for (const p of pinned) dedup.set(p.pageId, { source: 'pinned' });
  for (const r of bySkill) {
    if (!dedup.has(r.pageId)) dedup.set(r.pageId, { source: r.source });
  }
  for (const r of byKeyword) {
    if (!dedup.has(r.pageId)) dedup.set(r.pageId, { source: r.source });
  }

  // 把每个 page 加载完整 + 排序
  const entries: PageContextEntry[] = [];
  for (const [pageId, meta] of dedup) {
    const page = pages.find((p) => p.pageId === pageId);
    if (!page) continue;
    if (isStalePage(page)) continue;
    entries.push({
      pageId,
      title: page.frontmatter.title,
      type: page.frontmatter.type,
      tldr: extractTLDR(page.body),
      source: meta.source,
      priority: priorityOf(page.frontmatter.type, meta.source),
    });
  }

  // 优先级排序
  entries.sort((a, b) => b.priority - a.priority);

  // 预算截断：估算 token，超出从尾部砍 keyword 命中（保 pinned + skill + 高优类型）
  const trimmed = applyBudget(entries, hot, indexSummary, cfg.budgetTokens);

  const tokensEstimate = estimateTokens(hot, indexSummary, trimmed);

  return {
    hot,
    indexSummary,
    pages: trimmed,
    tokensEstimate,
  };
}

// ─── Prompt 渲染 ──────────────────────────────────────────────────

/**
 * WikiContext → prompt 注入 markdown。
 *
 * 格式（doc-28 §10）：
 *   # 项目知识 - 当前状态
 *   <hot.md 全文>
 *   ---
 *   # 知识地图（节选）
 *   <index summary>
 *   ---
 *   # 与本任务相关的页
 *   ## [[id]] (type) [via source]
 *   TL;DR: ...
 */
export function formatWikiContext(ctx: WikiContext): string {
  const sections: string[] = [];

  if (ctx.hot.trim().length > 0) {
    // hot 已经是带 frontmatter 的完整文档；展示时去掉 frontmatter 块
    const hotBody = stripFrontmatter(ctx.hot).trim();
    sections.push('# Project knowledge — current state\n\n' + hotBody);
  }

  if (ctx.indexSummary.trim().length > 0) {
    sections.push('# Knowledge map (excerpt)\n\n' + ctx.indexSummary.trim());
  }

  if (ctx.pages.length > 0) {
    const lines: string[] = ['# Pages relevant to this task', ''];
    for (const p of ctx.pages) {
      const tag = p.source === 'pinned' ? '📌 pinned' : p.source === 'skill' ? 'via skill' : 'via keyword';
      lines.push(`## [[${p.pageId}]] (${p.type}, ${tag})`);
      lines.push(`TL;DR: ${p.tldr.replace(/\s+/g, ' ').trim().slice(0, 300)}`);
      lines.push('');
    }
    lines.push('For full content: Read the file directly, or run `sps wiki read "<keyword>"` for more.');
    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n---\n\n');
}

// ─── Helpers (private) ────────────────────────────────────────────

function pageToIndexedAdapter(p: Page) {
  // 复用 searcher 的工厂；这里手写一份避免循环引用复杂度
  return {
    pageId: p.pageId,
    title: p.frontmatter.title,
    tags: p.frontmatter.tags,
    tldr: extractTLDR(p.body),
    body: p.body,
    type: p.frontmatter.type,
  };
}

function priorityOf(type: PageType, source: 'pinned' | 'skill' | 'keyword'): number {
  // pinned 永远最高（用户/Worker 显式指定）
  // 其他按类型权重
  const sourceBonus = source === 'pinned' ? 100 : source === 'skill' ? 10 : 0;
  return sourceBonus + (TYPE_PRIORITY[type] ?? 1);
}

function isStalePage(page: Page): boolean {
  return page.frontmatter.status === 'stale';
}

function applyBudget(
  entries: readonly PageContextEntry[],
  hot: string,
  indexSummary: string,
  budgetTokens: number,
): PageContextEntry[] {
  const baseTokens = estimateChars(hot) + estimateChars(indexSummary);
  const baseTok = baseTokens / CHARS_PER_TOKEN;

  if (baseTok >= budgetTokens) {
    // hot+index 已超预算 → 不加任何 page
    return [];
  }

  const remaining = budgetTokens - baseTok;
  // 每页 TL;DR 估 ~80 token（300 字符 / 1.5 + 一些 metadata）
  const PER_PAGE_TOKENS = 80;
  const maxPages = Math.max(0, Math.floor(remaining / PER_PAGE_TOKENS));

  if (entries.length <= maxPages) return entries.slice();

  // 砍法：保留 pinned + skill，只砍 keyword 末尾
  const pinned = entries.filter((e) => e.source === 'pinned');
  const skill = entries.filter((e) => e.source === 'skill');
  const keyword = entries.filter((e) => e.source === 'keyword');
  const need = Math.max(0, maxPages - pinned.length - skill.length);
  return [...pinned, ...skill, ...keyword.slice(0, need)];
}

function estimateTokens(hot: string, indexSummary: string, entries: readonly PageContextEntry[]): number {
  const charCount =
    estimateChars(hot) +
    estimateChars(indexSummary) +
    entries.reduce((sum, e) => sum + e.title.length + e.tldr.length + 30, 0);
  return Math.ceil(charCount / CHARS_PER_TOKEN);
}

function estimateChars(s: string): number {
  return s.length;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function safeRead<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}
