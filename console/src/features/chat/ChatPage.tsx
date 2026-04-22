import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, MessageCircle, Trash2, Send, Loader2 } from 'lucide-react';
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  postMessage,
  type ChatMessage,
  type ChatSessionDetail,
} from '../../shared/api/chat';

export function ChatPage() {
  const { sessionId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();

  const sessionsQ = useQuery({ queryKey: ['chat-sessions'], queryFn: listSessions });
  const currentQ = useQuery({
    queryKey: ['chat-session', sessionId],
    queryFn: () => getSession(sessionId ?? ''),
    enabled: !!sessionId,
  });

  // 流式 pending 消息：当 chat.message.pending 到达后存在这里，chunk 累积，complete 后并入 messages
  const [pending, setPending] = useState<{ id: string; content: string } | null>(null);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  // 订阅 SSE，仅当 sessionId 存在
  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/stream/chat/${encodeURIComponent(sessionId)}`);

    // 1. user 消息（本次 POST 的）—— 乐观 UI 已显示，这里只是补校验
    es.addEventListener('chat.message', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          message: ChatMessage;
        };
        // 乐观 UI 已经把 user 消息塞进 cache 了，这里把服务器版本替换进来（权威）
        qc.setQueryData<ChatSessionDetail | undefined>(
          ['chat-session', sessionId],
          (old) => {
            if (!old) return old;
            const exists = old.messages.some((m) => m.id === data.message.id);
            if (exists) return old;
            // 如果 user msg 是服务器的正式 id，去替换 optimistic 版本（content 相同的最新一条）
            const optimisticIdx = old.messages.findIndex(
              (m) => m.role === 'user' && m.id.startsWith('optim-') && m.content === data.message.content,
            );
            if (optimisticIdx >= 0) {
              const next = [...old.messages];
              next[optimisticIdx] = data.message;
              return { ...old, messages: next };
            }
            return { ...old, messages: [...old.messages, data.message] };
          },
        );
      } catch {
        /* ignore */
      }
    });

    // 2. assistant pending
    es.addEventListener('chat.message.pending', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          assistantId: string;
        };
        setPending({ id: data.assistantId, content: '' });
      } catch {
        /* ignore */
      }
    });

    // 3. assistant chunk（累积）
    es.addEventListener('chat.message.chunk', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          assistantId: string;
          accumulated: string;
        };
        setPending((prev) =>
          prev && prev.id === data.assistantId
            ? { id: prev.id, content: data.accumulated }
            : prev,
        );
      } catch {
        /* ignore */
      }
    });

    // 4. assistant complete → 清 pending + 把 message 并入 cache
    es.addEventListener('chat.message.complete', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          assistantId: string;
          message: ChatMessage;
        };
        setPending((prev) => (prev && prev.id === data.assistantId ? null : prev));
        qc.setQueryData<ChatSessionDetail | undefined>(
          ['chat-session', sessionId],
          (old) => {
            if (!old) return old;
            const exists = old.messages.some((m) => m.id === data.message.id);
            if (exists) return old;
            return {
              ...old,
              messages: [...old.messages, data.message],
              lastMessageAt: data.message.ts,
              messageCount: old.messageCount + 1,
            };
          },
        );
        qc.invalidateQueries({ queryKey: ['chat-sessions'] });
        setSending(false);
      } catch {
        /* ignore */
      }
    });

    return () => es.close();
  }, [sessionId, qc]);

  // 自动滚底
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [currentQ.data, pending]);

  const handleNewSession = useCallback(async (): Promise<void> => {
    const s = await createSession();
    qc.invalidateQueries({ queryKey: ['chat-sessions'] });
    nav(`/chat/${s.id}`);
  }, [qc, nav]);

  const handleSend = useCallback(async (): Promise<void> => {
    const content = draft.trim();
    if (!content || sending) return;

    let id = sessionId;
    if (!id) {
      const s = await createSession();
      qc.invalidateQueries({ queryKey: ['chat-sessions'] });
      id = s.id;
      nav(`/chat/${id}`, { replace: true });
    }

    // 乐观 UI: 立刻把 user msg 塞进 cache（临时 id 前缀 optim- 便于之后识别替换）
    const optimisticUser: ChatMessage = {
      id: `optim-${Date.now()}`,
      role: 'user',
      content,
      ts: new Date().toISOString(),
      status: 'complete',
    };
    qc.setQueryData<ChatSessionDetail | undefined>(['chat-session', id], (old) => {
      if (!old) {
        return {
          id,
          createdAt: optimisticUser.ts,
          lastMessageAt: optimisticUser.ts,
          title: content.slice(0, 60),
          project: null,
          messageCount: 1,
          messages: [optimisticUser],
        };
      }
      return {
        ...old,
        messages: [...old.messages, optimisticUser],
        lastMessageAt: optimisticUser.ts,
        messageCount: old.messageCount + 1,
      };
    });

    setDraft('');
    setSending(true);
    try {
      await postMessage(id, content);
      // 不用 await response — assistant chunks 走 SSE
    } catch (err) {
      setSending(false);
      // eslint-disable-next-line no-console
      console.error('sendMessage failed', err);
      window.alert(`发送失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [draft, sending, sessionId, qc, nav]);

  const handleDelete = useCallback(
    async (id: string): Promise<void> => {
      if (!window.confirm('删除这个对话？')) return;
      await deleteSession(id);
      qc.invalidateQueries({ queryKey: ['chat-sessions'] });
      if (sessionId === id) nav('/chat');
    },
    [qc, sessionId, nav],
  );

  return (
    <div className="grid grid-cols-[260px_1fr] gap-4 h-[calc(100vh-140px)]">
      <aside className="nb-card p-3 overflow-auto flex flex-col gap-2">
        <button
          className="nb-btn nb-btn-primary w-full justify-center"
          onClick={handleNewSession}
          type="button"
        >
          <Plus size={14} strokeWidth={3} />
          新建对话
        </button>
        <div className="mt-2 text-xs font-[family-name:var(--font-heading)] uppercase tracking-wider text-[var(--color-text-muted)] px-2">
          历史 {sessionsQ.data?.data.length ?? 0}
        </div>
        <div className="flex flex-col gap-1.5 mt-1">
          {(sessionsQ.data?.data ?? []).map((s) => (
            <div
              key={s.id}
              className={[
                'group flex items-start gap-2 p-2 rounded-lg border-2 border-transparent cursor-pointer',
                sessionId === s.id
                  ? 'bg-[var(--color-accent-mint)] border-[var(--color-text)] shadow-[2px_2px_0_var(--color-text)]'
                  : 'hover:bg-[var(--color-bg-cream)] hover:border-[var(--color-text)]',
              ].join(' ')}
              onClick={() => nav(`/chat/${s.id}`)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') nav(`/chat/${s.id}`);
              }}
              tabIndex={0}
              role="button"
            >
              <MessageCircle size={14} strokeWidth={2.5} className="mt-0.5 flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate">{s.title}</p>
                <p className="text-[10px] text-[var(--color-text-muted)] font-[family-name:var(--font-mono)] truncate">
                  {s.messageCount} msg · {formatTimeAgo(s.lastMessageAt ?? s.createdAt)}
                </p>
              </div>
              <button
                type="button"
                aria-label="删除对话"
                className="opacity-0 group-hover:opacity-100 p-1 hover:text-[var(--color-crashed)]"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDelete(s.id);
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
          {(sessionsQ.data?.data ?? []).length === 0 && (
            <p className="text-xs text-[var(--color-text-subtle)] italic text-center py-4">
              还没对话。点上面新建。
            </p>
          )}
        </div>
      </aside>

      <div className="nb-card p-0 flex flex-col overflow-hidden">
        {sessionId ? (
          <>
            <header className="px-4 py-3 border-b-2 border-[var(--color-text)] bg-[var(--color-bg-cream)]">
              <h2 className="font-[family-name:var(--font-heading)] font-bold text-lg">
                {currentQ.data?.title ?? '新对话'}
              </h2>
              <p className="text-xs text-[var(--color-text-muted)] font-[family-name:var(--font-mono)]">
                {sessionId}
              </p>
            </header>
            <div ref={streamRef} className="flex-1 overflow-auto p-4 flex flex-col gap-4">
              {(currentQ.data?.messages ?? []).map((m) => (
                <MessageBubble key={m.id} msg={m} />
              ))}
              {pending && (
                <MessageBubble
                  msg={{
                    id: pending.id,
                    role: 'assistant',
                    content: pending.content,
                    ts: new Date().toISOString(),
                    status: 'streaming',
                  }}
                  streaming
                />
              )}
              {!currentQ.isLoading && (currentQ.data?.messages ?? []).length === 0 && !pending && !sending && (
                <p className="text-center text-[var(--color-text-subtle)] italic mt-12">
                  下方输入问题开始对话 · Enter 发送 · Shift+Enter 换行
                </p>
              )}
            </div>
            <div className="border-t-2 border-[var(--color-text)] p-3 bg-[var(--color-bg-cream)]">
              <div className="flex gap-2 items-end">
                <textarea
                  className="nb-input flex-1 resize-none"
                  placeholder="说点什么… (Enter 发送，Shift+Enter 换行)"
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  aria-label="消息输入"
                />
                <button
                  className="nb-btn nb-btn-primary"
                  onClick={handleSend}
                  disabled={!draft.trim() || sending}
                  type="button"
                  aria-label="发送"
                >
                  {sending ? (
                    <Loader2 size={14} strokeWidth={3} className="animate-spin" />
                  ) : (
                    <Send size={14} strokeWidth={3} />
                  )}
                  发送
                </button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="text-center max-w-md">
              <div className="w-20 h-20 rounded-2xl bg-[var(--color-accent-mint)] border-[3px] border-[var(--color-text)] shadow-[3px_3px_0_var(--color-text)] flex items-center justify-center mx-auto mb-4">
                <MessageCircle size={32} strokeWidth={2.5} />
              </div>
              <h1 className="font-[family-name:var(--font-heading)] text-2xl font-bold mb-2">
                对话 💬
              </h1>
              <p className="text-sm text-[var(--color-text-muted)] mb-4">
                点左上角"新建对话"开始一个 session。或直接在下方输入，会自动建 session。
              </p>
              <p className="text-xs text-[var(--color-text-subtle)] italic">
                Enter 发送 · Shift+Enter 换行 · 内容流式返回
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ msg, streaming }: { msg: ChatMessage; streaming?: boolean }) {
  const isUser = msg.role === 'user';
  const isError = msg.role === 'error';
  return (
    <div className={isUser ? 'self-end max-w-3xl' : 'self-start max-w-3xl'}>
      <div
        className={[
          'nb-card',
          isUser
            ? 'bg-[var(--color-secondary)]'
            : isError
              ? 'bg-[var(--color-crashed-bg)]'
              : 'bg-[var(--color-bg)]',
        ].join(' ')}
      >
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1 flex items-center gap-2">
          {isUser ? '你' : isError ? '错误' : 'assistant'}
          <span className="font-normal">·</span>
          <span className="font-normal">{formatTimeAgo(msg.ts)}</span>
          {streaming && (
            <span className="flex items-center gap-1 font-normal text-[var(--color-running)]">
              <Loader2 size={10} strokeWidth={3} className="animate-spin" />
              streaming
            </span>
          )}
        </p>
        <pre className="text-sm font-[family-name:var(--font-body)] whitespace-pre-wrap break-words">
          {msg.content || (streaming ? '…' : '')}
          {streaming && <span className="inline-block w-2 h-4 ml-1 bg-[var(--color-text)] animate-pulse align-middle" />}
        </pre>
      </div>
    </div>
  );
}

function formatTimeAgo(ts: string | null): string {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚才';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  return d.toLocaleDateString();
}
