/**
 * @module        checklist
 * @description   Runtime-parse markdown checklist into structured progress stats
 *
 * @role          core
 * @layer         core
 * @boundedContext taskManagement
 *
 * 设计说明：
 * - 检查清单以 markdown `- [ ]` / `- [x]` 格式存在正文 `## 检查清单` section
 * - 这是 "claude 友好 + 人类友好 + SPS 运行时可读" 的最佳折中
 * - parseChecklist 每次读卡时调用（毫秒级成本），不缓存
 * - 只统计顶级项目，嵌套子项不递归（见 v0.42 设计决策 #6）
 */
import type { ChecklistItem, ChecklistStats } from '../models/types.js';

/**
 * Parse a markdown body for the "## 检查清单" section and return progress stats.
 * Returns `undefined` when the section is missing entirely (so callers can
 * distinguish "no checklist" from "empty checklist").
 */
export function parseChecklist(body: string): ChecklistStats | undefined {
  // Locate the section header (support 检查清单 or Checklist alias)
  const sectionMatch = body.match(/^##\s+(检查清单|Checklist)\s*$/m);
  if (!sectionMatch) return undefined;

  // Extract content between this section and the next `## ` heading (or EOF)
  const startIdx = (sectionMatch.index ?? 0) + sectionMatch[0].length;
  const nextHeadingMatch = body.slice(startIdx).match(/^##\s/m);
  const endIdx = nextHeadingMatch
    ? startIdx + (nextHeadingMatch.index ?? body.length - startIdx)
    : body.length;
  const section = body.slice(startIdx, endIdx);

  // Only parse **top-level** checklist items (lines starting with `- [ ]` or `- [x]`).
  // Indented sub-items are intentionally ignored — see v0.42 design decision.
  const items: ChecklistItem[] = [];
  for (const line of section.split('\n')) {
    const match = line.match(/^- \[([ xX])\]\s*(.*)$/);
    if (!match) continue;
    items.push({
      text: match[2].trim(),
      done: match[1].toLowerCase() === 'x',
    });
  }

  if (items.length === 0) {
    return { total: 0, done: 0, percent: 0, items: [] };
  }

  const done = items.filter(i => i.done).length;
  const total = items.length;
  const percent = Math.round((done / total) * 100);

  return { total, done, percent, items };
}
