import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, MessageCircle, Trash2, Send } from 'lucide-react';
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  postMessage,
  type ChatMessage,
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

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  // 滚到底
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [currentQ.data]);

  const handleNewSession = async (): Promise<void> => {
    const s = await createSession();
    qc.invalidateQueries({ queryKey: ['chat-sessions'] });
    nav(`/chat/${s.id}`);
  };

  const handleSend = async (): Promise<void> => {
    if (!draft.trim()) return;
    let id = sessionId;
    if (!id) {
      const s = await createSession();
      qc.invalidateQueries({ queryKey: ['chat-sessions'] });
      id = s.id;
      nav(`/chat/${id}`);
    }
    setSending(true);
    const content = draft;
    setDraft('');
    try {
      await postMessage(id, content);
      qc.invalidateQueries({ queryKey: ['chat-session', id] });
      qc.invalidateQueries({ queryKey: ['chat-sessions'] });
    } catch (err) {
      // TODO: toast
      // eslint-disable-next-line no-console
      console.error(err);
    } finally {
      setSending(false);
    }
  };

  const handleDelete = async (id: string): Promise<void> => {
    if (!window.confirm('删除这个对话？')) return;
    await deleteSession(id);
    qc.invalidateQueries({ queryKey: ['chat-sessions'] });
    if (sessionId === id) nav('/chat');
  };

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
                {currentQ.data?.title ?? '加载中…'}
              </h2>
              <p className="text-xs text-[var(--color-text-muted)] font-[family-name:var(--font-mono)]">
                {currentQ.data?.id}
              </p>
            </header>
            <div ref={streamRef} className="flex-1 overflow-auto p-4 flex flex-col gap-4">
              {(currentQ.data?.messages ?? []).map((m) => (
                <MessageBubble key={m.id} msg={m} />
              ))}
              {sending && (
                <div className="self-start max-w-xl nb-card bg-[var(--color-accent-mint)] p-3 animate-pulse">
                  <p className="text-sm">思考中…</p>
                </div>
              )}
              {!currentQ.isLoading && (currentQ.data?.messages ?? []).length === 0 && !sending && (
                <p className="text-center text-[var(--color-text-subtle)] italic mt-12">
                  下方输入问题开始对话
                </p>
              )}
            </div>
            <div className="border-t-2 border-[var(--color-text)] p-3 bg-[var(--color-bg-cream)]">
              <div className="flex gap-2">
                <textarea
                  className="nb-input flex-1 resize-none"
                  placeholder="说点什么… (⌘+Enter 发送)"
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  aria-label="消息输入"
                  disabled={sending}
                />
                <button
                  className="nb-btn nb-btn-primary"
                  onClick={handleSend}
                  disabled={!draft.trim() || sending}
                  type="button"
                  aria-label="发送"
                >
                  <Send size={14} strokeWidth={3} />
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
                点左上角"新建对话"开始一个 session。每个 session 会 spawn 一次 <code className="bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] px-2 py-0.5 rounded font-[family-name:var(--font-mono)]">sps agent</code> 处理消息。
              </p>
              <p className="text-xs text-[var(--color-text-subtle)] italic">
                v0.44 不支持流式输出，等待 v0.45 接入 ACP daemon。
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: ChatMessage }) {
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
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
          {isUser ? '你' : isError ? '错误' : 'assistant'} · {formatTimeAgo(msg.ts)}
        </p>
        <pre className="text-sm font-[family-name:var(--font-body)] whitespace-pre-wrap break-words">
          {msg.content}
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
