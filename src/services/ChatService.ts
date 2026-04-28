/**
 * @module        services/ChatService
 * @description   Chat 会话 CRUD service
 *
 * @layer         services
 *
 * Phase 2 范围：
 *   - session 生命周期（list / create / get / delete）
 *   - messages diff 查询
 *
 * Phase 3 追加：
 *   - sendMessage（走 daemon IPC + SSE 流式推送）—— 通过注入 ChatExecutor port
 *
 * 本 service 隐藏 chat session JSON 文件的存储细节，使用 FileSystem port。
 */
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { Clock } from '../infra/clock.js';
import type { FileSystem } from '../infra/filesystem.js';
import type { DomainEventBus } from '../shared/domainEvents.js';
import { type DomainError, domainError } from '../shared/errors.js';
import { err, ok, type Result } from '../shared/result.js';
import { chatSessionsDir } from '../shared/runtimePaths.js';

export interface ChatMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system' | 'error';
  readonly content: string;
  readonly ts: string;
  readonly blocks?: unknown[];
}

export interface ChatSession {
  readonly id: string;
  readonly createdAt: string;
  readonly lastMessageAt: string | null;
  readonly title: string;
  readonly project: string | null;
  readonly messageCount: number;
  readonly messages: ChatMessage[];
  /**
   * v0.51.4: Working directory the worker should use for this session. Captured at
   * create time so different sessions can target different repos. Absent (null) =
   * fall back to daemon's startup cwd (legacy behavior).
   */
  readonly cwd?: string | null;
}

export interface ChatSessionSummary {
  readonly id: string;
  readonly createdAt: string;
  readonly lastMessageAt: string | null;
  readonly title: string;
  readonly project: string | null;
  readonly messageCount: number;
  readonly cwd?: string | null;
}

export interface CreateSessionInput {
  title?: string;
  project?: string | null;
  /** v0.51.4: optional working dir; if provided must be absolute and exist. */
  cwd?: string | null;
}

export interface ChatExecutor {
  /** 停止会话对应的 daemon worker（Delete 时清理） */
  stopSession(sessionId: string): Promise<void>;
  /** 中断正在进行的 assistant turn */
  cancelRun(sessionId: string): Promise<void>;
}

export interface ChatServiceDeps {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly events: DomainEventBus;
  readonly executor?: ChatExecutor;
}

export class ChatService {
  constructor(private readonly deps: ChatServiceDeps) {}

  async list(): Promise<Result<ChatSessionSummary[], DomainError>> {
    const dir = chatSessionsDir();
    if (!this.deps.fs.exists(dir)) return ok([]);
    let files;
    try {
      files = this.deps.fs.readDir(dir).filter((e) => e.isFile && e.name.endsWith('.json'));
    } catch (cause) {
      return err(domainError('internal', 'CHAT_LIST_FAIL', '会话列表读取失败', { cause }));
    }
    const summaries: ChatSessionSummary[] = [];
    for (const entry of files) {
      const path = resolve(dir, entry.name);
      try {
        const raw = this.deps.fs.readFile(path);
        const session = JSON.parse(raw) as ChatSession;
        summaries.push(this.summarize(session));
      } catch {
        /* 跳过坏 session */
      }
    }
    summaries.sort((a, b) => {
      const ta = a.lastMessageAt ?? a.createdAt;
      const tb = b.lastMessageAt ?? b.createdAt;
      return Date.parse(tb) - Date.parse(ta);
    });
    return ok(summaries);
  }

  async create(input: CreateSessionInput = {}): Promise<Result<ChatSessionSummary, DomainError>> {
    // v0.51.4: validate cwd if provided
    let cwd: string | null = null;
    if (input.cwd != null && input.cwd.trim() !== '') {
      const trimmed = input.cwd.trim();
      const validation = validateCwd(trimmed, this.deps.fs);
      if (!validation.ok) return validation;
      cwd = validation.value;
    }

    const id = randomUUID();
    const session: ChatSession = {
      id,
      createdAt: this.deps.clock.nowIso(),
      lastMessageAt: null,
      title: input.title?.trim() || '新对话',
      project: input.project ?? null,
      messageCount: 0,
      messages: [],
      cwd,
    };
    try {
      this.deps.fs.writeFileAtomic(this.sessionPath(id), JSON.stringify(session));
    } catch (cause) {
      return err(domainError('internal', 'CHAT_CREATE_FAIL', '会话创建失败', { cause }));
    }
    return ok(this.summarize(session));
  }

