/**
 * Memory system — persistent project-level knowledge for SPS workers and agents.
 *
 * Design follows Claude Code's approach:
 * - File-based storage with YAML frontmatter (name / description / type)
 * - MEMORY.md index file (one line per entry, max 200 lines)
 * - Agents read/write memory files directly via bash
 * - CLI provides `sps memory context` for prompt injection
 *
 * Directory layout:
 *   ~/.coral/memory/projects/<project>/
 *   ├── MEMORY.md              ← index (loaded into every prompt)
 *   ├── api-naming.md          ← convention
 *   ├── use-phaser.md          ← decision
 *   └── migration-order.md     ← lesson
 *
 * Types: convention (no decay), decision (slow decay), lesson (normal decay), reference (no decay)
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { resolve, basename, relative } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ──────────────────────────────────────────────────────

export const MEMORY_TYPES = ['convention', 'decision', 'lesson', 'reference'] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface MemoryHeader {
  filename: string;
  filePath: string;
  mtimeMs: number;
  name: string | null;
  description: string | null;
  type: MemoryType | undefined;
}

export const MEMORY_INDEX = 'MEMORY.md';
const MAX_INDEX_LINES = 200;
const MAX_MEMORY_FILES = 200;
const MAX_FILE_LINES = 200;
const MAX_CONTEXT_ENTRIES = 10;
const FRONTMATTER_MAX_LINES = 30;

// Types that don't decay — always relevant
const NO_DECAY_TYPES: readonly MemoryType[] = ['convention', 'reference'];

// ─── Paths ──────────────────────────────────────────────────────

/** Get the user-level memory directory (cross-project preferences) */
export function getUserMemoryDir(): string {
  return resolve(homedir(), '.coral', 'memory', 'user');
}

/** Get the agent-level memory directory (per daemon instance) */
export function getAgentMemoryDir(agentId: string): string {
  return resolve(homedir(), '.coral', 'memory', 'agents', agentId);
}

/** Get the memory directory for a project */
export function getProjectMemoryDir(project: string): string {
  return resolve(homedir(), '.coral', 'memory', 'projects', project);
}

/** Ensure project memory directory exists */
export function ensureMemoryDir(project: string): string {
  const dir = getProjectMemoryDir(project);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Ensure user memory directory exists */
export function ensureUserMemoryDir(): string {
  return ensureDir(getUserMemoryDir());
}

/** Ensure agent memory directory exists */
export function ensureAgentMemoryDir(agentId: string): string {
  return ensureDir(getAgentMemoryDir(agentId));
}

/** Ensure any memory directory exists (generic) */
function ensureDir(dir: string): string {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── Scanning ───────────────────────────────────────────────────

/** Parse simple YAML frontmatter from file content (first N lines) */
function parseFrontmatter(content: string): Record<string, string> {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') return {};

  const result: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const match = lines[i].match(/^(\w+):\s*(.+)$/);
    if (match) {
      result[match[1]] = match[2].trim();
    }
  }
  return result;
}

/** Scan memory directory for .md files, return headers sorted newest-first */
export function scanMemoryFiles(memoryDir: string): MemoryHeader[] {
  if (!existsSync(memoryDir)) return [];

  try {
    const files = readdirSync(memoryDir, { recursive: true })
      .map(f => typeof f === 'string' ? f : f.toString())
      .filter(f => f.endsWith('.md') && basename(f) !== MEMORY_INDEX);

    const headers: MemoryHeader[] = [];
    for (const relativePath of files) {
      try {
        const filePath = resolve(memoryDir, relativePath);
        const stat = statSync(filePath);
        const content = readFileSync(filePath, 'utf-8');
        // Only read first N lines for frontmatter
        const head = content.split('\n').slice(0, FRONTMATTER_MAX_LINES).join('\n');
        const fm = parseFrontmatter(head);

        headers.push({
          filename: relativePath,
          filePath,
          mtimeMs: stat.mtimeMs,
          name: fm.name || null,
          description: fm.description || null,
          type: MEMORY_TYPES.find(t => t === fm.type),
        });
      } catch { /* skip unreadable files */ }
    }

    return headers
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, MAX_MEMORY_FILES);
  } catch {
    return [];
  }
}

// ─── Reading ────────────────────────────────────────────────────

/** Read MEMORY.md index content, truncated to max lines */
export function readMemoryIndex(memoryDir: string): string {
  const indexPath = resolve(memoryDir, MEMORY_INDEX);
  if (!existsSync(indexPath)) return '';

  const content = readFileSync(indexPath, 'utf-8').trim();
  const lines = content.split('\n');
  if (lines.length > MAX_INDEX_LINES) {
    return lines.slice(0, MAX_INDEX_LINES).join('\n')
      + `\n\n> WARNING: ${MEMORY_INDEX} has ${lines.length} lines (limit: ${MAX_INDEX_LINES}). Truncated.`;
  }
  return content;
}

