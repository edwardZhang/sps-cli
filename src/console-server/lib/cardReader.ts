/**
 * @module        console-server/lib/cardReader
 * @description   解析卡片 markdown + frontmatter，供 routes/cards 和 routes/projects 用
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

export interface Card {
  seq: number;
  title: string;
  state: string;
  skills: string[];
  labels: string[];
  branch: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CardDetail extends Card {
  body: string;
  checklist: { total: number; done: number; percent: number; items: { text: string; done: boolean }[] };
  activeWorkerSlot: number | null;
}

interface FrontmatterResult {
  frontmatter: Record<string, unknown>;
  body: string;
}

function parseFrontmatter(raw: string): FrontmatterResult {
  if (!raw.startsWith('---')) return { frontmatter: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: raw };
  const yaml = raw.slice(3, end).trim();
  const body = raw.slice(end + 4).replace(/^\n/, '');
  const fm: Record<string, unknown> = {};
  let currentKey: string | null = null;
  const arrayBuffer: string[] = [];
  const flushArray = () => {
    if (currentKey) fm[currentKey] = [...arrayBuffer];
    arrayBuffer.length = 0;
    currentKey = null;
  };
  for (const line of yaml.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    if (line.startsWith('  - ')) {
      arrayBuffer.push(line.slice(4).trim());
      continue;
    }
    if (currentKey && arrayBuffer.length > 0) flushArray();
    const m = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (m) {
      const [, key, value] = m;
      if (value === '') {
        currentKey = key ?? '';
      } else {
        fm[key ?? ''] = stripQuotes(value ?? '');
      }
    }
  }
  if (currentKey && arrayBuffer.length > 0) flushArray();
  return { frontmatter: fm, body };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseChecklist(body: string): CardDetail['checklist'] {
  const lines = body.split('\n');
  const items: { text: string; done: boolean }[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*-\s*\[([ x])\]\s*(.+?)\s*$/);
    if (m) items.push({ text: m[2] ?? '', done: m[1] === 'x' });
  }
  const total = items.length;
  const done = items.filter((i) => i.done).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  return { total, done, percent, items };
}

export function cardsDir(projectDir: string): string {
  return resolve(projectDir, 'cards');
}

/**
 * v0.49.5 修复：MarkdownTaskBackend 把卡片存在 `cards/<state>/N-title.md` 子目录里，
 * 物理目录名就是 state（小写，如 planning/backlog/todo/inprogress/qa/done）。
 * 之前 listCards 只扫顶层 `cards/*.md` → 永远返回空。
 *
 * 改法：
 *   - 遍历 cards/ 的所有一级子目录
 *   - 子目录名小写，正规化成首字母大写的 canonical state（Planning/Backlog/...）
 *   - card.state 直接用目录名，不再读 frontmatter（frontmatter 里通常没 state 字段）
 *   - 顶层 *.md 也兼容读（老版本可能写过那）
 */
const DIR_NAME_TO_STATE: Record<string, string> = {
  planning: 'Planning',
  backlog: 'Backlog',
  todo: 'Todo',
  inprogress: 'Inprogress',
  qa: 'QA',
  review: 'Review',
  done: 'Done',
  canceled: 'Canceled',
};

function normalizeState(dirName: string): string {
  const lower = dirName.toLowerCase();
  return DIR_NAME_TO_STATE[lower] ?? dirName;
}

export function listCards(projectDir: string): Card[] {
  const dir = cardsDir(projectDir);
  if (!existsSync(dir)) return [];
  const results: Card[] = [];

  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    if (isDir) {
      const stateFromDir = normalizeState(entry);
      for (const f of readdirSync(full)) {
        if (!/^\d+.*\.md$/.test(f)) continue;
        const card = readCardFromFile(resolve(full, f), stateFromDir);
        if (card) results.push(card);
      }
    } else if (/^\d+.*\.md$/.test(entry)) {
      // 兼容：老格式/用户手动放的顶层 md
      const card = readCardFromFile(full, null);
      if (card) results.push(card);
    }
  }

  // 按 seq 倒序（新卡在前）
  return results.sort((a, b) => b.seq - a.seq);
}

export function readCard(projectDir: string, seq: number): CardDetail | null {
  const dir = cardsDir(projectDir);
  if (!existsSync(dir)) return null;

  // 先扫子目录找
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    let isDir = false;
    try { isDir = statSync(full).isDirectory(); } catch { continue; }
    if (!isDir) continue;
    const stateFromDir = normalizeState(entry);
    const file = readdirSync(full).find((f) => new RegExp(`^${seq}[^0-9]`).test(f));
    if (file) {
      const path = resolve(full, file);
      const raw = readFileSync(path, 'utf-8');
      const { frontmatter, body } = parseFrontmatter(raw);
      return buildCardDetail(seq, frontmatter, body, stateFromDir);
    }
  }

  // Fallback：顶层 md
  const topFile = readdirSync(dir).find((f) => new RegExp(`^${seq}[^0-9]`).test(f));
  if (!topFile) return null;
  const path = resolve(dir, topFile);
  const raw = readFileSync(path, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);
  return buildCardDetail(seq, frontmatter, body, null);
}

function readCardFromFile(path: string, stateFromDir: string | null): Card | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    const { frontmatter } = parseFrontmatter(raw);
    const seq = Number(frontmatter.seq);
    if (!Number.isFinite(seq)) return null;
    return buildCard(seq, frontmatter, stateFromDir);
  } catch {
    return null;
  }
}

function buildCard(seq: number, fm: Record<string, unknown>, stateFromDir: string | null): Card {
  // Priority: 物理目录名 > frontmatter.state > fallback 'Backlog'
  const state = stateFromDir ?? (fm.state ? String(fm.state) : 'Backlog');
  return {
    seq,
    title: String(fm.title ?? fm.name ?? ''),
    state,
    skills: Array.isArray(fm.skills) ? (fm.skills as string[]) : [],
    labels: Array.isArray(fm.labels) ? (fm.labels as string[]) : [],
    branch: fm.branch ? String(fm.branch) : null,
    createdAt: fm.created ? String(fm.created) : null,
    updatedAt: fm.updated ? String(fm.updated) : null,
  };
}

function buildCardDetail(
  seq: number,
  fm: Record<string, unknown>,
  body: string,
  stateFromDir: string | null,
): CardDetail {
  const card = buildCard(seq, fm, stateFromDir);
  return {
    ...card,
    body,
    checklist: parseChecklist(body),
    activeWorkerSlot: null, // 由 routes 合并 marker 数据填
  };
}
