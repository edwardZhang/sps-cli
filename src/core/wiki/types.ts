/**
 * @module        core/wiki/types
 * @description   Wiki page 数据模型 + zod schemas
 *
 * @layer         core
 *
 * doc-28 §6 Page Schema 的运行时表示。Frontmatter 用 zod 严格校验——
 * 因为 wiki page 来自 LLM 写入，松散 schema 会让格式漂移失控。
 *
 * 类型分流：5 类 page（module/concept/decision/lesson/source）共享 Base 字段，
 * 每类有 type-specific 加字段。Frontmatter 类型用 discriminated union。
 */
import { z } from 'zod';

// ─── Page type enum ───────────────────────────────────────────────

export const PageTypeSchema = z.enum(['module', 'concept', 'decision', 'lesson', 'source']);
export type PageType = z.infer<typeof PageTypeSchema>;

// ─── Status enum ──────────────────────────────────────────────────

export const StatusSchema = z.enum(['seed', 'developing', 'mature', 'evergreen', 'stale']);
export type PageStatus = z.infer<typeof StatusSchema>;

// ─── Generated marker ─────────────────────────────────────────────

export const GeneratedSchema = z.enum(['auto', 'manual', 'semi']);
export type Generated = z.infer<typeof GeneratedSchema>;

// ─── ISO date helpers ─────────────────────────────────────────────

const IsoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

// ─── Source reference (frontmatter sources 字段) ───────────────────
//
// 三种形态（discriminated by which field is present）：
//   { path: 'src/X.ts', hash: '...' }    项目原生文件
//   { card: '17' }                         SPS 卡片溯源
//   { commit: 'abcd123' }                  git commit 溯源
//
// 注意：YAML 输出可能是字符串（如 ".raw/x.md"）也可能是对象。解析时归一化。

export const SourceRefSchema = z.union([
  z.object({ path: z.string(), hash: z.string().optional() }),
  z.object({ card: z.string() }),
  z.object({ commit: z.string() }),
  // 简写：纯字符串路径
  z.string().transform((s) => ({ path: s }) as { path: string }),
]);
export type SourceRef = z.infer<typeof SourceRefSchema>;

// ─── Wikilink string format: "[[Page Name]]" or "[[type/Page Name]]" ───

export const WikilinkSchema = z
  .string()
  .regex(/^\[\[[^[\]]+\]\]$/, 'expected [[Page Name]] wikilink format');
export type Wikilink = z.infer<typeof WikilinkSchema>;

// ─── Base frontmatter (all page types share) ─────────────────────

const BaseFrontmatterSchema = z.object({
  title: z.string().min(1),
  created: IsoDateSchema,
  updated: IsoDateSchema,
  tags: z.array(z.string()).default([]),
  status: StatusSchema.default('developing'),
  related: z.array(WikilinkSchema).default([]),
  sources: z.array(SourceRefSchema).default([]),
  generated: GeneratedSchema.default('manual'),
});

// ─── Type-specific frontmatter ────────────────────────────────────

export const ModuleFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal('module'),
  module_path: z.string().min(1).describe('Source file path relative to repo root'),
});

export const ConceptFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal('concept'),
  complexity: z.enum(['basic', 'intermediate', 'advanced']).optional(),
  domain: z.string().optional(),
  aliases: z.array(z.string()).default([]).optional(),
});

export const DecisionFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal('decision'),
  version: z.string().optional().describe('e.g. v0.51.0'),
  superseded_by: WikilinkSchema.optional(),
});

export const LessonFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal('lesson'),
  severity: z.enum(['critical', 'major', 'minor']).default('major'),
  seen_in_cards: z.array(z.string()).default([]).optional(),
});

export const SourceFrontmatterSchema = BaseFrontmatterSchema.extend({
  type: z.literal('source'),
  source_type: z
    .enum(['pdf', 'article', 'image', 'transcript', 'data', 'note', 'unknown'])
    .default('unknown'),
  original_path: z.string().min(1),
});

export const FrontmatterSchema = z.discriminatedUnion('type', [
  ModuleFrontmatterSchema,
  ConceptFrontmatterSchema,
  DecisionFrontmatterSchema,
  LessonFrontmatterSchema,
  SourceFrontmatterSchema,
]);

export type ModuleFrontmatter = z.infer<typeof ModuleFrontmatterSchema>;
export type ConceptFrontmatter = z.infer<typeof ConceptFrontmatterSchema>;
export type DecisionFrontmatter = z.infer<typeof DecisionFrontmatterSchema>;
export type LessonFrontmatter = z.infer<typeof LessonFrontmatterSchema>;
export type SourceFrontmatter = z.infer<typeof SourceFrontmatterSchema>;
export type Frontmatter = z.infer<typeof FrontmatterSchema>;

// ─── Page (frontmatter + body + filesystem coords) ───────────────

export interface Page {
  /** Stable id: `<type>s/<title>` —— 用作 frontmatter related / 跨页引用 */
  readonly pageId: string;
  /** Absolute file path */
  readonly filePath: string;
  readonly frontmatter: Frontmatter;
  /** Body markdown after frontmatter (no leading/trailing whitespace stripping besides YAML block) */
  readonly body: string;
}

// ─── Manifest (.manifest.json) ────────────────────────────────────

export const ManifestEntrySchema = z.object({
  /** 'code' | 'doc' | 'pdf' | 'article' | 'image' | 'transcript' | 'readme' | 'changelog' | ... */
  type: z.string().min(1),
  /** sha256 hex (64 chars) */
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'expected sha256 hex'),
  /** ISO 8601 timestamp */
  ingested_at: z.string(),
  /** Page ids this source contributed to */
  pages: z.array(z.string()).default([]),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const ManifestSchema = z.object({
  version: z.literal(1),
  updated_at: z.string(),
  /** Key = source path relative to repo root (e.g. "src/X.ts" or ".raw/pdfs/y.pdf") */
  sources: z.record(ManifestEntrySchema).default({}),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const EMPTY_MANIFEST: Manifest = {
  version: 1,
  updated_at: '1970-01-01T00:00:00Z',
  sources: {},
};

// ─── Source diff result ──────────────────────────────────────────

export interface SourceDiff {
  /** New sources (not in manifest) */
  readonly added: string[];
  /** Sources whose hash changed since last ingest */
  readonly changed: string[];
  /** Sources still in manifest but no longer in glob results */
  readonly removed: string[];
  /** Sources with unchanged hash */
  readonly unchanged: string[];
}
