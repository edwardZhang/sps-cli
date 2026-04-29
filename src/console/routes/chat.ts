/**
 * @module        console/routes/chat
 * @description   Chat sessions — REST CRUD 走 ChatService；流式 daemon 消息走 delivery-local emitter
 *
 * @layer         console
 *
 * v0.50.1 重构：
 *   - CRUD (list / create / get / getMessages / delete / interrupt) 改走 ChatService
 *   - 流式事件（chunk.text / tool_use / tool_update / complete）走本模块内的 EventEmitter
 *     —— 这些事件是 SSE 连接作用域内的短暂广播，不属于跨服务共享的 DomainEvent
 *   - 干掉原 console/sse/eventBus.ts（所有 chat-specific publish 挪到 chatBus 里）
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { ensureDaemon } from '../../commands/agentDaemon.js';
import type { Logger } from '../../core/logger.js';
import { DaemonClient } from '../../daemon/daemonClient.js';
import type { ChatService } from '../../services/ChatService.js';
import { toHttpStatus, toProblemJson } from '../../shared/errors.js';
import { chatAttachmentsDirFor, chatSessionsDir } from '../../shared/runtimePaths.js';
import { sendResult } from '../lib/resultToJson.js';

const MAX_CONCURRENT_SESSIONS = 5;
const MAX_ASSISTANT_CONTENT_BYTES = 10 * 1024 * 1024;
const activeSessions = new Set<string>();

/**
 * chatBus —— Delivery 层内部的流式广播 EventEmitter。
 *   - 事件不持久化、不补偿，断线只通过 /sessions/:id/messages?since= 追历史消息
 *   - 订阅/发布作用域：单 console 进程内
 */
const chatBus = new EventEmitter();
chatBus.setMaxListeners(0);

export type ChatMessageBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; title: string; kind: string; status: string };

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'error';
  content: string;
  blocks?: ChatMessageBlock[];
  truncated?: boolean;
  ts: string;
  status?: 'streaming' | 'complete' | 'error';
  /** v0.51.8: 附件绝对路径列表（仅 user 消息有） */
  attachments?: string[];
}

interface ChatSessionPersisted {
  id: string;
  createdAt: string;
  lastMessageAt: string | null;
  title: string;
  project: string | null;
  messageCount: number;
  messages: ChatMessage[];
  /** v0.51.4: per-session working directory; null = use daemon's startup cwd */
  cwd?: string | null;
}

function sessionPath(id: string): string {
  return resolve(chatSessionsDir(), `${id}.json`);
}

function readSession(id: string): ChatSessionPersisted | null {
  const p = sessionPath(id);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8')) as ChatSessionPersisted;
  } catch {
    return null;
  }
}

