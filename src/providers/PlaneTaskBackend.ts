import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectConfig } from '../core/config.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { Card, CardState } from '../models/types.js';

const ALL_STATES: CardState[] = ['Planning', 'Backlog', 'Todo', 'Inprogress', 'QA', 'Done'];

/**
 * TaskBackend implementation for Plane (plane.so / self-hosted).
 *
 * Uses Node.js built-in fetch to communicate with the Plane REST API v1.
 * Local pm_meta JSON files provide the metadata / claim layer.
 */
export class PlaneTaskBackend implements TaskBackend {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly workspaceSlug: string;
  private readonly projectId: string;
  private readonly projectName: string;
  private readonly pmMetaDir: string;

  /** Map CardState → Plane state UUID */
  private readonly stateMap: Record<CardState, string>;

  /** Reverse map: Plane state UUID → CardState */
  private readonly reverseStateMap: Map<string, CardState>;

  /** Cache: label name → label UUID (populated lazily) */
  private labelCache: Map<string, string> | null = null;

  constructor(config: ProjectConfig) {
    const raw = config.raw;

    this.apiUrl = raw.PLANE_API_URL || raw.PLANE_URL || '';
    this.apiKey = raw.PLANE_API_KEY || '';
    this.workspaceSlug = raw.PLANE_WORKSPACE_SLUG || '';
    if (!this.apiUrl) throw new Error('Missing PLANE_API_URL or PLANE_URL (set in ~/.jarvis.env or project conf)');
    if (!this.apiKey) throw new Error('Missing PLANE_API_KEY (set in ~/.jarvis.env)');
    if (!this.workspaceSlug) throw new Error('Missing PLANE_WORKSPACE_SLUG (set in ~/.jarvis.env)');
    this.projectId = required(raw, 'PLANE_PROJECT_ID');
    this.projectName = config.PROJECT_NAME;

    this.pmMetaDir = resolve(
      process.env.HOME || '/home/coral',
      '.projects',
      this.projectName,
      'pm_meta',
    );

    this.stateMap = {
      Planning: required(raw, 'PLANE_STATE_PLANNING'),
      Backlog: required(raw, 'PLANE_STATE_BACKLOG'),
      Todo: required(raw, 'PLANE_STATE_TODO'),
      Inprogress: required(raw, 'PLANE_STATE_INPROGRESS'),
      QA: required(raw, 'PLANE_STATE_QA'),
      Done: required(raw, 'PLANE_STATE_DONE'),
    };

    this.reverseStateMap = new Map<string, CardState>();
    for (const state of ALL_STATES) {
      this.reverseStateMap.set(this.stateMap[state], state);
    }
  }

  // ---------------------------------------------------------------------------
  // Plane API helpers
  // ---------------------------------------------------------------------------

  /** Base URL for project-scoped endpoints. */
  private get baseUrl(): string {
    return `${this.apiUrl}/api/v1/workspaces/${this.workspaceSlug}/projects/${this.projectId}`;
  }

