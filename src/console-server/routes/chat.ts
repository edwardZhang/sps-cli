/**
 * @module        console-server/routes/chat
 * @description   Chat sessions via daemon — structured streaming with tool events
 *
 * v0.46 重写：
 *   - 放弃 spawn sps agent + stdout 纯文本解析
 *   - 改用 DaemonClient.ensureSession + startRun + subscribeRun 拿结构化 AccumulatorEvent
 *   - 每个 chat session 映射到 daemon slot `session-chat-<sessionId>`，多轮对话有上下文
 *   - SSE 事件按 block 类型分开推（text / tool_use / tool_update / complete）
 */
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { DaemonClient } from '../../daemon/daemonClient.js';
import { ensureDaemon } from '../../commands/agentDaemon.js';
import { Logger } from '../../core/logger.js';
import { eventBus } from '../sse/eventBus.js';

const HOME = process.env.HOME || '/home/coral';
const SESSIONS_DIR = resolve(HOME, '.coral', 'chat-sessions');

export type ChatMessageBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; title: string; kind: string; status: string };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  /** Structured blocks for tool rendering (assistant only). If omitted, content is plain text. */
  blocks?: ChatMessageBlock[];
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

function chatSlot(sessionId: string): string {
  return `session-chat-${sessionId}`;
}

async function streamAssistantResponse(
  sessionId: string,
  assistantId: string,
  userContent: string,
  log: Logger,
): Promise<void> {
  // 1. Ensure daemon is running
  if (!(await ensureDaemon())) {
    const errMsg: ChatMessage = {
      id: assistantId,
      role: 'error',
      content: 'Failed to start agent daemon',
      ts: new Date().toISOString(),
      status: 'error',
    };
    persistAndEmitComplete(sessionId, errMsg, log);
    return;
  }

  const client = new DaemonClient();
  const slot = chatSlot(sessionId);

  // 2. Ensure session exists (reuses if present → multi-turn context)
  try {
    await client.ensureSession(slot, 'claude');
  } catch (err) {
    const errMsg: ChatMessage = {
      id: assistantId,
      role: 'error',
      content: `ensureSession failed: ${err instanceof Error ? err.message : String(err)}`,
      ts: new Date().toISOString(),
      status: 'error',
    };
    persistAndEmitComplete(sessionId, errMsg, log);
    return;
  }

  // 3. Subscribe FIRST (before startRun) so we don't miss early events.
  //    Run the subscription loop in background.
  const subscription = client.subscribeRun(slot);
  const blocks: ChatMessageBlock[] = [];
  let accumulatedText = '';

  const consume = (async (): Promise<void> => {
    for await (const evt of subscription) {
      if (evt.event === 'text') {
        accumulatedText += evt.text;
        // Append to last text block or create one
        const last = blocks[blocks.length - 1];
        if (last?.type === 'text') last.text += evt.text;
        else blocks.push({ type: 'text', text: evt.text });
        eventBus.publish('chat.message.chunk.text', {
          sessionId,
          assistantId,
          text: evt.text,
        });
      } else if (evt.event === 'tool_use') {
        blocks.push({
          type: 'tool_use',
          id: evt.id,
          title: evt.title,
          kind: evt.kind,
          status: evt.status,
        });
        eventBus.publish('chat.message.chunk.tool_use', {
          sessionId,
          assistantId,
          id: evt.id,
          title: evt.title,
          kind: evt.kind,
          status: evt.status,
        });
      } else if (evt.event === 'tool_update') {
        const tool = blocks.find((b) => b.type === 'tool_use' && b.id === evt.id);
        if (tool && tool.type === 'tool_use') tool.status = evt.status;
        eventBus.publish('chat.message.chunk.tool_update', {
          sessionId,
          assistantId,
          id: evt.id,
          status: evt.status,
        });
      } else if (evt.event === 'complete') {
        const ts = new Date().toISOString();
        const isError = evt.stopReason === 'failed';
        const msg: ChatMessage = {
          id: assistantId,
          role: isError ? 'error' : 'assistant',
          content: accumulatedText.trim() || (isError ? `stopped: ${evt.stopReason}` : ''),
          blocks: blocks.length > 0 ? blocks : undefined,
          ts,
          status: isError ? 'error' : 'complete',
        };
        persistAndEmitComplete(sessionId, msg, log);
        break;
      }
    }
  })();

  // 4. Start the run (fire and forget — events flow through subscription)
  try {
    await client.startRun(slot, userContent, 'claude');
  } catch (err) {
    subscription.cancel();
    const errMsg: ChatMessage = {
      id: assistantId,
      role: 'error',
      content: `startRun failed: ${err instanceof Error ? err.message : String(err)}`,
      ts: new Date().toISOString(),
      status: 'error',
    };
    persistAndEmitComplete(sessionId, errMsg, log);
    return;
  }

  // Await subscription loop (background — but chat POST already returned 202)
  await consume;

  // 5. Clear run so slot is reusable for next turn
  try {
    await client.clearRun(slot);
  } catch {
    /* best effort */
  }
}

function persistAndEmitComplete(sessionId: string, msg: ChatMessage, log: Logger): void {
  const session = readSession(sessionId);
  if (!session) return;
  session.messages.push(msg);
  session.lastMessageAt = msg.ts;
  session.messageCount = session.messages.length;
  writeSession(session);
  eventBus.publish('chat.message.complete', {
    sessionId,
    assistantId: msg.id,
    message: msg,
  });
  if (msg.role === 'error') log.warn(`chat[${sessionId}]: ${msg.content}`);
  else log.ok(`chat[${sessionId}]: assistant complete (${msg.content.length} chars, ${msg.blocks?.length ?? 0} blocks)`);
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

  app.delete('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const p = sessionPath(id);
    if (existsSync(p)) rmSync(p);
    // Also stop the daemon session so ACP child process is freed
    try {
      const client = new DaemonClient();
      if (await client.isRunning()) {
        await client.stopSession(chatSlot(id)).catch(() => { /* session may not exist */ });
      }
    } catch { /* best effort */ }
    eventBus.publish('chat.session.deleted', { sessionId: id });
    return c.body(null, 204);
  });

  /**
   * POST messages: 非阻塞
   *   1. 持久化 user msg → 立即返回 user + assistantId (202)
   *   2. 后台走 daemon，SSE 推 chunk.text / chunk.tool_use / chunk.tool_update / complete
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

    // Fire and forget — events stream via SSE
    streamAssistantResponse(id, assistantId, body.content, log).catch((err) => {
      log.error(`chat[${id}] stream error: ${err instanceof Error ? err.message : String(err)}`);
    });

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
          'chat.message.chunk.text',
          'chat.message.chunk.tool_use',
          'chat.message.chunk.tool_update',
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
