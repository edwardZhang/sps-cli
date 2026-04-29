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
  /** True if content was capped at the server-side byte limit. */
  truncated?: boolean;
  ts: string;
  status?: 'streaming' | 'complete' | 'error';
  /**
   * v0.51.8: 用户消息附件（绝对路径数组）。
   * - 拖拽 / 粘贴 / 上传按钮加进去的会先 POST /api/fs/upload，路径指向 chat-attachments/
   * - 浏览本地文件挑的会保留原路径
   */
  attachments?: string[];
}

export interface ChatSessionSummary {
  id: string;
  createdAt: string;
  lastMessageAt: string | null;
  title: string;
  project: string | null;
  messageCount: number;
  /** v0.51.4: per-session working directory; null = use daemon's startup cwd */
  cwd?: string | null;
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

export async function createSession(
  body: { title?: string; project?: string; cwd?: string } = {},
) {
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
 *
 * v0.51.8：支持附件（绝对路径数组）。后端会校验路径存在 + 拼到 prompt 末尾。
 */
export async function postMessage(
  sessionId: string,
  content: string,
  attachments?: string[],
) {
  const res = await fetch(`/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, attachments }),
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return (await res.json()) as { user: ChatMessage; assistantId: string };
}

export async function interruptSession(sessionId: string): Promise<void> {
  const res = await fetch(`/api/chat/sessions/${sessionId}/interrupt`, { method: 'POST' });
  if (!res.ok && res.status !== 204) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
}

/** Diff-fetch messages with ts > since. Used by SSE reconnect compensation. */
export function getMessagesSince(
  sessionId: string,
  since?: string,
): Promise<{ data: ChatMessage[]; total: number }> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : '';
  return apiGet<{ data: ChatMessage[]; total: number }>(
    `/api/chat/sessions/${sessionId}/messages${qs}`,
  );
}
