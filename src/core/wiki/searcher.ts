/**
 * @module        core/wiki/searcher
 * @description   Wiki BM25F 全文检索（field-weighted Best Matching 25）
 *
 * @layer         core
 *
 * 实现选择：
 *   - **不**用 lunr.js / minisearch / fuse.js —— 多一个 50KB 依赖不值得
 *   - **不**做词干提取（stemming）—— SPS 是技术文档库，词形变化少；stemming
 *     反而把 "Pipeline" 和 "PipelineService" 合并成同一 token，丢辨别力
 *   - **不**做向量 embedding —— v0 BM25 够用；v1 视召回率决定
 *
 * BM25F 通过 field tiling 实现：title 3x / tags 2x / tldr 2x / body 1x
 * 加权方式 = 该 field 内 token 重复 n 次（等价于 BM25F 的 boosting）。
 *
 * 中文支持：ASCII 按词切；中文按字切（朴素 unigram）。够用且无外部依赖。
 *
 * 数据规模：项目 wiki 一般 < 1000 page，~MB 级 corpus。in-memory 索引
 * 占用几 MB，构建 < 100ms，查询 < 10ms。不需要持久化（每次进程启动重建）。
 */
import type { Page, PageType } from './types.js';

// ─── Configuration ────────────────────────────────────────────────

export interface BM25Options {
  /** 词频饱和参数；标准值 1.2-2.0 */
  k1?: number;
  /** 长度归一化；0=关 / 0.75=标准 / 1=最大归一 */
  b?: number;
  /** 各字段权重 */
  fieldWeights?: {
    title?: number;
    tags?: number;
    tldr?: number;
    body?: number;
  };
}

const DEFAULT_OPTS = {
  k1: 1.5,
  b: 0.75,
  fieldWeights: { title: 3, tags: 2, tldr: 2, body: 1 },
} as const satisfies Required<BM25Options>;

// ─── Tokenization ─────────────────────────────────────────────────

/**
 * 把文本切成 token：
 *   - ASCII 单词组（含数字、`_`、`-`），≥ 2 字符
 *   - 单个汉字
 *   - lowercase 归一化
 *   - 去 stop words
 *
 * **不**做 stemming（pipelining → pipeline）—— SPS 文档技术词多，stemming
 * 引入更多噪声而不是信号。
 */
const STOP_WORDS = new Set([
  // English stop words
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'do',
  'for',
  'has',
  'have',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
  // Chinese stop words (常见高频虚词)
  '的',
  '了',
  '是',
  '和',
  '或',
  '在',
  '有',
  '我',
  '你',
  '他',
  '它',
  '这',
  '那',
  '与',
]);

const TOKEN_RE = /[a-z0-9_-]{2,}|[一-鿿]/g;

export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  const matches = lower.matchAll(TOKEN_RE);
  for (const m of matches) {
    const t = m[0];
    if (STOP_WORDS.has(t)) continue;
    tokens.push(t);
  }
  return tokens;
}

// ─── Indexed document shape ──────────────────────────────────────

export interface IndexedDoc {
  readonly pageId: string;
  readonly title: string;
  readonly tags: readonly string[];
  /** 第一段（## TL;DR 之后到下个 ## 之前）；用作字段权重 + 返回值预览 */
  readonly tldr: string;
  /** Body 剩余部分（除 TL;DR 之外） */
  readonly body: string;
  readonly type: PageType;
}

/**
 * 从 Page 对象抽 IndexedDoc。
 * TL;DR 提取规则：找 `## TL;DR\n...\n##` 之间的内容；找不到取 body 前 200 字符。
 */
export function pageToIndexed(page: Page): IndexedDoc {
  return {
    pageId: page.pageId,
    title: page.frontmatter.title,
    tags: page.frontmatter.tags,
    tldr: extractTLDR(page.body),
    body: page.body,
    type: page.frontmatter.type,
  };
}

const TLDR_RE = /^##\s+TL;DR\s*\r?\n([\s\S]*?)(?=\r?\n##\s+|\s*$)/m;

export function extractTLDR(body: string): string {
  const m = body.match(TLDR_RE);
  if (m) return m[1]!.trim();
  // Fallback：第一个段落或前 200 字
  const firstPara = body.split(/\n\s*\n/)[0]?.trim() ?? '';
  return firstPara.slice(0, 200);
}

// ─── Search result ────────────────────────────────────────────────

export interface SearchResult {
  readonly pageId: string;
  readonly score: number;
}

