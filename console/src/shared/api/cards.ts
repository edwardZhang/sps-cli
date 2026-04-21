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

export function launchCard(project: string, seq: number) {
  return postJson(`/api/projects/${encodeURIComponent(project)}/cards/${seq}/launch`);
}

export function createCard(project: string, title: string) {
  return postJson(`/api/projects/${encodeURIComponent(project)}/cards`, { title });
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