/** Read a memory file, truncated to max lines */
export function readMemoryFile(filePath: string): string {
  if (!existsSync(filePath)) return '';
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  if (lines.length > MAX_FILE_LINES) {
    return lines.slice(0, MAX_FILE_LINES).join('\n')
      + `\n\n> [Truncated — ${lines.length} lines total. Use file read for full content.]`;
  }
  return content;
}

/** Memory age in days */
function memoryAgeDays(mtimeMs: number): number {
  return Math.floor((Date.now() - mtimeMs) / (1000 * 60 * 60 * 24));
}

/** Staleness caveat for old memories */
function stalenessCaveat(mtimeMs: number): string | null {
  const days = memoryAgeDays(mtimeMs);
  if (days <= 1) return null;
  return `> This memory is ${days} days old. Verify against current code before acting on it.`;
}

// ─── Context Generation ─────────────────────────────────────────

/**
 * Select relevant memories for a worker prompt.
 * Priority: convention (always) > card-related > decision > lesson > reference
 * No decay types are always included. Lessons decay by age.
 */
function selectRelevantMemories(
  headers: MemoryHeader[],
  _cardSeq?: string,
): MemoryHeader[] {
  const selected: MemoryHeader[] = [];

  // 1. All conventions and references (no decay, always relevant)
  for (const h of headers) {
    if (h.type && NO_DECAY_TYPES.includes(h.type)) {
      selected.push(h);
    }
  }

  // 2. Decisions (sorted newest-first, already in that order)
  for (const h of headers) {
    if (h.type === 'decision' && !selected.includes(h)) {
      selected.push(h);
    }
  }

  // 3. Lessons (normal decay — skip if older than 30 days)
  for (const h of headers) {
    if (h.type === 'lesson' && !selected.includes(h)) {
      if (memoryAgeDays(h.mtimeMs) <= 30) {
        selected.push(h);
      }
    }
  }

  // 4. Untyped memories (legacy)
  for (const h of headers) {
    if (!h.type && !selected.includes(h)) {
      selected.push(h);
    }
  }

  return selected.slice(0, MAX_CONTEXT_ENTRIES);
}

/**
 * Build the memory context string for prompt injection.
 * Includes: MEMORY.md index + selected file contents.
 */
export function buildMemoryContext(project: string, cardSeq?: string): string {
  const memoryDir = getProjectMemoryDir(project);
  if (!existsSync(memoryDir)) return '';

  const sections: string[] = [];

  // 1. Read index
  const index = readMemoryIndex(memoryDir);

  // 2. Scan and select relevant memories
  const headers = scanMemoryFiles(memoryDir);
  if (headers.length === 0 && !index) return '';

  const selected = selectRelevantMemories(headers, cardSeq);

  sections.push('# Project Memory');
  sections.push('');

  if (index) {
    sections.push('## Index');
    sections.push(index);
    sections.push('');
  }

  // 3. Include selected memory file contents
  if (selected.length > 0) {
    sections.push('## Relevant Memories');
    sections.push('');

    for (const h of selected) {
      const content = readMemoryFile(h.filePath);
      const caveat = stalenessCaveat(h.mtimeMs);
      const age = memoryAgeDays(h.mtimeMs);
      const ageLabel = age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age} days ago`;

      sections.push(`### ${h.name || h.filename} (saved ${ageLabel})`);
      if (caveat) sections.push(caveat);
      sections.push(content);
      sections.push('');
    }
  }

  return sections.join('\n').trim();
}

/**
 * Build user-level memory context (cross-project preferences).
 * Injected into every agent/worker prompt.
 */
export function buildUserMemoryContext(): string {
  const memoryDir = getUserMemoryDir();
  if (!existsSync(memoryDir)) return '';

  const headers = scanMemoryFiles(memoryDir);
  const index = readMemoryIndex(memoryDir);
  if (headers.length === 0 && !index) return '';

  const sections: string[] = ['# User Preferences', ''];

  if (index) {
    sections.push(index);
    sections.push('');
  }

  // Include all user memories (small set, no filtering needed)
  for (const h of headers.slice(0, MAX_CONTEXT_ENTRIES)) {
    const content = readMemoryFile(h.filePath);
    sections.push(`### ${h.name || h.filename}`);
    sections.push(content);
    sections.push('');
  }

  return sections.join('\n').trim();
}

/**
 * Build agent-level memory context (daemon instance experience).
 * Injected when attaching to a daemon session.
 */
export function buildAgentMemoryContext(agentId: string): string {
  const memoryDir = getAgentMemoryDir(agentId);
  if (!existsSync(memoryDir)) return '';

  const headers = scanMemoryFiles(memoryDir);
  const index = readMemoryIndex(memoryDir);
  if (headers.length === 0 && !index) return '';

  const sections: string[] = ['# Agent Memory', ''];

  if (index) {
    sections.push(index);
    sections.push('');
  }

  for (const h of headers.slice(0, MAX_CONTEXT_ENTRIES)) {
    const content = readMemoryFile(h.filePath);
    const caveat = stalenessCaveat(h.mtimeMs);
    const age = memoryAgeDays(h.mtimeMs);
    const ageLabel = age === 0 ? 'today' : age === 1 ? 'yesterday' : `${age} days ago`;

    sections.push(`### ${h.name || h.filename} (saved ${ageLabel})`);
    if (caveat) sections.push(caveat);
    sections.push(content);
    sections.push('');
  }

  return sections.join('\n').trim();
}