// ─── BM25F searcher ───────────────────────────────────────────────

export class WikiSearcher {
  private readonly opts: Required<BM25Options> & {
    fieldWeights: Required<NonNullable<BM25Options['fieldWeights']>>;
  };
  private readonly postings = new Map<string, Map<number, number>>();
  private readonly docLengths: number[] = [];
  private readonly avgDocLength: number;

  constructor(
    public readonly docs: readonly IndexedDoc[],
    opts: BM25Options = {},
  ) {
    this.opts = mergeOpts(opts);
    let totalLen = 0;
    for (let i = 0; i < docs.length; i++) {
      const tokens = this.tokenizeDoc(docs[i]!);
      const tf = countTF(tokens);
      for (const [term, count] of tf) {
        let pl = this.postings.get(term);
        if (!pl) {
          pl = new Map();
          this.postings.set(term, pl);
        }
        pl.set(i, count);
      }
      this.docLengths[i] = tokens.length;
      totalLen += tokens.length;
    }
    this.avgDocLength = docs.length > 0 ? totalLen / docs.length : 1;
  }

  /**
   * 全字段加权的 token stream。同一个 token 在 title 出现一次 = title weight 个副本。
   */
  private tokenizeDoc(doc: IndexedDoc): string[] {
    const w = this.opts.fieldWeights;
    return [
      ...repeat(tokenize(doc.title), w.title),
      ...repeat(tokenize(doc.tags.join(' ')), w.tags),
      ...repeat(tokenize(doc.tldr), w.tldr),
      ...repeat(tokenize(doc.body), w.body),
    ];
  }

  search(query: string, limit = 10): SearchResult[] {
    const queryTerms = unique(tokenize(query));
    if (queryTerms.length === 0 || this.docs.length === 0) return [];

    const scores = new Map<number, number>();
    const N = this.docs.length;

    for (const term of queryTerms) {
      const postings = this.postings.get(term);
      if (!postings) continue;
      const df = postings.size;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      for (const [docIdx, tf] of postings) {
        const docLen = this.docLengths[docIdx]!;
        const norm = 1 - this.opts.b + this.opts.b * (docLen / this.avgDocLength);
        const tfPart = (tf * (this.opts.k1 + 1)) / (tf + this.opts.k1 * norm);
        const contribution = idf * tfPart;
        scores.set(docIdx, (scores.get(docIdx) ?? 0) + contribution);
      }
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([idx, score]) => ({ pageId: this.docs[idx]!.pageId, score }));
  }

  /** 按 tag 集合过滤（OR 语义）—— 用于 reader.ts 的 skill-match layer */
  searchByTags(tags: readonly string[], limit = 10): SearchResult[] {
    if (tags.length === 0) return [];
    const tagSet = new Set(tags.map((t) => t.toLowerCase()));
    const matches: SearchResult[] = [];
    for (let i = 0; i < this.docs.length; i++) {
      const doc = this.docs[i]!;
      const overlap = doc.tags.filter((t) => tagSet.has(t.toLowerCase())).length;
      if (overlap > 0) {
        // 命中 tag 多 = 分数高
        matches.push({ pageId: doc.pageId, score: overlap });
      }
    }
    return matches.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** 按 type 列出（不打分；reader.ts 排序用） */
  byType(type: PageType): IndexedDoc[] {
    return this.docs.filter((d) => d.type === type);
  }
}

// ─── Pure helpers ─────────────────────────────────────────────────

function countTF(tokens: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function repeat<T>(arr: readonly T[], n: number): T[] {
  if (n <= 1) return arr.slice();
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(...arr);
  return out;
}

function unique<T>(arr: readonly T[]): T[] {
  return [...new Set(arr)];
}

function mergeOpts(input: BM25Options): Required<BM25Options> & {
  fieldWeights: Required<NonNullable<BM25Options['fieldWeights']>>;
} {
  return {
    k1: input.k1 ?? DEFAULT_OPTS.k1,
    b: input.b ?? DEFAULT_OPTS.b,
    fieldWeights: {
      title: input.fieldWeights?.title ?? DEFAULT_OPTS.fieldWeights.title,
      tags: input.fieldWeights?.tags ?? DEFAULT_OPTS.fieldWeights.tags,
      tldr: input.fieldWeights?.tldr ?? DEFAULT_OPTS.fieldWeights.tldr,
      body: input.fieldWeights?.body ?? DEFAULT_OPTS.fieldWeights.body,
    },
  };
}
