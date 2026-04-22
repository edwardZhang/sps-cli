/**
 * @module        console-server/routes/chat
 * @description   Chat sessions with real-time streaming
 *
 * 流式策略：
 *   - POST /sessions/:id/messages：立刻持久化 user msg，返回 user msg + pending assistantId
 *   - 异步 spawn sps agent，stdout chunk 逐份推 chat.message.chunk（带 assistantId）
 *   - 完成时推 chat.message.complete
 *   - 失败推 chat.message.complete（role=error）
 *
 * 前端按 assistantId 累积 chunk，组装完整消息。
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '../../core/logger.js';
import { eventBus } from '../sse/eventBus.js';

const HOME = process.env.HOME || '/home/coral';
const SESSIONS_DIR = resolve(HOME, '.coral', 'chat-sessions');

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  ts: string;
  status?: 'streaming' | 'complete' | 'error';
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

/**
 * 清理终端 ANSI escape + 回车 + spinner 字符，保留纯文本。
 */
const SPINNER_CHARS = new Set(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
function cleanAnsi(raw: string): string {
  let s = raw.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, '');
  s = s.replace(/\r(?!\n)/g, '');
  s = Array.from(s).filter((ch) => !SPINNER_CHARS.has(ch)).join('');
  return s;
}

/**
 * Logger 输出的系统行（[agent] / [setup] 等），不给用户看。
 */
function isSystemLine(line: string): boolean {
  const cleaned = line.trim();
  if (!cleaned) return true;
  if (/^\d{4}-\d{2}-\d{2}[T ][\d:.]+Z?\s+\[(agent|setup|ACP|console|skill|worker-\d+)\]/i.test(cleaned)) return true;
  if (cleaned.startsWith('(node:') || cleaned.startsWith('Warning:')) return true;
  return false;
}

function cliEntry(): { node: string; entry: string } {
  return { node: process.argv[0] ?? 'node', entry: process.argv[1] ?? 'sps' };
}

function streamAssistantResponse(
  sessionId: string,
  assistantId: string,
  userContent: string,
  log: Logger,
): void {
  const { node, entry } = cliEntry();
  log.info(`chat[${sessionId}]: spawning sps agent for ${assistantId}`);

  const child = spawn(node, [entry, 'agent', userContent], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      FORCE_COLOR: '0',
      NO_COLOR: '1',
    },
  });

  let accumulated = '';
  let stderr = '';
  let lineBuffer = '';

  const emitChunk = (chunk: string): void => {
    if (!chunk) return;
    accumulated += chunk;
    eventBus.publish('chat.message.chunk', {
      sessionId,
      assistantId,
      chunk,
      accumulated,
    });
  };

  child.stdout?.on('data', (d: Buffer) => {
    const raw = d.toString('utf-8');
    const cleaned = cleanAnsi(raw);
    lineBuffer += cleaned;
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';
    const keep = lines.filter((line) => !isSystemLine(line));
    if (keep.length > 0) emitChunk(keep.join('\n') + '\n');
  });

  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString('utf-8');
  });

  child.on('close', (code) => {
    if (lineBuffer && !isSystemLine(lineBuffer)) emitChunk(lineBuffer);

    const session = readSession(sessionId);
    if (!session) return;

    const finalContent = accumulated.trim() || (code === 0 ? '(no output)' : '');
    const ts = new Date().toISOString();
    const msg: ChatMessage =
      code === 0
        ? { id: assistantId, role: 'assistant', content: finalContent, ts, status: 'complete' }
        : {
            id: assistantId,
            role: 'error',
            content: stderr.trim() || `sps agent exit ${code}`,
            ts,
            status: 'error',
          };
    session.messages.push(msg);
    session.lastMessageAt = ts;
    session.messageCount = session.messages.length;
    writeSession(session);
    eventBus.publish('chat.message.complete', {
      sessionId,
      assistantId,
      message: msg,
    });
    if (code === 0) log.ok(`chat[${sessionId}]: assistant complete (${accumulated.length} chars)`);
    else log.warn(`chat[${sessionId}]: assistant error (exit ${code})`);
  });

  child.on('error', (err) => {
    const session = readSession(sessionId);
    if (!session) return;
    const errMsg: ChatMessage = {
      id: assistantId,
      role: 'error',
      content: err.message,
      ts: new Date().toISOString(),
      status: 'error',
    };
    session.messages.push(errMsg);
    session.messageCount = session.messages.length;
    writeSession(session);
    eventBus.publish('chat.message.complete', {
      sessionId,
      assistantId,
      message: errMsg,
    });
    log.warn(`chat[${sessionId}]: spawn error ${err.message}`);
  });
}

export function createChatRoute(log: Logger): Hono {
  const app = new Hono();

  app.get('/sessions', (c) => {
    return c.json({ data: listSessions().map(summarize) });
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
    if (!s) return c.json({ type: 'not-found', title: 'Session not found', status: 404 }, 404);
    return c.json(s);
  });

  app.delete('/sessions/:id', (c) => {
    const id = c.req.param('id');
    const p = sessionPath(id);
    if (existsSync(p)) rmSync(p);
    eventBus.publish('chat.session.deleted', { sessionId: id });
    return c.body(null, 204);
  });

  /**
   * POST messages: 非阻塞
   *   1. 持久化 user msg → 立即返回 user + assistantId (202)
   *   2. 后台 spawn sps agent，SSE 推 chunk + complete
   */
  app.post('/sessions/:id/messages', async (c) => {
    const id = c.req.param('id');
    const s = readSession(id);
    if (!s) return c.json({ type: 'not-found', title: 'Session not found', status: 404 }, 404);
    const body = (await c.req.json().catch(() => null)) as { content?: string } | null;
    if (!body?.content || typeof body.content !== 'string') {
      return c.json({ type: 'validation', title: 'content required', status: 422 }, 422);
    }

    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: body.content,
      ts: new Date().toISOString(),
      status: 'complete',
    };
    s.messages.push(userMsg);
    s.lastMessageAt = userMsg.ts;
    s.messageCount = s.messages.length;
    if (s.messages.length === 1) s.title = formatTitle(body.content);
    writeSession(s);
    eventBus.publish('chat.message', { sessionId: id, message: userMsg });

    const assistantId = randomUUID();
    eventBus.publish('chat.message.pending', {
      sessionId: id,
      assistantId,
      ts: new Date().toISOString(),
    });

    streamAssistantResponse(id, assistantId, body.content, log);

    return c.json({ user: userMsg, assistantId }, 202);
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

        const eventTypes = [
          'chat.message',
          'chat.message.pending',
          'chat.message.chunk',
          'chat.message.complete',
        ];
        const handlers: Array<{ event: string; fn: (data: unknown) => void }> = [];
        for (const event of eventTypes) {
          const fn = (data: unknown): void => {
            if (
              typeof data !== 'object' ||
              data === null ||
              (data as { sessionId?: string }).sessionId !== sessionId
            )
              return;
            send(event, data);
          };
          eventBus.on(event, fn);
          handlers.push({ event, fn });
        }

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
          for (const h of handlers) eventBus.off(h.event, h.fn);
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
