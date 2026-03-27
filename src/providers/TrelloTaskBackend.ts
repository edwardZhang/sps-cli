import type { ProjectConfig } from '../core/config.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { Card, CardState } from '../models/types.js';

const ALL_STATES: CardState[] = ['Planning', 'Backlog', 'Todo', 'Inprogress', 'QA', 'Done'];

/**
 * Trello-backed TaskBackend.
 *
 * Uses Trello REST API via Node.js built-in fetch.
 * Cards are identified by shortLink (seq). Lists represent states.
 * Metadata is stored in card comments with [JARVIS-META] prefix.
 */
export class TrelloTaskBackend implements TaskBackend {
  private readonly apiBase = 'https://api.trello.com/1';
  private readonly apiKey: string;
  private readonly apiToken: string;
  private readonly boardId: string;

  /** CardState → Trello list ID */
  private readonly listMap: Record<CardState, string>;
  /** Trello list ID → CardState */
  private readonly reverseListMap: Map<string, CardState>;

  /** Cache: label name → label ID */
  private labelCache: Map<string, string> | null = null;

  constructor(config: ProjectConfig) {
    const raw = config.raw;
    this.apiKey = required(raw, 'TRELLO_API_KEY');
    this.apiToken = required(raw, 'TRELLO_TOKEN');
    this.boardId = required(raw, 'TRELLO_BOARD_ID');

    this.listMap = {
      Planning: required(raw, 'TRELLO_LIST_PLANNING'),
      Backlog: required(raw, 'TRELLO_LIST_BACKLOG'),
      Todo: required(raw, 'TRELLO_LIST_TODO'),
      Inprogress: required(raw, 'TRELLO_LIST_INPROGRESS'),
      QA: required(raw, 'TRELLO_LIST_QA'),
      Done: required(raw, 'TRELLO_LIST_DONE'),
    };

    this.reverseListMap = new Map<string, CardState>();
    for (const state of ALL_STATES) {
      this.reverseListMap.set(this.listMap[state], state);
    }
  }

  private get authParams(): string {
    return `key=${this.apiKey}&token=${this.apiToken}`;
  }

  // ─── API helpers ──────────────────────────────────────────────

