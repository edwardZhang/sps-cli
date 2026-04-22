import { apiGet } from './client';

export type ChatMessageBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; title: string; kind: string; status: string };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  /** Structured blocks for tool rendering. Absent on old messages (pre-v0.46). */
  blocks?: ChatMessageBlock[];
  ts: string;
  status?: 'streaming' | 'complete' | 'error';
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

/**
 * 非阻塞：立刻返回 user 和 assistantId（pending），assistant 内容通过 SSE chunk + complete 推送。
 */
export async function postMessage(sessionId: string, content: string) {
  const res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as { user: ChatMessage; assistantId: string };
}
