import { apiGet } from './client';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  ts: string;
}

export interface ChatSessionSummary {
  id: string;
  createdAt: string;
  lastMessageAt: string | null;
  title: string;
  project: string | null;
  messageCount: number;
}

export interface ChatSessionDetail extends ChatSessionSummary {
  messages: ChatMessage[];
}

export function listSessions() {
  return apiGet<{ data: ChatSessionSummary[] }>('/api/chat/sessions');
}

export function getSession(id: string) {
  return apiGet<ChatSessionDetail>(`/api/chat/sessions/${id}`);
}

export async function createSession(body: { title?: string; project?: string } = {}) {
  const res = await fetch('/api/chat/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as ChatSessionSummary;
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${id}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`${res.status}`);
}

export async function postMessage(sessionId: string, content: string) {
  const res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as { user: ChatMessage; assistant: ChatMessage };
}
