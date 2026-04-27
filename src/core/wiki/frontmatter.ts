/**
 * @module        core/wiki/frontmatter
 * @description   Frontmatter 解析、序列化、校验
 *
 * @layer         core
 *
 * 输入：raw markdown 文件内容（开头是 YAML 块 + body）。
 * 输出：分离的 frontmatter（zod 校验过）+ body。
 *
 * 关键约束：
 *   - 扁平 YAML（doc-28 §6 Page Schema）—— Obsidian Properties UI 不支持嵌套
 *   - 缺 frontmatter / 不合法 → 返 error，**不 silently 接受残缺**
 *     wiki page 来自 LLM 写入，松散 schema 会让格式漂移失控
 */
import YAML from 'yaml';
import { type Frontmatter, FrontmatterSchema } from './types.js';

// ─── 解析 ─────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export interface ParseResult {
  readonly frontmatter: Frontmatter;
  readonly body: string;
}

export class FrontmatterError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
    readonly issues?: readonly { path: string; message: string }[],
  ) {
    super(message);
    this.name = 'FrontmatterError';
  }
}

/**
 * 从完整 markdown 文件内容解析 frontmatter + body。
 * 严格模式：
 *   - 没 `---\n...\n---\n` 块 → throw
 *   - YAML 解析失败 → throw
 *   - zod 校验失败 → throw（issues 字段带详细路径）
 */
export function parseFrontmatter(content: string): ParseResult {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new FrontmatterError(
      'No frontmatter block found. Page must start with `---\\n<yaml>\\n---\\n`.',
    );
  }
  const yamlBlock = match[1] ?? '';
  const body = (match[2] ?? '').replace(/^\n+/, '');

  let parsed: unknown;
  try {
    parsed = YAML.parse(yamlBlock);
  } catch (err) {
    throw new FrontmatterError('YAML parse error in frontmatter', err);
  }

  if (parsed === null || typeof parsed !== 'object') {
    throw new FrontmatterError('Frontmatter must be a YAML object');
  }

  const result = FrontmatterSchema.safeParse(parsed);
  if (!result.success) {
    throw new FrontmatterError(
      'Frontmatter schema validation failed',
      result.error,
      result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    );
  }
  return { frontmatter: result.data, body };
}

/**
 * 宽松解析：失败时返 null + 错误，不抛。
 * 用途：lint 扫描整个 wiki 时，单页坏不该终止整个 lint。
 */
export function tryParseFrontmatter(
  content: string,
): { ok: true; value: ParseResult } | { ok: false; error: FrontmatterError } {
  try {
    return { ok: true, value: parseFrontmatter(content) };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof FrontmatterError ? err : new FrontmatterError(String(err), err),
    };
  }
}

// ─── 序列化 ───────────────────────────────────────────────────────

/**
 * Frontmatter + body → 完整 markdown 文件内容。
 *
 * - YAML 输出走 yaml lib 默认行为（块式、整齐排版、字符串可选引号）
 * - body 末尾保证一个换行（POSIX 文件尾约定）
 * - 校验过 frontmatter 才能进来——这里不再校验，调用方传合法对象
 */
export function serializeFrontmatter(frontmatter: Frontmatter, body: string): string {
  // 用 yaml lib 控制输出风格
  const yamlText = YAML.stringify(frontmatter, {
    indent: 2,
    lineWidth: 0, // 不自动折行（避免 wikilink 被切到下一行）
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
  }).replace(/\n$/, ''); // YAML.stringify 末尾会带 \n，去掉留我们自己控

  const bodyTrimmed = body.replace(/^\n+/, '').replace(/\n+$/, '');
  return `---\n${yamlText}\n---\n\n${bodyTrimmed}\n`;
}

/**
 * 校验 frontmatter 对象（不需要先序列化）。
 * 用于：内存里组装 page 后写盘前快速检查。
 */
export function validateFrontmatter(
  fm: unknown,
): { ok: true; value: Frontmatter } | { ok: false; error: FrontmatterError } {
  const result = FrontmatterSchema.safeParse(fm);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: new FrontmatterError(
      'Frontmatter validation failed',
      result.error,
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    ),
  };
}
