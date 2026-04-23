import { apiGet } from './client';

export type CardState = 'Planning' | 'Backlog' | 'Inprogress' | 'Review' | 'Done' | 'Canceled';

export interface Card {
  seq: number;
  title: string;
  state: CardState | string;
  skills: string[];
  labels: string[];
  branch: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface CardDetail extends Card {
  body: string;
  checklist: {
    total: number;
    done: number;
    percent: number;
    items: { text: string; done: boolean }[];
  };
  activeWorkerSlot: number | null;
}

export function listCards(project: string) {
  return apiGet<{ data: Card[] }>(`/api/projects/${encodeURIComponent(project)}/cards`);
}

export function getCard(project: string, seq: number) {
  return apiGet<CardDetail>(
    `/api/projects/${encodeURIComponent(project)}/cards/${seq}`,
  );
}

async function postJson(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
  return res.json().catch(() => ({}));
}

export function resetCard(project: string, seq: number) {
  return postJson(`/api/projects/${encodeURIComponent(project)}/cards/${seq}/reset`);
}

export async function deleteCard(project: string, seq: number): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/cards/${seq}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
}

export function launchCard(project: string, seq: number) {
  return postJson(`/api/projects/${encodeURIComponent(project)}/cards/${seq}/launch`);
}

export function createCard(
  project: string,
  input: { title: string; description?: string; skills?: string[] } | string,
) {
  const body = typeof input === 'string' ? { title: input } : input;
  return postJson(`/api/projects/${encodeURIComponent(project)}/cards`, body);
}

export async function moveCard(project: string, seq: number, state: string): Promise<void> {
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/cards/${seq}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
}

export interface CardPatch {
  title?: string;
  description?: string;
  skills?: string[];
  labels?: string[];
  state?: string;
}

/** v0.49.7 — generic PATCH for card edit; sends only provided fields. */
export async function updateCard(project: string, seq: number, patch: CardPatch): Promise<{ ok: boolean; noop?: boolean }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(project)}/cards/${seq}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export function startPipeline(project: string) {
  return postJson(`/api/projects/${encodeURIComponent(project)}/pipeline/start`);
}

export function stopPipeline(project: string) {
  return postJson(`/api/projects/${encodeURIComponent(project)}/pipeline/stop`);
}

export function resetPipeline(project: string, opts?: { all?: boolean; cards?: number[] }) {
  return postJson(`/api/projects/${encodeURIComponent(project)}/pipeline/reset`, opts ?? {});
}

export function getPipelineStatus(project: string) {
  return apiGet<{ status: 'running' | 'idle'; pid: number | null }>(
    `/api/projects/${encodeURIComponent(project)}/pipeline/status`,
  );
}
