import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
  renameSync, readdirSync, unlinkSync,
} from 'node:fs';
import { resolve, basename } from 'node:path';
import type { ProjectConfig } from '../core/config.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { Card, CardState } from '../models/types.js';

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

  async create(name: string, desc: string, state: CardState): Promise<Card> {
    const seq = this.nextSeq();
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40);
    const filename = `${seq}-${slug || 'task'}.md`;
    const dirName = this.stateDir.get(state) || stateToDirName(state);
    const dir = resolve(this.cardsDir, dirName);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const frontmatter: Record<string, unknown> = {
      seq,
      name,
      labels: [],
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
      name,
      desc: desc || '',
      state,
      labels: [],
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
    const newBody = body.replace(re, (match, mark: string, text: string) => {
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
    return {
      id: `md-${frontmatter.seq}`,
      seq: String(frontmatter.seq),
      name: String(frontmatter.name || ''),
      desc,
      state,
      labels: (frontmatter.labels as string[]) || [],
      meta: (frontmatter.meta as Record<string, unknown>) || {},
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