  private async get<T>(path: string, params = ''): Promise<T> {
    const sep = path.includes('?') ? '&' : '?';
    const url = `${this.apiBase}${path}${sep}${this.authParams}${params ? '&' + params : ''}`;
    const res = await fetch(url);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Trello GET ${path} failed (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  }

  private async post<T>(path: string, body: Record<string, string> = {}): Promise<T> {
    const url = `${this.apiBase}${path}?${this.authParams}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Trello POST ${path} failed (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  }

  private async put<T>(path: string, body: Record<string, string> = {}): Promise<T> {
    const url = `${this.apiBase}${path}?${this.authParams}`;
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Trello PUT ${path} failed (${res.status}): ${text}`);
    }
    return (await res.json()) as T;
  }

  private async del(path: string): Promise<void> {
    const url = `${this.apiBase}${path}?${this.authParams}`;
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Trello DELETE ${path} failed (${res.status}): ${text}`);
    }
  }

  // ─── Card mapping ─────────────────────────────────────────────

  private cardToCard(tc: TrelloCard): Card {
    const state = this.reverseListMap.get(tc.idList) ?? 'Backlog';
    return {
      id: tc.id,
      seq: String(tc.idShort),
      name: tc.name,
      desc: tc.desc || '',
      state,
      labels: (tc.labels || []).map((l) => l.name),
      meta: {},
    };
  }

  // ─── TaskBackend implementation ───────────────────────────────

  async bootstrap(): Promise<void> {
    // Verify board access
    await this.get<{ id: string }>(`/boards/${this.boardId}`, 'fields=id');
    // Ensure standard labels exist
    for (const name of ['AI-PIPELINE', 'CLAIMED', 'BLOCKED', 'NEEDS-FIX', 'CONFLICT']) {
      await this.ensureLabel(name);
    }
  }

  async listByState(state: CardState): Promise<Card[]> {
    const listId = this.listMap[state];
    if (!listId) throw new Error(`No Trello list mapping for ${state}`);
    const cards = await this.get<TrelloCard[]>(
      `/lists/${listId}/cards`,
      'fields=id,idShort,name,desc,idList,labels',
    );
    return cards.map((c) => this.cardToCard(c));
  }

  async listAll(): Promise<Card[]> {
    const cards = await this.get<TrelloCard[]>(
      `/boards/${this.boardId}/cards`,
      'fields=id,idShort,name,desc,idList,labels',
    );
    return cards.map((card) => this.cardToCard(card));
  }

  async getBySeq(seq: string): Promise<Card | null> {
    // Trello doesn't have a direct idShort lookup API.
    // Search all lists for the card.
    for (const state of ALL_STATES) {
      const cards = await this.listByState(state);
      const match = cards.find((c) => c.seq === seq);
      if (match) return match;
    }
    return null;
  }

  async move(seq: string, targetState: CardState): Promise<void> {
    const card = await this.requireCard(seq);
    const listId = this.listMap[targetState];
    await this.put(`/cards/${card.id}`, { idList: listId });
  }

  async addLabel(seq: string, label: string): Promise<void> {
    const card = await this.requireCard(seq);
    const labelId = await this.ensureLabel(label);
    // Check if already has this label
    const existing = await this.get<TrelloCard>(`/cards/${card.id}`, 'fields=labels');
    if ((existing.labels || []).some((l) => l.id === labelId)) return;
    await this.post(`/cards/${card.id}/idLabels`, { value: labelId } as unknown as Record<string, string>);
  }

  async removeLabel(seq: string, label: string): Promise<void> {
    const card = await this.requireCard(seq);
    const labelId = await this.findLabelId(label);
    if (!labelId) return;
    try {
      await this.del(`/cards/${card.id}/idLabels/${labelId}`);
    } catch {
      // Label might not be on card — ignore
    }
  }

  async claim(seq: string, workerSlot: string): Promise<void> {
    // Trello claim: write JARVIS-META comment + add CLAIMED label
    await this.metaWrite(seq, {
      status: 'CLAIMED',
      worker: workerSlot,
      claimedAt: new Date().toISOString(),
    });
    await this.addLabel(seq, 'CLAIMED');
  }

  async releaseClaim(seq: string): Promise<void> {
    const existing = await this.metaRead(seq);
    await this.metaWrite(seq, {
      ...existing,
      status: 'RELEASED',
      releasedAt: new Date().toISOString(),
    });
    await this.removeLabel(seq, 'CLAIMED');
  }

  async comment(seq: string, text: string): Promise<void> {
    const card = await this.requireCard(seq);
    await this.post(`/cards/${card.id}/actions/comments`, { text });
  }

  async create(name: string, desc: string, state: CardState): Promise<Card> {
    const listId = this.listMap[state];
    const tc = await this.post<TrelloCard>('/cards', {
      name,
      desc,
      idList: listId,
    });
    return this.cardToCard(tc);
  }

  // ─── Checklist ────────────────────────────────────────────────

  async checklistCreate(seq: string, items: string[]): Promise<void> {
    const card = await this.requireCard(seq);
    // Create a new checklist on the card
    const checklist = await this.post<{ id: string }>(`/cards/${card.id}/checklists`, { name: 'Tasks' });
    for (const item of items) {
      await this.post(`/checklists/${checklist.id}/checkItems`, { name: item });
    }
  }

  async checklistList(seq: string): Promise<{ id: string; text: string; checked: boolean }[]> {
    const card = await this.requireCard(seq);
    const checklists = await this.get<TrelloChecklist[]>(`/cards/${card.id}/checklists`);
    const items: { id: string; text: string; checked: boolean }[] = [];
    for (const cl of checklists) {
      for (const ci of cl.checkItems || []) {
        items.push({
          id: ci.id,
          text: ci.name,
          checked: ci.state === 'complete',
        });
      }
    }
    return items;
  }

  async checklistCheck(seq: string, itemId: string): Promise<void> {
    const card = await this.requireCard(seq);
    // Find which checklist owns this item
    const checklists = await this.get<TrelloChecklist[]>(`/cards/${card.id}/checklists`);
    for (const cl of checklists) {
      const item = (cl.checkItems || []).find((ci) => ci.id === itemId);
      if (item) {
        await this.put(`/cards/${card.id}/checkItem/${itemId}`, { state: 'complete' });
        return;
      }
    }
    throw new Error(`Checklist item ${itemId} not found`);
  }

  async checklistUncheck(seq: string, itemId: string): Promise<void> {
    const card = await this.requireCard(seq);
    const checklists = await this.get<TrelloChecklist[]>(`/cards/${card.id}/checklists`);
    for (const cl of checklists) {
      const item = (cl.checkItems || []).find((ci) => ci.id === itemId);
      if (item) {
        await this.put(`/cards/${card.id}/checkItem/${itemId}`, { state: 'incomplete' });
        return;
      }
    }
    throw new Error(`Checklist item ${itemId} not found`);
  }

  // ─── Meta (via [JARVIS-META] comment) ─────────────────────────

  async metaRead(seq: string): Promise<Record<string, unknown>> {
    const card = await this.requireCard(seq);
    const actions = await this.get<TrelloAction[]>(
      `/cards/${card.id}/actions`,
      'filter=commentCard',
    );
    // Find the most recent [JARVIS-META] comment
    for (const action of actions) {
      const text = action.data?.text || '';
      if (text.startsWith('[JARVIS-META]')) {
        try {
          return JSON.parse(text.replace('[JARVIS-META]', '').trim());
        } catch {
          continue;
        }
      }
    }
    return {};
  }

  async metaWrite(seq: string, data: Record<string, unknown>): Promise<void> {
    const card = await this.requireCard(seq);
    const text = `[JARVIS-META] ${JSON.stringify(data)}`;

    // Delete old meta comments, add new one
    const actions = await this.get<TrelloAction[]>(
      `/cards/${card.id}/actions`,
      'filter=commentCard',
    );
    for (const action of actions) {
      if ((action.data?.text || '').startsWith('[JARVIS-META]')) {
        try {
          await this.del(`/cards/${card.id}/actions/${action.id}/comments`);
        } catch {
          // Old comment deletion may fail — non-fatal
        }
      }
    }

    await this.post(`/cards/${card.id}/actions/comments`, { text });
  }

  // ─── Helpers ──────────────────────────────────────────────────

  private async requireCard(seq: string): Promise<Card> {
    const card = await this.getBySeq(seq);
    if (!card) throw new Error(`Trello card with idShort ${seq} not found`);
    return card;
  }

  private async ensureLabel(name: string): Promise<string> {
    const existing = await this.findLabelId(name);
    if (existing) return existing;
    const label = await this.post<{ id: string; name: string }>(
      `/boards/${this.boardId}/labels`,
      { name, color: 'green' },
    );
    this.labelCache = null; // invalidate
    return label.id;
  }

  private async findLabelId(name: string): Promise<string | null> {
    if (!this.labelCache) {
      const labels = await this.get<{ id: string; name: string }[]>(
        `/boards/${this.boardId}/labels`,
      );
      this.labelCache = new Map();
      for (const l of labels) {
        if (l.name) this.labelCache.set(l.name, l.id);
      }
    }
    return this.labelCache.get(name) ?? null;
  }
}

// ─── Trello API types ───────────────────────────────────────────

interface TrelloCard {
  id: string;
  idShort: number;
  name: string;
  desc: string;
  idList: string;
  labels: { id: string; name: string }[];
}

interface TrelloChecklist {
  id: string;
  checkItems: { id: string; name: string; state: string }[];
}

interface TrelloAction {
  id: string;
  data?: { text?: string };
}

function required(raw: Record<string, string>, key: string): string {
  const val = raw[key];
  if (!val) throw new Error(`Missing required config field: ${key}`);
  return val;
}
