/**
 * @module        console-server/routes/chat
 * @description   Chat sessions：spawn `sps agent` 做一次性 prompt，结果缓存到内存 session
 *
 * 简化版（M5 v1）：
 *   - 无流式 SSE（ACP daemon 集成留 v0.45）
 *   - 每个 session 是一个 list of messages（user + assistant），持久化在 ~/.coral/chat-sessions/
 *   - POST messages → spawnCliSync("agent", prompt) → assistant reply → append
 *   - SSE endpoint 只做"消息变更"通知
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '../../core/logger.js';
import { spawnCliSync } from '../lib/spawnCli.js';
import { eventBus } from '../sse/eventBus.js';

const HOME = process.env.HOME || '/home/coral';
const SESSIONS_DIR = resolve(HOME, '.coral', 'chat-sessions');

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  ts: string;
}

interface ChatSession {
  id: string;
  createdAt: string;
  lastMessageAt: string | null;
  title: string;
  project: string | null;
  messageCount: number;
  messages: ChatMessage[];
}

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionPath(id: string): string {
  return resolve(SESSIONS_DIR, `${id}.json`);
}

function readSession(id: string): ChatSession | null {
  const p = sessionPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as ChatSession;
  } catch {
    return null;
  }
}

function writeSession(s: ChatSession): void {
  ensureDir();
  writeFileSync(sessionPath(s.id), JSON.stringify(s, null, 2));
}

function listSessions(): ChatSession[] {
  if (!existsSync(SESSIONS_DIR)) return [];
  return readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(resolve(SESSIONS_DIR, f), 'utf-8')) as ChatSession;
      } catch {
        return null;
      }
    })
    .filter((s): s is ChatSession => s !== null)
    .sort((a, b) => {
      const ta = a.lastMessageAt ?? a.createdAt;
      const tb = b.lastMessageAt ?? b.createdAt;
      return tb.localeCompare(ta);
    });
}

function summarize(s: ChatSession): Omit<ChatSession, 'messages'> {
  const { messages, ...rest } = s;
  void messages;
  return rest;
}

function formatTitle(firstMessage: string): string {
  const clean = firstMessage.replace(/\s+/g, ' ').trim();
  return clean.length > 60 ? `${clean.slice(0, 57)}...` : clean;
}

export function createChatRoute(log: Logger): Hono {
  const app = new Hono();

  app.get('/sessions', (c) => {
    const sessions = listSessions().map(summarize);
    return c.json({ data: sessions });
  });

  app.post('/sessions', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const session: ChatSession = {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      lastMessageAt: null,
      title: typeof body?.title === 'string' && body.title ? body.title : '新对话',
      project: typeof body?.project === 'string' ? body.project : null,
      messageCount: 0,
      messages: [],
    };
    writeSession(session);
    eventBus.publish('chat.session.created', { sessionId: session.id });
    return c.json(summarize(session), 201);
  });

  app.get('/sessions/:id', (c) => {
    const id = c.req.param('id');
    const s = readSession(id);
    if (!s) {
      return c.json({ type: 'not-found', title: 'Session not found', status: 404 }, 404);
    }
    return c.json(s);
  });

  app.delete('/sessions/:id', (c) => {
    const id = c.req.param('id');
    const p = sessionPath(id);
    if (existsSync(p)) rmSync(p);
    eventBus.publish('chat.session.deleted', { sessionId: id });
    return c.body(null, 204);
  });

  app.post('/sessions/:id/messages', async (c) => {
    const id = c.req.param('id');
    const s = readSession(id);
    if (!s) {
      return c.json({ type: 'not-found', title: 'Session not found', status: 404 }, 404);
    }
    const body = await c.req.json().catch(() => null) as { content?: string } | null;
    if (!body?.content || typeof body.content !== 'string') {
      return c.json({ type: 'validation', title: 'content required', status: 422 }, 422);
    }

    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: body.content,
      ts: new Date().toISOString(),
    };
    s.messages.push(userMsg);
    s.lastMessageAt = userMsg.ts;
    s.messageCount = s.messages.length;
    if (s.messages.length === 1) s.title = formatTitle(body.content);
    writeSession(s);
    eventBus.publish('chat.message', { sessionId: id, message: userMsg });

    // 派 sps agent 跑一次 prompt（非流式）
    log.info(`chat[${id}]: spawning sps agent`);
    const result = await spawnCliSync(['agent', body.content], { timeoutMs: 5 * 60 * 1000 });

    let assistant: ChatMessage;
    if (result.exitCode === 0) {
      // 尝试去掉 log banner（匹配 Logger 输出的时间戳前缀）
      const cleaned = result.stdout
        .split('\n')
        .filter((line) => !/^\u001b?\[?\d{4}-\d{2}-\d{2}.*\[(agent|setup|ACP)\]/.test(line))
        .join('\n')
        .trim();
      assistant = {
        id: randomUUID(),
        role: 'assistant',
        content: cleaned || result.stdout.trim() || '(no output)',
        ts: new Date().toISOString(),
      };
    } else {
      assistant = {
        id: randomUUID(),
        role: 'error',
        content: result.stderr.trim() || result.stdout.trim() || `agent exit ${result.exitCode}`,
        ts: new Date().toISOString(),
      };
    }
    s.messages.push(assistant);
    s.lastMessageAt = assistant.ts;
    s.messageCount = s.messages.length;
    writeSession(s);
    eventBus.publish('chat.message', { sessionId: id, message: assistant });

    return c.json({ user: userMsg, assistant });
  });

  app.get('/sessions/:id/meta', (c) => {
    const id = c.req.param('id');
    const s = readSession(id);
    if (!s) {
      return c.json({ type: 'not-found', title: 'Session not found', status: 404 }, 404);
    }
    return c.json(summarize(s));
  });

  return app;
}

// ── SSE: /stream/chat/:id ───────────────────────────────────────────────
export function createChatStreamRoute(): Hono {
  const app = new Hono();
  app.get('/:id', (c) => {
    const sessionId = c.req.param('id');
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        let closed = false;
        const send = (event: string, data: unknown): void => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };
        const onChatMessage = (data: unknown): void => {
          if (
            typeof data !== 'object' ||
            data === null ||
            (data as { sessionId?: string }).sessionId !== sessionId
          ) return;
          send('chat.message', data);
        };
        eventBus.on('chat.message', onChatMessage);
        const heartbeat = setInterval(() => {
          if (closed) return;
          try {
            controller.enqueue(enc.encode(`: heartbeat ${Date.now()}\n\n`));
          } catch {
            closed = true;
          }
        }, 15_000);

        c.req.raw.signal?.addEventListener('abort', () => {
          closed = true;
          eventBus.off('chat.message', onChatMessage);
          clearInterval(heartbeat);
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        });
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  });
  return app;
}
