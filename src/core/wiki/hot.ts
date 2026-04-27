/**
 * @module        core/wiki/hot
 * @description   Wiki hot.md 缓存：~500 字最近上下文（per-instance，gitignored）
 *
 * @layer         core
 *
 * doc-28 §10 / claude-obsidian "hot cache" 机制：每次 ingest / 卡完成后更新
 * 一份"最近发生了什么"摘要，下次 Worker 启动瞬间 prime。
 *
 * 实现要点：
 *   - 文件位置：`<repo>/wiki/.hot.md`（gitignored，per-instance 飘移）
 *   - 长度软上限 500 字（hard cap 1000 字截断）
 *   - 不存在 → 返默认骨架（让 Worker 不会因缺文件就出错）
 *   - 写入时校验 frontmatter 是 valid meta page
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { wikiHotFile } from '../../shared/wikiPaths.js';

// ─── Defaults ─────────────────────────────────────────────────────

const DEFAULT_HOT_TEMPLATE = `---
type: meta
title: Hot Cache
updated: 1970-01-01T00:00:00Z
---

# Recent Context

## Last Updated
（尚无活动。第一次 \`sps wiki update\` 或卡片完成后会自动填充。）

## Key Recent Facts
（none yet）

## Recent Changes
（none yet）

## Active Threads
（none yet）
`;

const SOFT_LIMIT_CHARS = 4000; // ~500 中文字 / ~1000 英文字
const HARD_LIMIT_CHARS = 8000;

// ─── Read ─────────────────────────────────────────────────────────

/**
 * 读 hot.md。文件不存在或损坏 → 返默认骨架（不阻塞 Worker prompt 注入）。
 */
export function readHot(repoDir: string): string {
  const path = wikiHotFile(repoDir);
  if (!existsSync(path)) return DEFAULT_HOT_TEMPLATE;
  try {
    const content = readFileSync(path, 'utf-8');
    return content;
  } catch {
    return DEFAULT_HOT_TEMPLATE;
  }
}

// ─── Write ────────────────────────────────────────────────────────

export interface HotCacheUpdate {
  /** 时间戳（ISO 8601）；缺省 = now */
  updatedAt?: string;
  /** Last Updated 段的描述（一句话："完成卡 #18，加了 race-recovery"） */
  lastUpdate: string;
  /** Key Recent Facts 列表（每条一行） */
  keyFacts?: readonly string[];
  /** Recent Changes 列表（每条一行，建议带 [[wikilink]]） */
  recentChanges?: readonly string[];
  /** Active Threads 列表 */
  activeThreads?: readonly string[];
}

/**
 * 用结构化数据生成 hot.md 完整内容（覆盖式更新——hot 是 cache，不是 journal）。
 *
 * 长度控制：超过 SOFT_LIMIT 在末尾加 truncation 提示；超过 HARD_LIMIT 截断。
 */
export function renderHot(update: HotCacheUpdate): string {
  const ts = update.updatedAt ?? new Date().toISOString();
  const lines: string[] = [
    '---',
    'type: meta',
    'title: Hot Cache',
    `updated: ${ts}`,
    '---',
    '',
    '# Recent Context',
    '',
    '## Last Updated',
    update.lastUpdate.trim(),
    '',
    '## Key Recent Facts',
  ];

  if (update.keyFacts && update.keyFacts.length > 0) {
    for (const f of update.keyFacts) lines.push(`- ${f}`);
  } else {
    lines.push('（none）');
  }

  lines.push('', '## Recent Changes');
  if (update.recentChanges && update.recentChanges.length > 0) {
    for (const c of update.recentChanges) lines.push(`- ${c}`);
  } else {
    lines.push('（none）');
  }

  lines.push('', '## Active Threads');
  if (update.activeThreads && update.activeThreads.length > 0) {
    for (const t of update.activeThreads) lines.push(`- ${t}`);
  } else {
    lines.push('（none）');
  }

  let content = lines.join('\n') + '\n';

  if (content.length > SOFT_LIMIT_CHARS) {
    if (content.length > HARD_LIMIT_CHARS) {
      content = content.slice(0, HARD_LIMIT_CHARS) + '\n…（truncated to hard cap; review hot.md and trim）\n';
    } else {
      content += '\n> ⚠ Hot cache exceeds soft limit (~500 字). Trim if needed.\n';
    }
  }
  return content;
}

/**
 * 渲染 + 原子写入 hot.md。
 */
export function writeHot(repoDir: string, update: HotCacheUpdate): void {
  const path = wikiHotFile(repoDir);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const content = renderHot(update);
  writeFileSync(path, content, { encoding: 'utf-8', mode: 0o644 });
}
