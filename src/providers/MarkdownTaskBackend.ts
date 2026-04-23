/**
 * @module        MarkdownTaskBackend
 * @description   基于 Markdown 文件的任务后端实现，以文件系统目录映射卡片状态
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-19
 * @updated       2026-04-03
 *
 * @role          provider
 * @layer         provider
 * @boundedContext task
 */
import {
  existsSync, mkdirSync, readdirSync, readFileSync,
  renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { parseChecklist } from '../core/checklist.js';
import type { ProjectConfig } from '../core/config.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { Card, CardState } from '../shared/types.js';

/** Legacy default states (used when no custom states provided). */
const DEFAULT_STATES: CardState[] = ['Planning', 'Backlog', 'Todo', 'Inprogress', 'QA', 'Done'];

/** Convert state name to filesystem-friendly directory name. */
function stateToDirName(state: string): string {
  return state.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/**
 * Markdown-based TaskBackend.
 *
 * Directory layout:
 *   cards/
 *   ├── planning/
 *   │   └── 3-build-dashboard.md
 *   ├── todo/
 *   │   └── 2-add-payment.md
 *   ├── inprogress/
 *   │   └── 1-implement-login.md
 *   ├── done/
 *   │   └── 0-setup.md
 *   └── seq.txt            ← current max sequence number
 *
 * Each card file uses YAML frontmatter for metadata + markdown body.
 */
export class MarkdownTaskBackend implements TaskBackend {
  private readonly cardsDir: string;
  private readonly seqFile: string;
  private readonly allStates: CardState[];
  /** state name → directory name */
  private readonly stateDir: Map<string, string>;
  /** directory name → state name */
  private readonly dirState: Map<string, string>;

  constructor(config: ProjectConfig, customStates?: string[]) {
    const home = process.env.HOME || '/home/coral';
    this.cardsDir = resolve(home, '.coral', 'projects', config.PROJECT_NAME, 'cards');
    this.seqFile = resolve(this.cardsDir, 'seq.txt');

    // Build state ↔ directory mappings
    this.allStates = (customStates && customStates.length > 0
      ? customStates
      : DEFAULT_STATES) as CardState[];
    this.stateDir = new Map();
    this.dirState = new Map();
    for (const state of this.allStates) {
      const dir = stateToDirName(state);
      this.stateDir.set(state, dir);
      this.dirState.set(dir, state);
    }
  }

  async bootstrap(): Promise<void> {
    for (const dir of this.stateDir.values()) {
      const path = resolve(this.cardsDir, dir);
      if (!existsSync(path)) mkdirSync(path, { recursive: true });
    }
    if (!existsSync(this.seqFile)) {
      writeFileSync(this.seqFile, '0\n');
    }
  }

  // ─── Query ─────────────────────────────────────────────────────

  async listByState(state: CardState): Promise<Card[]> {
    const dirName = this.stateDir.get(state) || stateToDirName(state);
    const dir = resolve(this.cardsDir, dirName);
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
    return files.map((f) => this.readCard(resolve(dir, f), state));
  }

  async listAll(): Promise<Card[]> {
    const cards: Card[] = [];
    for (const state of this.allStates) {
      cards.push(...await this.listByState(state));
    }
    return cards.sort((a, b) => parseInt(a.seq, 10) - parseInt(b.seq, 10));
  }

  async getBySeq(seq: string): Promise<Card | null> {
    for (const state of this.allStates) {
      const dirName = this.stateDir.get(state) || stateToDirName(state);
      const dir = resolve(this.cardsDir, dirName);
      if (!existsSync(dir)) continue;
      const file = readdirSync(dir).find((f) => f.startsWith(`${seq}-`));
      if (file) return this.readCard(resolve(dir, file), state);
    }
    return null;
  }

  // ─── State transitions ────────────────────────────────────────

  async move(seq: string, targetState: CardState): Promise<void> {
    const { filePath, currentState } = this.findCardFile(seq);
    if (currentState === targetState) return;
    const targetDirName = this.stateDir.get(targetState) || stateToDirName(targetState);
    const targetDir = resolve(this.cardsDir, targetDirName);
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });
    const targetPath = resolve(targetDir, basename(filePath));
    renameSync(filePath, targetPath);
  }

  // ─── Labels ───────────────────────────────────────────────────

  async addLabel(seq: string, label: string): Promise<void> {
    const { filePath } = this.findCardFile(seq);
    const { frontmatter, body } = this.parseFile(filePath);
    const labels: string[] = (frontmatter.labels as string[]) || [];
    if (!labels.includes(label)) {
      labels.push(label);
      frontmatter.labels = labels;
      this.writeFile(filePath, frontmatter, body);
    }
  }

  async removeLabel(seq: string, label: string): Promise<void> {
    const { filePath } = this.findCardFile(seq);
    const { frontmatter, body } = this.parseFile(filePath);
    const labels: string[] = (frontmatter.labels as string[]) || [];
    const filtered = labels.filter((l) => l !== label);
    if (filtered.length !== labels.length) {
      frontmatter.labels = filtered;
      this.writeFile(filePath, frontmatter, body);
    }
  }

  // ─── Skills (v0.42.0+) ────────────────────────────────────────

  async setSkills(seq: string, skills: string[]): Promise<void> {
    const { filePath } = this.findCardFile(seq);
    const { frontmatter, body } = this.parseFile(filePath);
    frontmatter.skills = [...new Set(skills.filter(Boolean))];  // dedupe, drop empty
    this.writeFile(filePath, frontmatter, body);
  }

  // ─── Title / Description / Labels (v0.49.7 edit support) ─────

  /**
   * 更新 title：frontmatter + 文件名 slug 同步。文件名规则跟 create 一致。
   */
  async setTitle(seq: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) throw new Error('title cannot be empty');
    const { filePath, currentState } = this.findCardFile(seq);
    const { frontmatter, body } = this.parseFile(filePath);
    frontmatter.title = trimmed;
    this.writeFile(filePath, frontmatter, body);

    // Rename file to match new slug
    const slug = trimmed
      .toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const newFilename = `${seq}-${slug || 'task'}.md`;
    const newPath = resolve(resolve(filePath, '..'), newFilename);
    if (newPath !== filePath) {
      renameSync(filePath, newPath);
    }
    void currentState;
  }

  /**
   * 更新 description —— 替换 body 里 "## 描述" 段的内容。
   * 如果找不到描述段就整体替换 body（罕见情况，保护性处理）。
   * 保留其它 section（检查清单、日志）不动。
   */
  async setDescription(seq: string, desc: string): Promise<void> {
    const { filePath } = this.findCardFile(seq);
    const { frontmatter, body } = this.parseFile(filePath);
    const newBody = replaceDescriptionSection(body, desc);
    this.writeFile(filePath, frontmatter, newBody);
  }

  /**
   * 全量替换 labels。调用方负责构造最终数组（不要再叠加 AI-PIPELINE 等，
   * 这是用户自定义层；工作流标签由 stage engine 管理）。
   */
  async setLabels(seq: string, labels: string[]): Promise<void> {
    const { filePath } = this.findCardFile(seq);
    const { frontmatter, body } = this.parseFile(filePath);
    frontmatter.labels = [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
    this.writeFile(filePath, frontmatter, body);
  }

  async delete(seq: string): Promise<void> {
    const { filePath } = this.findCardFile(seq);
    unlinkSync(filePath);
  }

  // ─── Claim ────────────────────────────────────────────────────

  async claim(seq: string, workerSlot: string): Promise<void> {
    const { filePath } = this.findCardFile(seq);
    const { frontmatter, body } = this.parseFile(filePath);
    frontmatter.claimed_by = workerSlot;
    frontmatter.claimed_at = new Date().toISOString();
    this.writeFile(filePath, frontmatter, body);
    await this.addLabel(seq, 'CLAIMED');
  }

  async releaseClaim(seq: string): Promise<void> {
    const { filePath } = this.findCardFile(seq);
    const { frontmatter, body } = this.parseFile(filePath);
    frontmatter.claimed_by = null;
    frontmatter.claimed_at = null;
    this.writeFile(filePath, frontmatter, body);
    await this.removeLabel(seq, 'CLAIMED');
  }

  // ─── Retry Count ──────────────────────────────────────────────

  async incrementRetryCount(seq: string): Promise<number> {
    const { filePath } = this.findCardFile(seq);
    const { frontmatter, body } = this.parseFile(filePath);
    const count = (typeof frontmatter.retry_count === 'number' ? frontmatter.retry_count : 0) + 1;
    frontmatter.retry_count = count;
    this.writeFile(filePath, frontmatter, body);
    return count;
  }

  async resetRetryCount(seq: string): Promise<void> {
    const { filePath } = this.findCardFile(seq);
    const { frontmatter, body } = this.parseFile(filePath);
    frontmatter.retry_count = 0;
    this.writeFile(filePath, frontmatter, body);
  }

  // ─── Comments (append to ## 日志 section) ─────────────────────

  async comment(seq: string, text: string): Promise<void> {
    const { filePath } = this.findCardFile(seq);
    const { frontmatter, body } = this.parseFile(filePath);
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const entry = `\n### ${ts} [pipeline]\n${text}\n`;

    // Find or create ## 日志 section
    const logHeader = '## 日志';
    let newBody: string;
    if (body.includes(logHeader)) {
      newBody = body + entry;
    } else {
      newBody = body + `\n${logHeader}\n${entry}`;
    }
    this.writeFile(filePath, frontmatter, newBody);
  }

  // ─── Create ───────────────────────────────────────────────────

  async create(title: string, desc: string, state: CardState): Promise<Card> {
    const seq = this.nextSeq();
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const filename = `${seq}-${slug || 'task'}.md`;
    const dirName = this.stateDir.get(state) || stateToDirName(state);
    const dir = resolve(this.cardsDir, dirName);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    // v0.42.0: use `title` (renamed from `name`), no longer write `skill:*` labels
    const frontmatter: Record<string, unknown> = {
      seq,
      title,
      labels: [],
      skills: [],
      created: new Date().toISOString(),
      claimed_by: null,
      claimed_at: null,
    };

    const body = `## 描述\n\n${desc || '(无描述)'}\n\n## 检查清单\n\n## 日志\n`;

    const filePath = resolve(dir, filename);
    this.writeFile(filePath, frontmatter, body);

    return {
      id: `md-${seq}`,
      seq: String(seq),
      title,
      desc: desc || '',
      state,
      labels: [],
      skills: [],
      meta: {},
    };
  }

  // ─── Checklist ────────────────────────────────────────────────

  async checklistCreate(seq: string, items: string[]): Promise<void> {
    const { filePath } = this.findCardFile(seq);
    const { frontmatter, body } = this.parseFile(filePath);
    const checklistMd = items.map((item) => `- [ ] ${item}`).join('\n');

    // Replace content after ## 检查清单 and before next ## heading
    const newBody = this.replaceSection(body, '检查清单', checklistMd);
    this.writeFile(filePath, frontmatter, newBody);
  }

  async checklistList(seq: string): Promise<{ id: string; text: string; checked: boolean }[]> {
    const { filePath } = this.findCardFile(seq);
    const { body } = this.parseFile(filePath);
    return this.parseChecklist(body);
  }

  async checklistCheck(seq: string, itemId: string): Promise<void> {
    await this.toggleChecklistItem(seq, parseInt(itemId, 10), true);
  }

  async checklistUncheck(seq: string, itemId: string): Promise<void> {
    await this.toggleChecklistItem(seq, parseInt(itemId, 10), false);
  }

  private async toggleChecklistItem(seq: string, index: number, checked: boolean): Promise<void> {
    const { filePath } = this.findCardFile(seq);
    const { frontmatter, body } = this.parseFile(filePath);
    const re = /- \[([ xX])\] (.+)/g;
    let count = 0;
    const newBody = body.replace(re, (match, _mark: string, text: string) => {
      if (count++ === index) {
        return `- [${checked ? 'x' : ' '}] ${text}`;
      }
      return match;
    });
    this.writeFile(filePath, frontmatter, newBody);
  }

  // ─── Meta ─────────────────────────────────────────────────────

  async metaRead(seq: string): Promise<Record<string, unknown>> {
    const { filePath } = this.findCardFile(seq);
    const { frontmatter } = this.parseFile(filePath);
    return (frontmatter.meta as Record<string, unknown>) || {};
  }

  async metaWrite(seq: string, data: Record<string, unknown>): Promise<void> {
    const { filePath } = this.findCardFile(seq);
    const { frontmatter, body } = this.parseFile(filePath);
    frontmatter.meta = data;
    this.writeFile(filePath, frontmatter, body);
  }

  // ─── File helpers ─────────────────────────────────────────────

  /**
   * Find the card file by seq across all state directories.
   */
  private findCardFile(seq: string): { filePath: string; currentState: CardState } {
    // Search known states first
    for (const state of this.allStates) {
      const dirName = this.stateDir.get(state) || stateToDirName(state);
      const dir = resolve(this.cardsDir, dirName);
      if (!existsSync(dir)) continue;
      const file = readdirSync(dir).find((f) => f.startsWith(`${seq}-`) && f.endsWith('.md'));
      if (file) return { filePath: resolve(dir, file), currentState: state };
    }
    // Fallback: scan all subdirectories (handles cards in legacy state dirs)
    if (existsSync(this.cardsDir)) {
      for (const entry of readdirSync(this.cardsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name === '.') continue;
        const dir = resolve(this.cardsDir, entry.name);
        const file = readdirSync(dir).find((f) => f.startsWith(`${seq}-`) && f.endsWith('.md'));
        if (file) {
          const state = (this.dirState.get(entry.name) || entry.name) as CardState;
          return { filePath: resolve(dir, file), currentState: state };
        }
      }
    }
    throw new Error(`Card seq:${seq} not found in cards/`);
  }

  /**
   * Read a card file and return Card object.
   */
  private readCard(filePath: string, state: CardState): Card {
    const { frontmatter, body } = this.parseFile(filePath);
    const desc = this.extractSection(body, '描述');

    // v0.42.0: new format uses `title` and `skills` fields. Old v0.41.x cards
    // used `name` and `skill:*` labels — per design decision they are not
    // runtime-compatible (hard break). We still fall back to `name` if
    // `title` is missing to avoid crashes on freshly-upgraded systems, but
    // skill:* labels are no longer parsed.
    const title = String(frontmatter.title || frontmatter.name || '');
    const skills = Array.isArray(frontmatter.skills)
      ? (frontmatter.skills as unknown[]).map(String).filter(Boolean)
      : undefined;
    const checklist = parseChecklist(body);

    return {
      id: `md-${frontmatter.seq}`,
      seq: String(frontmatter.seq),
      title,
      desc,
      state,
      labels: (frontmatter.labels as string[]) || [],
      ...(skills ? { skills } : {}),
      ...(checklist ? { checklist } : {}),
      meta: (frontmatter.meta as Record<string, unknown>) || {},
      retryCount: typeof frontmatter.retry_count === 'number' ? frontmatter.retry_count : 0,
    };
  }

  /**
   * Parse a markdown file into frontmatter + body.
   */
  private parseFile(filePath: string): { frontmatter: Record<string, unknown>; body: string } {
    const content = readFileSync(filePath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!fmMatch) {
      return { frontmatter: {}, body: content };
    }
    return {
      frontmatter: this.parseYamlSimple(fmMatch[1]),
      body: fmMatch[2],
    };
  }

  /**
   * Write frontmatter + body back to file.
   */
  private writeFile(filePath: string, frontmatter: Record<string, unknown>, body: string): void {
    const yamlStr = this.serializeYamlSimple(frontmatter);
    const content = `---\n${yamlStr}\n---\n${body}`;
    writeFileSync(filePath, content);
  }

  /**
   * Simple YAML parser (handles: strings, numbers, null, arrays of strings).
   * Not a full YAML parser — covers our frontmatter needs.
   */
  private parseYamlSimple(yaml: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    let currentKey = '';
    let currentArray: string[] | null = null;

    for (const line of yaml.split('\n')) {
      const trimmed = line.trim();

      // Array item
      if (trimmed.startsWith('- ') && currentArray !== null) {
        currentArray.push(trimmed.slice(2).trim());
        continue;
      }

      // Save previous array
      if (currentArray !== null) {
        result[currentKey] = currentArray;
        currentArray = null;
      }

      // Key: value
      const kvMatch = trimmed.match(/^([a-z_]+):\s*(.*)$/);
      if (!kvMatch) continue;

      const [, key, rawVal] = kvMatch;
      const val = rawVal.trim();

      if (val === '' || val === '[]') {
        // Could be empty value or start of array
        // Peek: if next line starts with "  -", it's an array
        currentKey = key;
        currentArray = [];
        continue;
      }

      if (val === 'null' || val === '~') {
        result[key] = null;
      } else if (val === 'true') {
        result[key] = true;
      } else if (val === 'false') {
        result[key] = false;
      } else if (/^-?\d+$/.test(val)) {
        result[key] = parseInt(val, 10);
      } else if (/^\[.*\]$/.test(val)) {
        // Inline array: [a, b, c]
        result[key] = val.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
      } else {
        // String (strip quotes if present)
        result[key] = val.replace(/^["']|["']$/g, '');
      }
      currentKey = key;
    }

    // Flush last array
    if (currentArray !== null) {
      result[currentKey] = currentArray;
    }

    return result;
  }

  /**
   * Simple YAML serializer.
   */
  private serializeYamlSimple(obj: Record<string, unknown>): string {
    const lines: string[] = [];
    for (const [key, val] of Object.entries(obj)) {
      if (val === null || val === undefined) {
        lines.push(`${key}: null`);
      } else if (typeof val === 'boolean' || typeof val === 'number') {
        lines.push(`${key}: ${val}`);
      } else if (typeof val === 'string') {
        lines.push(`${key}: ${val}`);
      } else if (Array.isArray(val)) {
        if (val.length === 0) {
          lines.push(`${key}:`);
        } else {
          lines.push(`${key}:`);
          for (const item of val) {
            lines.push(`  - ${item}`);
          }
        }
      } else if (typeof val === 'object') {
        // Nested object → serialize as inline JSON for simplicity
        lines.push(`${key}: ${JSON.stringify(val)}`);
      }
    }
    return lines.join('\n');
  }

  /**
   * Extract content from a ## section (until next ## or end).
   */
  private extractSection(body: string, heading: string): string {
    const re = new RegExp(`## ${heading}\\n([\\s\\S]*?)(?=\\n## |$)`);
    const match = body.match(re);
    return match ? match[1].trim() : '';
  }

  /**
   * Replace content of a ## section.
   */
  private replaceSection(body: string, heading: string, content: string): string {
    const re = new RegExp(`(## ${heading}\\n)[\\s\\S]*?(?=\\n## |$)`);
    if (re.test(body)) {
      return body.replace(re, `$1\n${content}\n`);
    }
    return body + `\n## ${heading}\n\n${content}\n`;
  }

  /**
   * Parse checklist items from markdown body.
   */
  private parseChecklist(body: string): { id: string; text: string; checked: boolean }[] {
    const items: { id: string; text: string; checked: boolean }[] = [];
    const re = /- \[([ xX])\] (.+)/g;
    let m: RegExpExecArray | null;
    let idx = 0;
    while ((m = re.exec(body)) !== null) {
      items.push({
        id: String(idx++),
        text: m[2].trim(),
        checked: m[1] !== ' ',
      });
    }
    return items;
  }

  /**
   * Get next sequence number (atomic increment).
   */
  private nextSeq(): number {
    let current = 0;
    if (existsSync(this.seqFile)) {
      try {
        current = parseInt(readFileSync(this.seqFile, 'utf-8').trim(), 10) || 0;
      } catch { /* start from 0 */ }
    }
    const next = current + 1;
    writeFileSync(this.seqFile, `${next}\n`);
    return next;
  }
}

/**
 * v0.49.7：在 body 里定位 "## 描述" section 并替换其内容。保留前后 section。
 * 如果没找到 "## 描述"，在头部插入一个。
 */
function replaceDescriptionSection(body: string, newDesc: string): string {
  const trimmed = newDesc.trim() || '(无描述)';
  const lines = body.split('\n');

  // Find "## 描述" heading line
  const descIdx = lines.findIndex((l) => /^##\s+描述\s*$/.test(l));
  if (descIdx === -1) {
    // Prepend
    return `## 描述\n\n${trimmed}\n\n${body}`;
  }

  // Find next heading after 描述 (start from descIdx+1)
  let nextIdx = lines.length;
  for (let i = descIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i] ?? '')) {
      nextIdx = i;
      break;
    }
  }

  // Rebuild: lines before+including "## 描述", blank line, new desc, blank line, rest
  const before = lines.slice(0, descIdx + 1);
  const after = lines.slice(nextIdx);
  return [...before, '', trimmed, '', ...after].join('\n');
}
