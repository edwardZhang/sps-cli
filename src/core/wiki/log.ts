/**
 * @module        core/wiki/log
 * @description   Wiki .log.md：操作时间序列（per-instance，gitignored）
 *
 * @layer         core
 *
 * 借鉴 claude-obsidian 的 wiki/log.md：每次 ingest / write / lint 在文件
 * 顶部追加一条事件，便于 Worker / 用户回看 "最近 wiki 怎么变的"。
 *
 * 实现选择：
 *   - 新条目**顶部追加**（最新在最前），方便 Worker 默认读前几条就看到 latest
 *   - hard cap 500 条（~5000 行），超过截尾——log 不是 audit，旧条目用 git/hot.md 找
 *   - frontmatter 固定（type=meta），不需要解析
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { wikiLogFile } from '../../shared/wikiPaths.js';

const HEADER = `---
type: meta
title: Wiki Operation Log
---

# Wiki Operation Log

`;

const MAX_ENTRIES = 500;

// ─── Public API ───────────────────────────────────────────────────

export type LogAction = 'ingest' | 'write' | 'update' | 'lint' | 'init' | 'add' | 'delete';

export interface LogEntry {
  action: LogAction;
  /** 时间戳；缺省 now */
  timestamp?: string;
  /** Source 路径或 page id 或简短描述 */
  target: string;
  /** 一句话描述（≤ 100 字符） */
  message: string;
  /** 受影响的 page id 列表（可选） */
  pages?: readonly string[];
}

/**
 * 在 log.md 顶部插入一条 entry。
 *
 * - 文件不存在：创建带 header
 * - 已有内容：保留最近 MAX_ENTRIES 条（旧的截掉）
 */
export function appendLog(repoDir: string, entry: LogEntry): void {
  const path = wikiLogFile(repoDir);
  const ts = entry.timestamp ?? new Date().toISOString();

  const block = renderEntry({ ...entry, timestamp: ts });

  let existing: string;
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf-8');
    } catch {
      existing = HEADER;
    }
  } else {
    existing = HEADER;
    mkdirSync(dirname(path), { recursive: true });
  }

  // 拆 header + 旧 entries
  const headerEnd = existing.indexOf('# Wiki Operation Log\n');
  let header: string;
  let entries: string;
  if (headerEnd === -1) {
    header = HEADER;
    entries = '';
  } else {
    const afterHeader = existing.indexOf('\n', headerEnd) + 1;
    header = existing.slice(0, afterHeader + 1);
    entries = existing.slice(afterHeader + 1);
  }

  // 拆现有 entries（按 ## 开头分组），去除可能的 trailing whitespace
  const oldBlocks = entries.split(/(?=^## )/m).filter((b) => b.trim().length > 0);
  // 顶部插入新 block
  const updatedBlocks = [block, ...oldBlocks];
  // cap 数量
  const truncated = updatedBlocks.slice(0, MAX_ENTRIES);

  const final = header + truncated.join('') + (truncated.length === MAX_ENTRIES ? '\n…（older entries truncated）\n' : '');
  writeFileSync(path, final, { encoding: 'utf-8', mode: 0o644 });
}

/**
 * 读 log.md 全文。文件不存在返默认 header。
 */
export function readLog(repoDir: string): string {
  const path = wikiLogFile(repoDir);
  if (!existsSync(path)) return HEADER;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return HEADER;
  }
}

// ─── Render ───────────────────────────────────────────────────────

/**
 * 单条 log entry 渲染：
 *
 * ```md
 * ## 2026-04-27T18:30:00Z · update · src/X.ts
 * 增量 ingest：3 个文件改动
 * - Pages: [[modules/X]], [[lessons/Stop Hook Race]]
 * ```
 */
function renderEntry(entry: Required<Pick<LogEntry, 'timestamp'>> & LogEntry): string {
  const lines: string[] = [];
  lines.push(`## ${entry.timestamp} · ${entry.action} · ${entry.target}`);
  lines.push(entry.message.trim());
  if (entry.pages && entry.pages.length > 0) {
    const wikilinks = entry.pages.map((p) => `[[${p}]]`).join(', ');
    lines.push(`- Pages: ${wikilinks}`);
  }
  lines.push('');
  return lines.join('\n');
}