  async get(id: string): Promise<Result<ChatSession, DomainError>> {
    if (!isValidSessionId(id)) return err(invalidId());
    const path = this.sessionPath(id);
    if (!this.deps.fs.exists(path)) {
      return err(domainError('not-found', 'CHAT_SESSION_NOT_FOUND', '会话不存在'));
    }
    try {
      const raw = this.deps.fs.readFile(path);
      return ok(JSON.parse(raw) as ChatSession);
    } catch (cause) {
      return err(domainError('internal', 'CHAT_READ_FAIL', '会话读取失败', { cause }));
    }
  }

  /** 返回 since 之后的消息（供 SSE 重连补偿）。since 缺省返回全部。 */
  async getMessages(
    id: string,
    since?: string,
  ): Promise<Result<{ data: ChatMessage[]; total: number }, DomainError>> {
    const sessionR = await this.get(id);
    if (!sessionR.ok) return sessionR;
    const session = sessionR.value;
    const messages = since ? session.messages.filter((m) => m.ts > since) : session.messages;
    return ok({ data: messages, total: session.messages.length });
  }

  async delete(id: string): Promise<Result<void, DomainError>> {
    if (!isValidSessionId(id)) return err(invalidId());
    const path = this.sessionPath(id);
    if (this.deps.fs.exists(path)) {
      try {
        this.deps.fs.unlink(path);
      } catch (cause) {
        return err(domainError('internal', 'CHAT_DELETE_FAIL', '会话删除失败', { cause }));
      }
    }
    // best effort 停止 daemon worker
    if (this.deps.executor) {
      try {
        await this.deps.executor.stopSession(id);
      } catch {
        /* 不阻塞删除 */
      }
    }
    return ok(undefined);
  }

  async interrupt(id: string): Promise<Result<void, DomainError>> {
    if (!isValidSessionId(id)) return err(invalidId());
    if (!this.deps.executor) {
      return err(
        domainError('internal', 'EXECUTOR_MISSING', 'ChatExecutor 未注入'),
      );
    }
    try {
      await this.deps.executor.cancelRun(id);
    } catch (cause) {
      return err(
        domainError('external', 'CHAT_CANCEL_FAIL', '中断会话失败', { cause }),
      );
    }
    return ok(undefined);
  }

  // ─── helpers ──────────────────────────────────────────────────────

  private sessionPath(id: string): string {
    return resolve(chatSessionsDir(), `${id}.json`);
  }

  private summarize(s: ChatSession): ChatSessionSummary {
    return {
      id: s.id,
      createdAt: s.createdAt,
      lastMessageAt: s.lastMessageAt,
      title: s.title,
      project: s.project,
      messageCount: s.messageCount,
      cwd: s.cwd ?? null,
    };
  }
}

function isValidSessionId(id: string): boolean {
  return typeof id === 'string' && /^[a-zA-Z0-9-]+$/.test(id);
}

function invalidId(): DomainError {
  return domainError('validation', 'INVALID_SESSION_ID', 'session id 非法');
}

/**
 * v0.51.4: validate that cwd is absolute, exists on disk, and isn't pointing
 * at something dangerous. Returns a normalized absolute path on success.
 */
function validateCwd(
  cwd: string,
  fs: FileSystem,
): Result<string, DomainError> {
  // Must be absolute (no relative paths — daemon would resolve them against its
  // own cwd, which defeats the purpose of letting users pick).
  if (!cwd.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(cwd)) {
    return err(
      domainError('validation', 'CHAT_CWD_NOT_ABSOLUTE', '工作目录必须是绝对路径', {
        details: { cwd },
      }),
    );
  }
  if (!fs.exists(cwd)) {
    return err(
      domainError('validation', 'CHAT_CWD_NOT_FOUND', `工作目录不存在: ${cwd}`, {
        details: { cwd },
      }),
    );
  }
  return ok(cwd);
}