  /** Standard headers for every Plane request. */
  private get headers(): Record<string, string> {
    return {
      'X-API-Key': this.apiKey,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Generic Plane API request wrapper.
   * Throws on non-2xx responses with a descriptive message.
   */
  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method,
      headers: this.headers,
    };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Plane API ${method} ${path} failed (${res.status}): ${text}`);
    }
    // Some endpoints (DELETE, PATCH with 204) may return empty body
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  // ---------------------------------------------------------------------------
  // Issue → Card mapping
  // ---------------------------------------------------------------------------

  /**
   * Convert a Plane issue to a Card.
   * Labels may come as objects ({id, name}) or bare UUID strings.
   * When they are UUIDs, resolve to names via the label cache.
   */
  private async resolveIssueToCard(issue: PlaneIssue): Promise<Card> {
    const stateId = issue.state;
    const cardState = this.reverseStateMap.get(stateId) ?? 'Backlog';

    // Resolve label UUIDs to names
    const labelNames: string[] = [];
    for (const l of (issue.labels ?? [])) {
      if (typeof l === 'object' && l.name) {
        labelNames.push(l.name);
      } else if (typeof l === 'string') {
        // UUID — resolve via cache
        if (!this.labelCache) await this.refreshLabelCache();
        const name = this.reverseLabelName(l);
        labelNames.push(name || l);
      }
    }

    return {
      id: issue.id,
      seq: String(issue.sequence_id),
      name: issue.name,
      desc: issue.description || stripHtmlTags(issue.description_html ?? '').trim() || '',
      state: cardState,
      labels: labelNames,
      meta: {},
    };
  }

  /**
   * Reverse lookup: label UUID → name.
   */
  private reverseLabelName(id: string): string | null {
    if (!this.labelCache) return null;
    for (const [name, uuid] of this.labelCache.entries()) {
      if (uuid === id) return name;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // TaskBackend implementation
  // ---------------------------------------------------------------------------

  async bootstrap(): Promise<void> {
    // Verify API connectivity by fetching project info
    const url = `${this.baseUrl}/`;
    const res = await fetch(url, { method: 'GET', headers: this.headers });
    if (!res.ok) {
      throw new Error(`Plane bootstrap failed: cannot reach project (${res.status})`);
    }

    // Verify all state UUIDs are configured
    for (const state of ALL_STATES) {
      if (!this.stateMap[state]) {
        throw new Error(`Plane bootstrap: missing state mapping for ${state}`);
      }
    }

    // Ensure pm_meta directory exists
    if (!existsSync(this.pmMetaDir)) {
      mkdirSync(this.pmMetaDir, { recursive: true });
    }
  }

  async listByState(state: CardState): Promise<Card[]> {
    const stateId = this.stateMap[state];
    if (!stateId) throw new Error(`No Plane state mapping for ${state}`);

    // Plane CE API v1 may ignore the ?state= query param,
    // so fetch all issues and filter client-side by state UUID.
    const data = await this.request<PlaneListResponse>('GET', '/issues/');
    const issues: PlaneIssue[] = Array.isArray(data) ? data : (data.results ?? []);
    const filtered = issues.filter((i) => i.state === stateId);
    return Promise.all(filtered.map((i) => this.resolveIssueToCard(i)));
  }

  async getBySeq(seq: string): Promise<Card | null> {
    // Plane API doesn't have a direct "get by sequence_id" endpoint,
    // so we filter issues by sequence_id.
    const data = await this.request<PlaneListResponse>(
      'GET',
      `/issues/?search=${seq}`,
    );
    const issues: PlaneIssue[] = Array.isArray(data) ? data : (data.results ?? []);
    const match = issues.find((i) => String(i.sequence_id) === seq);
    return match ? await this.resolveIssueToCard(match) : null;
  }

  async move(seq: string, targetState: CardState): Promise<void> {
    const stateId = this.stateMap[targetState];
    if (!stateId) throw new Error(`No Plane state mapping for ${targetState}`);

    const issue = await this.resolveIssue(seq);
    await this.request('PATCH', `/issues/${issue.id}/`, { state: stateId });
  }

  async addLabel(seq: string, label: string): Promise<void> {
    const issue = await this.resolveIssue(seq);
    const labelId = await this.ensureLabel(label);
    const currentLabelIds = await this.getIssueLabelIds(issue.id);

    if (!currentLabelIds.includes(labelId)) {
      currentLabelIds.push(labelId);
      await this.request('PATCH', `/issues/${issue.id}/`, { labels: currentLabelIds });
    }
  }

  async removeLabel(seq: string, label: string): Promise<void> {
    const issue = await this.resolveIssue(seq);
    const labelId = await this.findLabelId(label);
    if (!labelId) return; // Label doesn't exist, nothing to remove

    const currentLabelIds = await this.getIssueLabelIds(issue.id);
    const filtered = currentLabelIds.filter((id) => id !== labelId);

    if (filtered.length !== currentLabelIds.length) {
      await this.request('PATCH', `/issues/${issue.id}/`, { labels: filtered });
    }
  }

  async claim(seq: string, workerSlot: string): Promise<void> {
    // Dual-write: local pm_meta + CLAIMED label (doc 12 §9.2)
    await this.metaWrite(seq, {
      status: 'CLAIMED',
      worker: workerSlot,
      claimedAt: new Date().toISOString(),
    });
    await this.addLabel(seq, 'CLAIMED');
  }

  async releaseClaim(seq: string): Promise<void> {
    // Dual-write: update pm_meta + remove CLAIMED label
    const existing = await this.metaRead(seq);
    await this.metaWrite(seq, {
      ...existing,
      status: 'RELEASED',
      releasedAt: new Date().toISOString(),
    });
    await this.removeLabel(seq, 'CLAIMED');
  }

  async comment(seq: string, text: string): Promise<void> {
    const issue = await this.resolveIssue(seq);
    await this.request('POST', `/issues/${issue.id}/comments/`, {
      comment_html: `<p>${escapeHtml(text)}</p>`,
    });
  }

  async create(name: string, desc: string, state: CardState): Promise<Card> {
    const stateId = this.stateMap[state];
    if (!stateId) throw new Error(`No Plane state mapping for ${state}`);

    const issue = await this.request<PlaneIssue>('POST', '/issues/', {
      name,
      description_html: `<p>${escapeHtml(desc)}</p>`,
      description: desc,
      state: stateId,
    });
    return await this.resolveIssueToCard(issue);
  }

  // ---------------------------------------------------------------------------
  // Checklist (via description_html task lists)
  // ---------------------------------------------------------------------------

  async checklistCreate(seq: string, items: string[]): Promise<void> {
    const issue = await this.resolveIssue(seq);
    // Build HTML task list and append to existing description
    const taskListHtml = items
      .map((item) => `<li data-checked="false">${escapeHtml(item)}</li>`)
      .join('');
    const html = `<ul class="checklist">${taskListHtml}</ul>`;

    const currentDesc = issue.description_html ?? '';
    const newDesc = currentDesc + '\n' + html;
    await this.request('PATCH', `/issues/${issue.id}/`, {
      description_html: newDesc,
    });
  }

  async checklistList(seq: string): Promise<{ id: string; text: string; checked: boolean }[]> {
    const issue = await this.resolveIssue(seq);
    const html = issue.description_html ?? '';
    return parseChecklistItems(html);
  }

  async checklistCheck(seq: string, itemId: string): Promise<void> {
    await this.updateChecklistItem(seq, itemId, true);
  }

  async checklistUncheck(seq: string, itemId: string): Promise<void> {
    await this.updateChecklistItem(seq, itemId, false);
  }

  private async updateChecklistItem(seq: string, itemId: string, checked: boolean): Promise<void> {
    const issue = await this.resolveIssue(seq);
    const html = issue.description_html ?? '';
    const items = parseChecklistItems(html);
    const idx = parseInt(itemId, 10);
    if (isNaN(idx) || idx < 0 || idx >= items.length) {
      throw new Error(`Checklist item ${itemId} not found on issue ${seq}`);
    }

    const updatedHtml = updateChecklistItemHtml(html, idx, checked);
    await this.request('PATCH', `/issues/${issue.id}/`, {
      description_html: updatedHtml,
    });
  }

  // ---------------------------------------------------------------------------
  // pm_meta (local JSON files)
  // ---------------------------------------------------------------------------

  async metaRead(seq: string): Promise<Record<string, unknown>> {
    const issue = await this.resolveIssue(seq);
    const filePath = resolve(this.pmMetaDir, `${issue.id}.json`);
    if (!existsSync(filePath)) return {};
    try {
      return JSON.parse(readFileSync(filePath, 'utf-8'));
    } catch {
      return {};
    }
  }

  async metaWrite(seq: string, data: Record<string, unknown>): Promise<void> {
    const issue = await this.resolveIssue(seq);
    if (!existsSync(this.pmMetaDir)) {
      mkdirSync(this.pmMetaDir, { recursive: true });
    }
    const filePath = resolve(this.pmMetaDir, `${issue.id}.json`);
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Resolve a sequence ID to a full Plane issue object.
   * Throws if the issue cannot be found.
   */
  private async resolveIssue(seq: string): Promise<PlaneIssue> {
    const data = await this.request<PlaneListResponse>(
      'GET',
      `/issues/?search=${seq}`,
    );
    const issues: PlaneIssue[] = Array.isArray(data) ? data : (data.results ?? []);
    const match = issues.find((i) => String(i.sequence_id) === seq);
    if (!match) {
      throw new Error(`Plane issue with sequence_id ${seq} not found`);
    }
    return match;
  }

  /**
   * Get current label UUIDs on an issue.
   */
  private async getIssueLabelIds(issueId: string): Promise<string[]> {
    const issue = await this.request<PlaneIssue>('GET', `/issues/${issueId}/`);
    if (!issue.label_ids) {
      // labels may be objects or strings depending on API version
      return (issue.labels ?? []).map((l: PlaneLabel | string) =>
        typeof l === 'string' ? l : l.id,
      );
    }
    return [...issue.label_ids];
  }

  /**
   * Find or create a project label by name, returning its UUID.
   */
  private async ensureLabel(name: string): Promise<string> {
    const existing = await this.findLabelId(name);
    if (existing) return existing;

    // Create the label
    const label = await this.request<PlaneLabel>('POST', '/labels/', { name });
    // Invalidate cache so next lookup picks it up
    this.labelCache = null;
    return label.id;
  }

  /**
   * Find label UUID by name. Returns null if not found.
   */
  private async findLabelId(name: string): Promise<string | null> {
    if (!this.labelCache) {
      await this.refreshLabelCache();
    }
    return this.labelCache!.get(name) ?? null;
  }

  /**
   * Populate label name→id cache from Plane API.
   */
  private async refreshLabelCache(): Promise<void> {
    const data = await this.request<PlaneLabel[] | { results: PlaneLabel[] }>(
      'GET',
      '/labels/',
    );
    const labels: PlaneLabel[] = Array.isArray(data) ? data : (data.results ?? []);
    this.labelCache = new Map();
    for (const label of labels) {
      this.labelCache.set(label.name, label.id);
    }
  }
}

// =============================================================================
// Plane API response types (internal, not exported)
// =============================================================================

interface PlaneIssue {
  id: string;
  sequence_id: number;
  name: string;
  description?: string;
  description_html?: string;
  state: string;
  labels?: (PlaneLabel | string)[];
  label_ids?: string[];
}

interface PlaneLabel {
  id: string;
  name: string;
}

type PlaneListResponse = PlaneIssue[] | { results: PlaneIssue[] };

// =============================================================================
// Utility functions
// =============================================================================

function required(raw: Record<string, string>, key: string): string {
  const val = raw[key];
  if (!val) throw new Error(`Missing required config field: ${key}`);
  return val;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Parse checklist items from Plane description_html.
 * Items are <li> elements with data-checked attribute.
 */
function parseChecklistItems(html: string): { id: string; text: string; checked: boolean }[] {
  const items: { id: string; text: string; checked: boolean }[] = [];
  // Match <li data-checked="true|false">text</li>
  const re = /<li\s[^>]*data-checked="(true|false)"[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(html)) !== null) {
    items.push({
      id: String(idx),
      text: stripHtmlTags(m[2]).trim(),
      checked: m[1] === 'true',
    });
    idx++;
  }
  return items;
}

/**
 * Update a checklist item's checked state in description_html by index.
 */
function updateChecklistItemHtml(html: string, index: number, checked: boolean): string {
  const re = /<li\s([^>]*data-checked=")(?:true|false)("[^>]*>)/gi;
  let count = 0;
  return html.replace(re, (match, before: string, after: string) => {
    if (count++ === index) {
      return `<li ${before}${checked ? 'true' : 'false'}${after}`;
    }
    return match;
  });
}

function stripHtmlTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}
