/**
 * PMClient — lightweight PM operations for PostActions.
 *
 * Only the 5 methods needed by post-completion/failure flows.
 * Full TaskBackend remains for SchedulerEngine/StageEngine use.
 *
 * Supports Plane, Trello, and Markdown backends.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectConfig } from '../core/config.js';

// ─── Interface ──────────────────────────────────────────────────

export interface PMClient {
  move(seq: string, targetState: string): Promise<void>;
  addLabel(seq: string, label: string): Promise<void>;
  removeLabel(seq: string, label: string): Promise<void>;
  comment(seq: string, text: string): Promise<void>;
  releaseClaim(seq: string): Promise<void>;
}

// ─── Factory ────────────────────────────────────────────────────

export function createPMClient(config: ProjectConfig): PMClient {
  switch (config.PM_TOOL) {
    case 'plane':
      return new PlanePMClient(config);
    case 'trello':
      return new TrelloPMClient(config);
    case 'markdown':
      return new MarkdownPMClient(config);
    default:
      throw new Error(`Unknown PM_TOOL: ${config.PM_TOOL}`);
  }
}

// ─── Plane ──────────────────────────────────────────────────────

class PlanePMClient implements PMClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly pmMetaDir: string;
  private readonly projectName: string;
  private labelCache: Map<string, string> | null = null;

  constructor(config: ProjectConfig) {
    const raw = config.raw;
    const apiUrl = raw.PLANE_API_URL || raw.PLANE_URL || '';
    const apiKey = raw.PLANE_API_KEY || '';
    const workspace = raw.PLANE_WORKSPACE_SLUG || '';
    const projectId = raw.PLANE_PROJECT_ID || '';

    this.baseUrl = `${apiUrl}/api/v1/workspaces/${workspace}/projects/${projectId}`;
    this.headers = {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    };
    this.projectName = config.PROJECT_NAME;
    this.pmMetaDir = resolve(
      process.env.HOME || '~', '.coral', 'projects', this.projectName, 'pm_meta',
    );
  }

  async move(seq: string, targetStateId: string): Promise<void> {
    const issue = await this.resolveIssue(seq);
    await this.request('PATCH', `/issues/${issue.id}/`, { state: targetStateId });
  }

  async addLabel(seq: string, label: string): Promise<void> {
    const issue = await this.resolveIssue(seq);
    const labelId = await this.ensureLabel(label);
    const currentIds = await this.getIssueLabelIds(issue.id);
    if (!currentIds.includes(labelId)) {
      currentIds.push(labelId);
      await this.request('PATCH', `/issues/${issue.id}/`, { labels: currentIds });
    }
  }

  async removeLabel(seq: string, label: string): Promise<void> {
    const issue = await this.resolveIssue(seq);
    const labelId = await this.findLabelId(label);
    if (!labelId) return;
    const currentIds = await this.getIssueLabelIds(issue.id);
    const filtered = currentIds.filter(id => id !== labelId);
    if (filtered.length !== currentIds.length) {
      await this.request('PATCH', `/issues/${issue.id}/`, { labels: filtered });
    }
  }

  async comment(seq: string, text: string): Promise<void> {
    const issue = await this.resolveIssue(seq);
    await this.request('POST', `/issues/${issue.id}/comments/`, {
      comment_html: `<p>${escapeHtml(text)}</p>`,
    });
  }

  async releaseClaim(seq: string): Promise<void> {
    // Update local pm_meta
    const metaFile = resolve(this.pmMetaDir, `${seq}.json`);
    if (existsSync(metaFile)) {
      try {
        const existing = JSON.parse(readFileSync(metaFile, 'utf-8'));
        existing.status = 'RELEASED';
        existing.releasedAt = new Date().toISOString();
        writeFileSync(metaFile, JSON.stringify(existing, null, 2));
      } catch { /* best effort */ }
    }
    await this.removeLabel(seq, 'CLAIMED');
  }

  // ── Plane API helpers ──

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = { method, headers: this.headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Plane API ${method} ${path} failed (${res.status}): ${text}`);
    }
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  private async resolveIssue(seq: string): Promise<{ id: string }> {
    const data = await this.request<{ results?: { id: string; sequence_id: number }[] }>(
      'GET', `/issues/?search=${seq}`,
    );
    const issues = Array.isArray(data) ? data : (data.results ?? []);
    const match = issues.find((i: { sequence_id: number }) => String(i.sequence_id) === seq);
    if (!match) throw new Error(`Plane issue seq:${seq} not found`);
    return match;
  }

  private async getIssueLabelIds(issueId: string): Promise<string[]> {
    const issue = await this.request<{ label_ids?: string[]; labels?: (string | { id: string })[] }>(
      'GET', `/issues/${issueId}/`,
    );
    if (issue.label_ids) return [...issue.label_ids];
    return (issue.labels ?? []).map((l: string | { id: string }) => typeof l === 'string' ? l : l.id);
  }

  private async ensureLabel(name: string): Promise<string> {
    const existing = await this.findLabelId(name);
    if (existing) return existing;
    const label = await this.request<{ id: string }>('POST', '/labels/', { name });
    this.labelCache = null;
    return label.id;
  }

  private async findLabelId(name: string): Promise<string | null> {
    if (!this.labelCache) {
      const data = await this.request<{ id: string; name: string }[] | { results: { id: string; name: string }[] }>(
        'GET', '/labels/',
      );
      const labels = Array.isArray(data) ? data : (data.results ?? []);
      this.labelCache = new Map(labels.map(l => [l.name, l.id]));
    }
    return this.labelCache.get(name) ?? null;
  }
}

// ─── Trello ─────────────────────────────────────────────────────

class TrelloPMClient implements PMClient {
  private readonly apiKey: string;
  private readonly apiToken: string;
  private readonly boardId: string;

  constructor(config: ProjectConfig) {
    const raw = config.raw;
    this.apiKey = raw.TRELLO_API_KEY || '';
    this.apiToken = raw.TRELLO_API_TOKEN || '';
    this.boardId = raw.TRELLO_BOARD_ID || '';
  }

  private get auth(): string {
    return `key=${this.apiKey}&token=${this.apiToken}`;
  }

  async move(seq: string, targetListId: string): Promise<void> {
    const cardId = await this.findCardId(seq);
    if (!cardId) return;
    const res = await fetch(`https://api.trello.com/1/cards/${cardId}?${this.auth}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idList: targetListId }),
    });
    if (!res.ok) throw new Error(`Trello move failed (${res.status})`);
  }

  async addLabel(seq: string, label: string): Promise<void> {
    const cardId = await this.findCardId(seq);
    if (!cardId) return;
    const labelId = await this.findOrCreateLabel(label);
    if (labelId) {
      const res = await fetch(`https://api.trello.com/1/cards/${cardId}/idLabels?${this.auth}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: labelId }),
      });
      if (!res.ok) throw new Error(`Trello addLabel failed (${res.status})`);
    }
  }

  async removeLabel(seq: string, label: string): Promise<void> {
    const cardId = await this.findCardId(seq);
    if (!cardId) return;
    const labelId = await this.findOrCreateLabel(label);
    if (labelId) {
      const res = await fetch(`https://api.trello.com/1/cards/${cardId}/idLabels/${labelId}?${this.auth}`, {
        method: 'DELETE',
      });
      if (!res.ok && res.status !== 404) throw new Error(`Trello removeLabel failed (${res.status})`);
    }
  }

  async comment(seq: string, text: string): Promise<void> {
    const cardId = await this.findCardId(seq);
    if (!cardId) return;
    const res = await fetch(`https://api.trello.com/1/cards/${cardId}/actions/comments?${this.auth}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`Trello comment failed (${res.status})`);
  }

  async releaseClaim(seq: string): Promise<void> {
    await this.removeLabel(seq, 'CLAIMED');
  }

  private async findCardId(seq: string): Promise<string | null> {
    const res = await fetch(
      `https://api.trello.com/1/boards/${this.boardId}/cards?${this.auth}&fields=name`,
    );
    if (!res.ok) return null;
    const cards = await res.json() as { id: string; name: string }[];
    const match = cards.find(c => c.name.startsWith(`${seq}:`) || c.name.startsWith(`#${seq} `));
    return match?.id ?? null;
  }

  private async findOrCreateLabel(name: string): Promise<string | null> {
    const res = await fetch(
      `https://api.trello.com/1/boards/${this.boardId}/labels?${this.auth}`,
    );
    if (!res.ok) return null;
    const labels = await res.json() as { id: string; name: string }[];
    const match = labels.find(l => l.name === name);
    return match?.id ?? null;
  }
}

// ─── Markdown ───────────────────────────────────────────────────

class MarkdownPMClient implements PMClient {
  private readonly tasksFile: string;

  constructor(config: ProjectConfig) {
    this.tasksFile = config.raw.TASKS_FILE || resolve(
      config.PROJECT_DIR || '.', 'TASKS.md',
    );
  }

  async move(_seq: string, _targetState: string): Promise<void> {
    // Markdown backend: state is managed by file content, handled by full TaskBackend
    // PMClient.move is a no-op since PostActions should use TaskBackend for Markdown projects
  }

  async addLabel(_seq: string, _label: string): Promise<void> {
    // No-op for markdown
  }

  async removeLabel(_seq: string, _label: string): Promise<void> {
    // No-op for markdown
  }

  async comment(_seq: string, _text: string): Promise<void> {
    // No-op for markdown
  }

  async releaseClaim(_seq: string): Promise<void> {
    // No-op for markdown
  }
}

// ─── Helpers ────────────────────────────────────────────────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