/**
 * Build combined memory context for all applicable layers.
 * Used by StageEngine (user + project) and agent commands (user + agent).
 */
export function buildFullMemoryContext(opts: {
  project?: string;
  cardSeq?: string;
  agentId?: string;
}): string {
  const parts: string[] = [];

  // Layer 1: User preferences (always)
  const userCtx = buildUserMemoryContext();
  if (userCtx) parts.push(userCtx);

  // Layer 2: Agent memory (if daemon)
  if (opts.agentId) {
    const agentCtx = buildAgentMemoryContext(opts.agentId);
    if (agentCtx) parts.push(agentCtx);
  }

  // Layer 3: Project memory (if project context)
  if (opts.project) {
    const projectCtx = buildMemoryContext(opts.project, opts.cardSeq);
    if (projectCtx) parts.push(projectCtx);
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Build memory write instructions for prompt injection.
 * Tells the agent how and where to write memories across all three layers.
 */
export function buildMemoryWriteInstructions(project: string, agentId?: string): string {
  const userDir = getUserMemoryDir();
  const projectDir = getProjectMemoryDir(project);
  const agentDir = agentId ? getAgentMemoryDir(agentId) : null;

  const agentSection = agentDir ? `
- **Agent memory** (\`${agentDir}/\`): Your personal experience — interaction patterns, user communication preferences observed by you, pitfalls you encountered. Only you read this.` : '';

  return `# Memory System

You have a three-layer persistent memory system. Write directly to these directories (they exist, do not mkdir).

- **User memory** (\`${userDir}/\`): Cross-project user preferences — coding style, language, workflow habits. Shared across all projects and agents.${agentSection}
- **Project memory** (\`${projectDir}/\`): Project-specific knowledge — conventions, decisions, lessons, references. Shared across all workers on this project.

## Memory Types

- **convention**: Project rules and standards (e.g., "API uses camelCase"). Never expires.
- **decision**: Architecture/tech choices (e.g., "chose Phaser over PixiJS"). Slow decay.
- **lesson**: Lessons learned, pitfalls (e.g., "migration must be schema-first"). Decays after 30 days.
- **reference**: Pointers to external resources (e.g., "design docs in Figma"). Never expires.

## How to Write

Write each memory as a markdown file with this frontmatter:

\`\`\`markdown
---
name: Short title
description: One-line summary for index search
type: convention | decision | lesson | reference
---

Content here. For decision/lesson types, include:
**Why:** reason
**Scope:** where this applies
\`\`\`

Then add one line to the \`${MEMORY_INDEX}\` in the same directory:
\`- [Title](filename.md) — one-line hook\`

## When to Write

- User states a project rule or preference → convention
- A technical choice is made → decision
- Something unexpected happened or a pitfall was found → lesson
- An external resource location is mentioned → reference

Most conversations do NOT need memory. Only save what is non-obvious and useful for future tasks.

## What NOT to Save

- Code structure, file paths (derivable from code)
- Git history (use git log)
- Temporary task state
- Anything in CLAUDE.md or AGENTS.md`;
}

// ─── Writing (for CLI use) ──────────────────────────────────────

/**
 * Add a memory entry via CLI. Creates the file and updates MEMORY.md.
 */
export function addMemory(
  project: string,
  opts: { name: string; description: string; type: MemoryType; body: string },
): string {
  const memoryDir = ensureMemoryDir(project);

  // Generate filename from name
  const slug = opts.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
  const filename = `${slug}.md`;
  const filePath = resolve(memoryDir, filename);

  // Write memory file
  const content = `---
name: ${opts.name}
description: ${opts.description}
type: ${opts.type}
---

${opts.body}
`;
  writeFileSync(filePath, content);

  // Update MEMORY.md index
  const indexPath = resolve(memoryDir, MEMORY_INDEX);
  let indexContent = '';
  if (existsSync(indexPath)) {
    indexContent = readFileSync(indexPath, 'utf-8').trim();
  }

  // Check for duplicate entry (same filename)
  const lines = indexContent ? indexContent.split('\n') : [];
  const existingIdx = lines.findIndex(l => l.includes(`(${filename})`));
  const newLine = `- [${opts.name}](${filename}) — ${opts.description}`;

  if (existingIdx >= 0) {
    lines[existingIdx] = newLine;
  } else {
    lines.push(newLine);
  }

  writeFileSync(indexPath, lines.join('\n') + '\n');

  return filePath;
}