function writeSession(s: ChatSessionPersisted): void {
  writeFileSync(sessionPath(s.id), JSON.stringify(s, null, 2));
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
  attachments?: string[],
): Promise<void> {
  // v0.51.8：把附件路径附在用户消息末尾，让 Claude 自己用 Read 工具拉
  const fullPrompt = formatPromptWithAttachments(userContent, attachments);
  if (!(await ensureDaemon())) {
    persistAndEmitComplete(
      sessionId,
      {
        id: assistantId,
        role: 'error',
        content: 'Failed to start agent daemon',
        ts: new Date().toISOString(),
        status: 'error',
      },
      log,
    );
    return;
  }

  const client = new DaemonClient();
  const slot = chatSlot(sessionId);
  activeSessions.add(slot);

  // v0.51.4: read per-session cwd; falls back to daemon's startup cwd when unset.
  // ACPWorkerRuntime resets the slot's session if cwdOverride differs from
  // existing.cwd, so switching cwd between sessions is safe.
  const persisted = readSession(sessionId);
  const sessionCwd = persisted?.cwd ?? undefined;

  try {
    await client.ensureSession(slot, 'claude', sessionCwd);
  } catch (err) {
    activeSessions.delete(slot);
    persistAndEmitComplete(
      sessionId,
      {
        id: assistantId,
        role: 'error',
        content: `ensureSession failed: ${err instanceof Error ? err.message : String(err)}`,
        ts: new Date().toISOString(),
        status: 'error',
      },
      log,
    );
    return;
  }

  const subscription = client.subscribeRun(slot);
  const blocks: ChatMessageBlock[] = [];
  let accumulatedText = '';
  let truncated = false;

  const consume = (async (): Promise<void> => {
    for await (const evt of subscription) {
      if (evt.event === 'text') {
        if (truncated) continue;
        const remainingBudget =
          MAX_ASSISTANT_CONTENT_BYTES - Buffer.byteLength(accumulatedText, 'utf-8');
        if (remainingBudget <= 0) {
          truncated = true;
          log.warn(
            `chat[${sessionId}]: assistant output exceeded ${MAX_ASSISTANT_CONTENT_BYTES} bytes — truncating`,
          );
          continue;
        }
        const piece =
          Buffer.byteLength(evt.text, 'utf-8') <= remainingBudget
            ? evt.text
            : Buffer.from(evt.text, 'utf-8').subarray(0, remainingBudget).toString('utf-8');
        accumulatedText += piece;
        const last = blocks[blocks.length - 1];
        if (last?.type === 'text') last.text += piece;
        else blocks.push({ type: 'text', text: piece });
        chatBus.emit('chat.message.chunk.text', {
          sessionId,
          assistantId,
          text: piece,
        });
        if (piece.length < evt.text.length) {
          truncated = true;
          log.warn(
            `chat[${sessionId}]: truncated mid-chunk at ${MAX_ASSISTANT_CONTENT_BYTES} bytes`,
          );
        }
      } else if (evt.event === 'tool_use') {
        blocks.push({
          type: 'tool_use',
          id: evt.id,
          title: evt.title,
          kind: evt.kind,
          status: evt.status,
        });
        chatBus.emit('chat.message.chunk.tool_use', {
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
        chatBus.emit('chat.message.chunk.tool_update', {
          sessionId,
          assistantId,
          id: evt.id,
          status: evt.status,
        });
      } else if (evt.event === 'complete') {
        const ts = new Date().toISOString();
        const isError = evt.stopReason === 'failed';
        const isCancelled = evt.stopReason === 'cancelled';
        const msg: ChatMessage = {
          id: assistantId,
          role: isError ? 'error' : 'assistant',
          content:
            accumulatedText.trim() ||
            (isError ? `stopped: ${evt.stopReason}` : isCancelled ? '(cancelled)' : ''),
          blocks: blocks.length > 0 ? blocks : undefined,
          truncated: truncated || undefined,
          ts,
          status: isError ? 'error' : 'complete',
        };
        persistAndEmitComplete(sessionId, msg, log);
        break;
      }
    }
  })();

  try {
    await client.startRun(slot, fullPrompt, 'claude', sessionCwd);
  } catch (err) {
    subscription.cancel();
    activeSessions.delete(slot);
    persistAndEmitComplete(
      sessionId,
      {
        id: assistantId,
        role: 'error',
        content: `startRun failed: ${err instanceof Error ? err.message : String(err)}`,
        ts: new Date().toISOString(),
        status: 'error',
      },
      log,
    );
    return;
  }

  try {
    await consume;
    try {
      await client.clearRun(slot);
    } catch {
      /* best effort */
    }
  } finally {
    activeSessions.delete(slot);
  }
}

/**
 * v0.51.8：在 user 消息末尾追加附件清单。Worker（Claude Code）能用 Read 工具
 * 自己拉文件内容；图片 / PDF / 文本 / 等都原生支持。
 */
function formatPromptWithAttachments(text: string, attachments?: string[]): string {
  if (!attachments || attachments.length === 0) return text;
  const lines = ['', '[Attachments — read with Read tool when relevant]'];
  for (const p of attachments) lines.push(`- ${p}`);
  return text + '\n' + lines.join('\n');
}

function persistAndEmitComplete(sessionId: string, msg: ChatMessage, log: Logger): void {
  const session = readSession(sessionId);
  if (!session) return;
  session.messages.push(msg);
  session.lastMessageAt = msg.ts;
  session.messageCount = session.messages.length;
  writeSession(session);
  chatBus.emit('chat.message.complete', {
    sessionId,
    assistantId: msg.id,
    message: msg,
  });
  if (msg.role === 'error') log.warn(`chat[${sessionId}]: ${msg.content}`);
  else
    log.ok(
      `chat[${sessionId}]: assistant complete (${msg.content.length} chars, ${msg.blocks?.length ?? 0} blocks)`,
    );
}

export function createChatRoute(log: Logger, chat: ChatService): Hono {
  const app = new Hono();

  app.get('/sessions', async (c) => {
    const r = await chat.list();
    if (!r.ok) return sendResult(c, r);
    return c.json({ data: r.value });
  });

  app.post('/sessions', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      title?: string;
      project?: string;
      cwd?: string;
    };
    const r = await chat.create({
      title: body.title,
      project: body.project,
      cwd: body.cwd,
    });
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    chatBus.emit('chat.session.created', { sessionId: r.value.id });
    return c.json(r.value, 201);
  });

  app.get('/sessions/:id', async (c) => {
    return sendResult(c, await chat.get(c.req.param('id')));
  });

  app.get('/sessions/:id/messages', async (c) => {
    const r = await chat.getMessages(c.req.param('id'), c.req.query('since') ?? undefined);
    return sendResult(c, r);
  });

  app.delete('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    const r = await chat.delete(id);
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    // v0.51.8：删除该 session 的附件目录（best effort）
    try {
      const { rmSync } = await import('node:fs');
      const dir = chatAttachmentsDirFor(id);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    } catch {
      /* non-fatal */
    }
    chatBus.emit('chat.session.deleted', { sessionId: id });
    return c.body(null, 204);
  });

  app.post('/sessions/:id/interrupt', async (c) => {
    const r = await chat.interrupt(c.req.param('id'));
    if (!r.ok) return c.json(toProblemJson(r.error), toHttpStatus(r.error) as 400);
    return c.body(null, 204);
  });

  /**
   * POST messages —— 非阻塞发送。ChatService 只管持久化；streamAssistantResponse
   * 由 Delivery 层起 goroutine，通过 chatBus 广播给 SSE 订阅者。
   */
  app.post('/sessions/:id/messages', async (c) => {
    const id = c.req.param('id');
    const session = readSession(id);
    if (!session) {
      return c.json({ type: 'not-found', title: 'Session not found', status: 404 }, 404);
    }
    const body = (await c.req.json().catch(() => null)) as
      | { content?: string; attachments?: string[] }
      | null;
    if (!body?.content || typeof body.content !== 'string') {
      return c.json({ type: 'validation', title: 'content required', status: 422 }, 422);
    }
    // v0.51.8：附件路径校验 — 必须绝对、必须存在；空数组 = 无附件
    let attachments: string[] | undefined;
    if (Array.isArray(body.attachments) && body.attachments.length > 0) {
      const valid: string[] = [];
      for (const p of body.attachments) {
        if (typeof p !== 'string' || p.trim() === '') continue;
        const trimmed = p.trim();
        if (!/^([a-zA-Z]:[\\/]|\/)/.test(trimmed)) {
          return c.json(
            { type: 'validation', title: 'attachment must be absolute path', status: 422, detail: trimmed },
            422,
          );
        }
        if (!existsSync(trimmed)) {
          return c.json(
            { type: 'validation', title: 'attachment not found', status: 422, detail: trimmed },
            422,
          );
        }
        valid.push(trimmed);
      }
      if (valid.length > 0) attachments = valid;
    }

    if (activeSessions.has(chatSlot(id))) {
      return c.json(
        {
          type: 'conflict',
          title: 'session busy',
          status: 409,
          detail: 'The previous message is still streaming; wait for it to finish or cancel it.',
        },
        409,
      );
    }
    if (activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
      return c.json(
        {
          type: 'too-many-requests',
          title: 'concurrency limit',
          status: 429,
          detail: `Up to ${MAX_CONCURRENT_SESSIONS} concurrent chat sessions can stream at once. Wait for others to finish or cancel them.`,
        },
        429,
      );
    }

    const userMsg: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: body.content,
      ts: new Date().toISOString(),
      status: 'complete',
      attachments,
    };
    session.messages.push(userMsg);
    session.lastMessageAt = userMsg.ts;
    session.messageCount = session.messages.length;
    if (session.messages.length === 1) session.title = formatTitle(body.content);
    writeSession(session);
    chatBus.emit('chat.message', { sessionId: id, message: userMsg });

    const assistantId = randomUUID();
    chatBus.emit('chat.message.pending', {
      sessionId: id,
      assistantId,
      ts: new Date().toISOString(),
    });

    streamAssistantResponse(id, assistantId, body.content, log, attachments).catch((err) => {
      log.error(`chat[${id}] stream error: ${err instanceof Error ? err.message : String(err)}`);
    });

    return c.json({ user: userMsg, assistantId }, 202);
  });

  return app;
}

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
          chatBus.on(event, fn);
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
          for (const h of handlers) chatBus.off(h.event, h.fn);
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
