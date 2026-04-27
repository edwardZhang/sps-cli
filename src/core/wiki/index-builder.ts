/**
 * @module        core/wiki/index-builder
 * @description   渲染 wiki/index.md：全部 page 的 catalog，按类型分组
 *
 * @layer         core
 *
 * doc-28 §10：reader 5 层注入策略里"index 节选 top-30 行"是 Worker prompt
 * 知识地图来源——所以 index.md 必须**密集且 LLM-friendly**：
 *   - 每条一行：`- [[type/Title]]: TL;DR 摘要`
 *   - 按类型分组（### Modules / ### Concepts / ### Lessons / ...）
 *   - 不写废话头（无引子、无 stats 表格之类）
 *
 * 重建时机：每次 ingest / write 后调用一次（cheap，纯函数+1 次 writeFile）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { wikiIndexFile } from '../../shared/wikiPaths.js';
import { extractTLDR } from './searcher.js';
import type { Page, PageType } from './types.js';

// ─── Render ───────────────────────────────────────────────────────

const SECTIONS: Array<{ type: PageType; label: string }> = [
  { type: 'module', label: 'Modules' },
  { type: 'concept', label: 'Concepts' },
  { type: 'decision', label: 'Decisions' },
  { type: 'lesson', label: 'Lessons' },
  { type: 'source', label: 'Sources' },
];

/**
 * 从 page 列表渲染 index.md 完整内容。
 *
 * 输出形如：
 * ```md
 * ---
 * type: meta
 * title: Wiki Index
 * updated: 2026-04-27
 * ---
 *
 * # Wiki Index
 *
 * Pages: 12 · Updated 2026-04-27
 *
 * ## Modules (3)
 * - [[modules/PipelineService]]: TL;DR 摘要短句...
 * - ...
 *
 * ## Lessons (4)
 * - [[lessons/Stop Hook Race]]: ...
 * ```
 */
export function renderIndex(pages: readonly Page[], opts: { updatedAt?: string } = {}): string {
  const ts = opts.updatedAt ?? new Date().toISOString().slice(0, 10);
  const total = pages.length;

  const lines: string[] = [
    '---',
    'type: meta',
    'title: Wiki Index',
    `updated: ${ts}`,
    '---',
    '',
    '# Wiki Index',
    '',
    `Pages: ${total} · Updated ${ts}`,
    '',
  ];

  for (const section of SECTIONS) {
    const inSection = pages.filter((p) => p.frontmatter.type === section.type);
    if (inSection.length === 0) continue;
    lines.push(`## ${section.label} (${inSection.length})`);
    // 按 title 字典序排
    const sorted = inSection.slice().sort((a, b) =>
      a.frontmatter.title.localeCompare(b.frontmatter.title, 'en'),
    );
    for (const page of sorted) {
      const tldr = extractTLDR(page.body);
      const oneliner = squashToOneLine(tldr, 120);
      lines.push(`- [[${page.pageId}]]: ${oneliner}`);
    }
    lines.push('');
  }

  if (total === 0) {
    lines.push('（empty—— run `sps wiki update` to populate）');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 写 index.md（全量重建）。
 */
export function writeIndex(repoDir: string, pages: readonly Page[]): void {
  const path = wikiIndexFile(repoDir);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = renderIndex(pages);
  writeFileSync(path, content, { encoding: 'utf-8', mode: 0o644 });
}

/**
 * 取 index.md 节选 top-N 行（不含 frontmatter）。
 * 给 reader.ts 的 Layer 2 用——总是注入这一段。
 */
export function readIndexSummary(repoDir: string, maxLines = 30): string {
  const path = wikiIndexFile(repoDir);
  if (!existsSync(path)) return '';
  let content: string;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
  // strip frontmatter
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
  const lines = body.split('\n');
  // 跳过 # Wiki Index 标题 + 空行
  const start = lines.findIndex((l) => l.startsWith('## '));
  if (start === -1) return body.split('\n').slice(0, maxLines).join('\n');
  return lines.slice(start, start + maxLines).join('\n');
}

// ─── helpers ──────────────────────────────────────────────────────

/**
 * 把 TL;DR 拍扁成一行 + 截短。给 Worker prompt 注入用——不能多行。
 */
function squashToOneLine(text: string, maxLen: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLen) return flat;
  return flat.slice(0, maxLen - 1) + '…';
}
