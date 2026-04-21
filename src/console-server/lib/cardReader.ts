/**
 * @module        console-server/lib/cardReader
 * @description   解析卡片 markdown + frontmatter，供 routes/cards 和 routes/projects 用
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

export function listCards(projectDir: string): Card[] {
  const dir = cardsDir(projectDir);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /^\d+.*\.md$/.test(f))
    .sort((a, b) => {
      const ai = parseInt(a.match(/^\d+/)?.[0] ?? '0', 10);
      const bi = parseInt(b.match(/^\d+/)?.[0] ?? '0', 10);
      return bi - ai;
    });
  return files.map((f) => readCardFromFile(resolve(dir, f))).filter((c): c is Card => c !== null);
}

export function readCard(projectDir: string, seq: number): CardDetail | null {
  const dir = cardsDir(projectDir);
  if (!existsSync(dir)) return null;
  const file = readdirSync(dir).find((f) => new RegExp(`^${seq}[^0-9]`).test(f));
  if (!file) return null;
  const path = resolve(dir, file);
  const raw = readFileSync(path, 'utf-8');
  const { frontmatter, body } = parseFrontmatter(raw);
  return buildCardDetail(seq, frontmatter, body);
}

function readCardFromFile(path: string): Card | null {
  try {
    const raw = readFileSync(path, 'utf-8');
    const { frontmatter } = parseFrontmatter(raw);
    const seq = Number(frontmatter.seq);
    if (!Number.isFinite(seq)) return null;
    return buildCard(seq, frontmatter);
  } catch {
    return null;
  }
}

function buildCard(seq: number, fm: Record<string, unknown>): Card {
  return {
    seq,
    title: String(fm.title ?? ''),
    state: String(fm.state ?? 'Backlog'),
    skills: Array.isArray(fm.skills) ? (fm.skills as string[]) : [],
    labels: Array.isArray(fm.labels) ? (fm.labels as string[]) : [],
    branch: fm.branch ? String(fm.branch) : null,
    createdAt: fm.created ? String(fm.created) : null,
    updatedAt: fm.updated ? String(fm.updated) : null,
  };
}

function buildCardDetail(seq: number, fm: Record<string, unknown>, body: string): CardDetail {
  const card = buildCard(seq, fm);
  return {
    ...card,
    body,
    checklist: parseChecklist(body),
    activeWorkerSlot: null, // 由 routes 合并 marker 数据填
  };
}
