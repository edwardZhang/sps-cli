import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, MessageCircle, Trash2, Send, Loader2, ChevronRight, Wrench, CheckCircle2, XCircle, Square, Folder, FolderOpen, X, Paperclip, Image as ImageIcon, FileText, Eye } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import 'highlight.js/styles/github.css';
import {
  createSession,
  deleteSession,
  getMessagesSince,
  getSession,
  interruptSession,
  listSessions,
  postMessage,
  type ChatMessage,
  type ChatMessageBlock,
  type ChatSessionDetail,
} from '../../shared/api/chat';
import {
  ATTACHMENT_MAX_BYTES,
  attachmentUrl,
  uploadAttachment,
} from '../../shared/api/fs';
import { DirectoryPicker } from '../../shared/components/DirectoryPicker';
import { useDialog } from '../../shared/components/DialogProvider';

export function ChatPage() {
  const { sessionId } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const { confirm, alert } = useDialog();

  const sessionsQ = useQuery({ queryKey: ['chat-sessions'], queryFn: listSessions });
  const currentQ = useQuery({
    queryKey: ['chat-session', sessionId],
    queryFn: () => getSession(sessionId ?? ''),
    enabled: !!sessionId,
  });

  // v0.46 流式 pending：按块累积，text 块按字符 drain，tool 块即时出现
  // 服务端 complete 时只更新 finalMessage + done 标记，实际 commit 等 drain 追齐再触发
  type PendingBlock =
    | { type: 'text'; target: string; displayed: string }
    | { type: 'tool_use'; id: string; title: string; kind: string; status: string };
  type PendingState = {
    id: string;
    blocks: PendingBlock[];
    done: boolean;
    finalMessage: ChatMessage | null;
  };
  const [pending, setPending] = useState<PendingState | null>(null);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  // v0.51.4: 新建对话 dialog 状态（指定 cwd）
  const [newSessionOpen, setNewSessionOpen] = useState(false);

  // v0.51.8: 当前 draft 的附件（绝对路径数组）+ 上传中状态
  const [draftAttachments, setDraftAttachments] = useState<
    Array<{ path: string; name: string }>
  >([]);
  const [uploading, setUploading] = useState(false);
  // 浏览本机文件 picker（用 mode=file 的 DirectoryPicker）
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  // 拖拽进 input 区的视觉反馈
  const [dragOver, setDragOver] = useState(false);
  // 预览模态：点 chip / 消息附件触发
  const [previewPath, setPreviewPath] = useState<string | null>(null);

  // 订阅 SSE，仅当 sessionId 存在
  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/stream/chat/${encodeURIComponent(sessionId)}`);

    // v0.47.1 断线重连补偿：EventSource 自动重连，首次 open 之后的 open 事件
    // 触发 diff fetch 把错过的消息拉回来。避免重复：拉到 id 已在 cache 就跳过。
    let firstOpen = true;
    es.addEventListener('open', () => {
      if (firstOpen) {
        firstOpen = false;
        return;
      }
      const cache = qc.getQueryData<ChatSessionDetail>(['chat-session', sessionId]);
      const lastTs = cache?.messages.length
        ? cache.messages[cache.messages.length - 1]!.ts
        : undefined;
      getMessagesSince(sessionId, lastTs)
        .then((res) => {
          if (res.data.length === 0) return;
          qc.setQueryData<ChatSessionDetail | undefined>(
            ['chat-session', sessionId],
            (old) => {
              if (!old) return old;
              const existingIds = new Set(old.messages.map((m) => m.id));
              const newOnes = res.data.filter((m) => !existingIds.has(m.id));
              if (newOnes.length === 0) return old;
              return {
                ...old,
                messages: [...old.messages, ...newOnes],
                lastMessageAt: newOnes[newOnes.length - 1]!.ts,
                messageCount: old.messageCount + newOnes.length,
              };
            },
          );
        })
        .catch(() => { /* best effort */ });
    });

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
        setPending({
          id: data.assistantId,
          blocks: [],
          done: false,
          finalMessage: null,
        });
      } catch {
        /* ignore */
      }
    });

    // 3a. text chunk → 追加到最后一个 text 块的 target（drain loop 推进 displayed）
    es.addEventListener('chat.message.chunk.text', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          assistantId: string;
          text: string;
        };
        setPending((prev) => {
          if (!prev || prev.id !== data.assistantId) return prev;
          const blocks = [...prev.blocks];
          const last = blocks[blocks.length - 1];
          if (last && last.type === 'text') {
            blocks[blocks.length - 1] = { ...last, target: last.target + data.text };
          } else {
            blocks.push({ type: 'text', target: data.text, displayed: '' });
          }
          return { ...prev, blocks };
        });
      } catch {
        /* ignore */
      }
    });

    // 3b. tool_use chunk → 即时插入新 tool 块
    es.addEventListener('chat.message.chunk.tool_use', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          assistantId: string;
          id: string;
          title: string;
          kind: string;
          status: string;
        };
        setPending((prev) => {
          if (!prev || prev.id !== data.assistantId) return prev;
          return {
            ...prev,
            blocks: [
              ...prev.blocks,
              { type: 'tool_use', id: data.id, title: data.title, kind: data.kind, status: data.status },
            ],
          };
        });
      } catch {
        /* ignore */
      }
    });

    // 3c. tool_update → 更新对应 tool_use 块的 status
    es.addEventListener('chat.message.chunk.tool_update', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          assistantId: string;
          id: string;
          status: string;
        };
        setPending((prev) => {
          if (!prev || prev.id !== data.assistantId) return prev;
          return {
            ...prev,
            blocks: prev.blocks.map((b) =>
              b.type === 'tool_use' && b.id === data.id ? { ...b, status: data.status } : b,
            ),
          };
        });
      } catch {
        /* ignore */
      }
    });

    // 4. assistant complete → 标记 done + 存 finalMessage，实际 commit 等 drain 追齐
    es.addEventListener('chat.message.complete', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          sessionId: string;
          assistantId: string;
          message: ChatMessage;
        };
        setPending((prev) =>
          prev && prev.id === data.assistantId
            ? { ...prev, done: true, finalMessage: data.message }
            : prev,
        );
      } catch {
        /* ignore */
      }
    });

    return () => es.close();
  }, [sessionId, qc]);

  // drain loop: 25ms 一 tick，推进所有 text 块的 displayed 向 target
  //   总 gap = sum(target.length - displayed.length) across text blocks
  //   每 tick 步长 = max(1, ceil(gap/40))，按块顺序分配
  //   全部追齐 && 服务端已 done → commit finalMessage + 清 pending
  useEffect(() => {
    if (!pending) return;
    const totalGap = pending.blocks.reduce(
      (sum, b) => (b.type === 'text' ? sum + (b.target.length - b.displayed.length) : sum),
      0,
    );
    if (totalGap <= 0) {
      if (pending.done && pending.finalMessage) {
        const final = pending.finalMessage;
        qc.setQueryData<ChatSessionDetail | undefined>(
          ['chat-session', sessionId],
          (old) => {
            if (!old) return old;
            if (old.messages.some((m) => m.id === final.id)) return old;
            return {
              ...old,
              messages: [...old.messages, final],
              lastMessageAt: final.ts,
              messageCount: old.messageCount + 1,
            };
          },
        );
        qc.invalidateQueries({ queryKey: ['chat-sessions'] });
        setPending(null);
        setSending(false);
      }
      return;
    }
    const timer = setTimeout(() => {
      setPending((prev) => {
        if (!prev) return prev;
        let remaining = Math.max(1, Math.ceil(totalGap / 40));
        const blocks = prev.blocks.map((b) => {
          if (b.type !== 'text' || remaining <= 0) return b;
          const gap = b.target.length - b.displayed.length;
          if (gap <= 0) return b;
          const step = Math.min(gap, remaining);
          remaining -= step;
          return { ...b, displayed: b.target.slice(0, b.displayed.length + step) };
        });
        return { ...prev, blocks };
      });
    }, 25);
    return () => clearTimeout(timer);
  }, [pending, qc, sessionId]);

  // 自动滚底
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [currentQ.data, pending]);

  const handleNewSession = useCallback(
    async (opts: { cwd?: string; title?: string } = {}): Promise<void> => {
      try {
        const s = await createSession({
          cwd: opts.cwd?.trim() || undefined,
          title: opts.title?.trim() || undefined,
        });
        qc.invalidateQueries({ queryKey: ['chat-sessions'] });
        nav(`/chat/${s.id}`);
        setNewSessionOpen(false);
      } catch (err) {
        void alert({
          title: '新建对话失败',
          body: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [qc, nav, alert],
  );

  const handleSend = useCallback(async (): Promise<void> => {
    const content = draft.trim();
    // v0.51.8: 允许仅含附件无文本的发送（content 至少一个附件名替代）
    if (!content && draftAttachments.length === 0) return;
    if (sending) return;

    let id = sessionId;
    if (!id) {
      const s = await createSession();
      qc.invalidateQueries({ queryKey: ['chat-sessions'] });
      id = s.id;
      nav(`/chat/${id}`, { replace: true });
    }

    // 乐观 UI: 立刻把 user msg 塞进 cache（临时 id 前缀 optim- 便于之后识别替换）
    const attachmentPaths = draftAttachments.map((a) => a.path);
    const optimisticUser: ChatMessage = {
      id: `optim-${Date.now()}`,
      role: 'user',
      content: content || '(附件)',
      ts: new Date().toISOString(),
      status: 'complete',
      attachments: attachmentPaths.length > 0 ? attachmentPaths : undefined,
    };
    qc.setQueryData<ChatSessionDetail | undefined>(['chat-session', id], (old) => {
      if (!old) {
        return {
          id,
          createdAt: optimisticUser.ts,
          lastMessageAt: optimisticUser.ts,
          title: content.slice(0, 60) || '附件',
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
    setDraftAttachments([]);
    setSending(true);
    try {
      await postMessage(id, content || '(请查看附件)', attachmentPaths.length > 0 ? attachmentPaths : undefined);
      // 不用 await response — assistant chunks 走 SSE
    } catch (err) {
      setSending(false);
      // eslint-disable-next-line no-console
      console.error('sendMessage failed', err);
      void alert({
        title: '发送失败',
        body: err instanceof Error ? err.message : String(err),
      });
    }
  }, [draft, draftAttachments, sending, sessionId, qc, nav, alert]);

  // v0.51.8: 拖拽 / 粘贴文件统一走这条路径（上传 → 加 chip）
  const ingestFile = useCallback(
    async (file: File): Promise<void> => {
      // 1. 大小预校验
      if (file.size > ATTACHMENT_MAX_BYTES) {
        void alert({
          title: '文件超过上限',
          body: `单文件上限 50 MB；当前 ${(file.size / 1024 / 1024).toFixed(2)} MB（${file.name}）`,
        });
        return;
      }
      // 2. 确保 session 存在（拖到尚未建 session 的 chat 区时自动建）
      let id = sessionId;
      if (!id) {
        const s = await createSession();
        qc.invalidateQueries({ queryKey: ['chat-sessions'] });
        id = s.id;
        nav(`/chat/${id}`, { replace: true });
      }
      // 3. 上传
      setUploading(true);
      try {
        const r = await uploadAttachment(id, file);
        setDraftAttachments((prev) => [...prev, { path: r.path, name: r.name }]);
      } catch (err) {
        void alert({
          title: '附件上传失败',
          body: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setUploading(false);
      }
    },
    [sessionId, qc, nav, alert],
  );

  const removeAttachment = useCallback((path: string): void => {
    setDraftAttachments((prev) => prev.filter((a) => a.path !== path));
  }, []);

  const handleDelete = useCallback(
    async (id: string): Promise<void> => {
      const ok = await confirm({
        title: '删除对话',
        body: '对话记录会永久删除，不可恢复。',
        confirm: '删除',
        danger: true,
      });
      if (!ok) return;
      await deleteSession(id);
      qc.invalidateQueries({ queryKey: ['chat-sessions'] });
      if (sessionId === id) nav('/chat');
    },
    [qc, sessionId, nav, confirm],
  );

  const handleInterrupt = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    try {
      await interruptSession(sessionId);
      // SSE 'complete' event with stopReason='cancelled' will commit pending + clear it
    } catch (err) {
      void alert({
        title: '中断失败',
        body: err instanceof Error ? err.message : String(err),
      });
    }
  }, [sessionId, alert]);

  return (
    <div className="grid grid-cols-[260px_1fr] gap-4 h-[calc(100vh-140px)]">
      <aside className="nb-card p-3 overflow-auto flex flex-col gap-2">
        <button
          className="nb-btn nb-btn-primary w-full justify-center"
          onClick={() => setNewSessionOpen(true)}
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
            // v0.49 a11y: row 用 div 容器而非 button 包 button（nested-interactive 违规）
            // 主体 <button> 点击跳 session；删除 <button> 单独放，stopPropagation 隔离
            <div
              key={s.id}
              className={[
                'group flex items-start gap-2 p-2 rounded-lg border-2 border-transparent',
                sessionId === s.id
                  ? 'bg-[var(--color-accent-mint)] border-[var(--color-text)] shadow-[2px_2px_0_var(--color-text)]'
                  : 'hover:bg-[var(--color-bg-cream)] hover:border-[var(--color-text)]',
              ].join(' ')}
            >
              <button
                type="button"
                aria-label={`打开对话 ${s.title}${s.cwd ? `（工作目录 ${s.cwd}）` : ''}`}
                onClick={() => nav(`/chat/${s.id}`)}
                className="flex items-start gap-2 flex-1 min-w-0 text-left"
              >
                <MessageCircle size={14} strokeWidth={2.5} className="mt-0.5 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{s.title}</p>
                  <p className="text-[10px] text-[var(--color-text-muted)] font-[family-name:var(--font-mono)] truncate">
                    {s.messageCount} msg · {formatTimeAgo(s.lastMessageAt ?? s.createdAt)}
                  </p>
                  {s.cwd && (
                    <p
                      className="text-[10px] text-[var(--color-text-subtle)] font-[family-name:var(--font-mono)] truncate flex items-center gap-1"
                      title={s.cwd}
                    >
                      <Folder size={9} strokeWidth={2.5} className="flex-shrink-0" />
                      <span className="truncate" dir="rtl">{s.cwd}</span>
                    </p>
                  )}
                </div>
              </button>
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
              {currentQ.data?.cwd && (
                <p
                  className="text-xs text-[var(--color-text-muted)] font-[family-name:var(--font-mono)] flex items-center gap-1 mt-1"
                  title={currentQ.data.cwd}
                >
                  <Folder size={11} strokeWidth={2.5} className="flex-shrink-0" />
                  <span className="truncate">{currentQ.data.cwd}</span>
                </p>
              )}
            </header>
            <div ref={streamRef} className="flex-1 overflow-auto p-4 flex flex-col gap-4">
              {(currentQ.data?.messages ?? []).map((m) => (
                <MessageBubble
                  key={m.id}
                  msg={m}
                  sessionId={sessionId ?? null}
                  onPreviewAttachment={(p) => setPreviewPath(p)}
                />
              ))}
              {pending && (
                <StreamingBubble pending={pending} />
              )}
              {!currentQ.isLoading && (currentQ.data?.messages ?? []).length === 0 && !pending && !sending && (
                <p className="text-center text-[var(--color-text-subtle)] italic mt-12">
                  下方输入问题开始对话 · Enter 发送 · Shift+Enter 换行
                </p>
              )}
            </div>
            <div
              className={[
                'border-t-2 border-[var(--color-text)] p-3 bg-[var(--color-bg-cream)] transition-colors',
                dragOver ? 'bg-[var(--color-accent-mint)]' : '',
              ].join(' ')}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                if (!dragOver) setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                if (!e.dataTransfer.types.includes('Files')) return;
                e.preventDefault();
                setDragOver(false);
                const files = Array.from(e.dataTransfer.files ?? []);
                for (const f of files) void ingestFile(f);
              }}
            >
              {/* v0.51.8: 附件 chips */}
              {(draftAttachments.length > 0 || uploading) && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {draftAttachments.map((a) => (
                    <button
                      key={a.path}
                      type="button"
                      className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--color-bg)] border-2 border-[var(--color-text)] text-xs font-[family-name:var(--font-mono)] hover:bg-[var(--color-accent-mint)] group"
                      onClick={() => setPreviewPath(a.path)}
                      title={`${a.name}\n${a.path}\n点击预览`}
                    >
                      {isImagePath(a.path) ? (
                        <ImageIcon size={11} strokeWidth={2.5} className="flex-shrink-0" />
                      ) : (
                        <FileText size={11} strokeWidth={2.5} className="flex-shrink-0" />
                      )}
                      <span className="truncate max-w-[180px]">{a.name}</span>
                      <span
                        role="button"
                        aria-label={`移除 ${a.name}`}
                        className="ml-1 hover:text-[var(--color-crashed)] cursor-pointer"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeAttachment(a.path);
                        }}
                      >
                        <X size={11} strokeWidth={3} />
                      </span>
                    </button>
                  ))}
                  {uploading && (
                    <span className="flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--color-text-muted)] font-[family-name:var(--font-mono)]">
                      <Loader2 size={11} strokeWidth={2.5} className="animate-spin" />
                      上传中...
                    </span>
                  )}
                </div>
              )}
              <div className="flex gap-2 items-end">
                {/* v0.51.8: 附件按钮 → 浏览本机文件 picker */}
                <button
                  type="button"
                  className="nb-btn flex-shrink-0"
                  onClick={() => setFilePickerOpen(true)}
                  disabled={sending}
                  aria-label="附加本地文件"
                  title="附加本地文件（也可拖拽 / 粘贴图片）"
                >
                  <Paperclip size={14} strokeWidth={2.5} />
                </button>
                <textarea
                  className="nb-input flex-1 resize-none"
                  placeholder={
                    dragOver
                      ? '松开鼠标以附加文件…'
                      : '说点什么… (Enter 发送，Shift+Enter 换行，可拖入文件 / 粘贴图片)'
                  }
                  rows={2}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      handleSend();
                    }
                  }}
                  onPaste={(e) => {
                    // 图片：捕获并上传；文本：保持默认（粘进 textarea）
                    const items = Array.from(e.clipboardData.items ?? []);
                    const imageItems = items.filter((it) => it.kind === 'file' && it.type.startsWith('image/'));
                    if (imageItems.length === 0) return;
                    e.preventDefault();
                    for (const it of imageItems) {
                      const f = it.getAsFile();
                      if (f) void ingestFile(f);
                    }
                  }}
                  aria-label="消息输入"
                />
                {pending ? (
                  <button
                    className="nb-btn nb-btn-danger"
                    onClick={handleInterrupt}
                    type="button"
                    aria-label="中断生成"
                  >
                    <Square size={14} strokeWidth={3} />
                    中断
                  </button>
                ) : (
                  <button
                    className="nb-btn nb-btn-primary"
                    onClick={handleSend}
                    disabled={(!draft.trim() && draftAttachments.length === 0) || sending}
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
                )}
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

      {newSessionOpen && (
        <NewSessionDialog
          onCancel={() => setNewSessionOpen(false)}
          onCreate={(input) => handleNewSession(input)}
        />
      )}

      {/* v0.51.8: 浏览本机文件 picker（mode=file） */}
      {filePickerOpen && (
        <DirectoryPicker
          mode="file"
          title="选择附件文件"
          initialPath={currentQ.data?.cwd ?? undefined}
          onCancel={() => setFilePickerOpen(false)}
          onSelect={(picked) => {
            // 同名 / 已加过 → 跳过
            setDraftAttachments((prev) => {
              if (prev.some((a) => a.path === picked)) return prev;
              const name = picked.split(/[\\/]/).pop() || picked;
              return [...prev, { path: picked, name }];
            });
            setFilePickerOpen(false);
          }}
        />
      )}

      {/* v0.51.8: 附件预览模态 */}
      {previewPath && sessionId && (
        <AttachmentPreview
          sessionId={sessionId}
          path={previewPath}
          onClose={() => setPreviewPath(null)}
        />
      )}
    </div>
  );
}

function isImagePath(path: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif)$/i.test(path);
}

function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

function isTextPath(path: string): boolean {
  return /\.(txt|md|log|json|yaml|yml|csv|html|xml|tsx?|jsx?|css|sh|ya?ml|conf|toml|ini|env|gitignore|sql|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp)$/i.test(
    path,
  );
}

// ─── Attachment preview modal (v0.51.8) ────────────────────────────

function AttachmentPreview({
  sessionId,
  path,
  onClose,
}: {
  sessionId: string;
  path: string;
  onClose: () => void;
}) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [textErr, setTextErr] = useState<string | null>(null);

  // ESC 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 文本类型 → fetch 并展示文本
  useEffect(() => {
    if (!isTextPath(path)) return;
    let aborted = false;
    fetch(attachmentUrl(sessionId, path))
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.text();
      })
      .then((txt) => {
        if (aborted) return;
        // 截断展示，避免巨型文件吃 DOM
        setTextContent(txt.length > 200_000 ? txt.slice(0, 200_000) + '\n\n…(truncated)' : txt);
      })
      .catch((err) => {
        if (aborted) return;
        setTextErr(err instanceof Error ? err.message : String(err));
      });
    return () => {
      aborted = true;
    };
  }, [sessionId, path]);

  const url = attachmentUrl(sessionId, path);
  const name = path.split(/[\\/]/).pop() ?? path;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(45,55,72,0.6)] p-4"
      role="presentation"
    >
      <div
        className="nb-card bg-[var(--color-bg)] max-w-3xl w-full p-5 flex flex-col"
        style={{ maxHeight: '85vh' }}
        role="dialog"
        aria-modal="true"
        aria-label={`预览 ${name}`}
      >
        <header className="flex items-center justify-between mb-3 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Eye size={16} strokeWidth={2.5} className="flex-shrink-0" />
            <h3 className="font-[family-name:var(--font-heading)] font-bold text-base truncate">
              {name}
            </h3>
          </div>
          <button
            type="button"
            className="p-1 hover:bg-[var(--color-bg-cream)] rounded flex-shrink-0"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={16} strokeWidth={3} />
          </button>
        </header>
        <p
          className="text-[10px] text-[var(--color-text-muted)] font-[family-name:var(--font-mono)] truncate mb-2 shrink-0"
          title={path}
          dir="rtl"
        >
          {path}
        </p>
        <div className="flex-1 overflow-auto border-2 border-[var(--color-text)] rounded-lg bg-[var(--color-bg-cream)] min-h-0">
          {isImagePath(path) && (
            <div className="flex items-center justify-center p-4">
              {/* eslint-disable-next-line jsx-a11y/img-redundant-alt */}
              <img
                src={url}
                alt={`Preview: ${name}`}
                className="max-w-full max-h-[60vh] object-contain"
              />
            </div>
          )}
          {isPdfPath(path) && (
            <iframe
              src={url}
              title={`PDF: ${name}`}
              className="w-full"
              style={{ height: '60vh', border: 0 }}
            />
          )}
          {isTextPath(path) && (
            <pre className="p-3 text-xs font-[family-name:var(--font-mono)] whitespace-pre-wrap break-words">
              {textErr ? (
                <span className="text-[var(--color-crashed)]">读取失败: {textErr}</span>
              ) : textContent === null ? (
                <span className="text-[var(--color-text-muted)]">加载中...</span>
              ) : (
                textContent
              )}
            </pre>
          )}
          {!isImagePath(path) && !isPdfPath(path) && !isTextPath(path) && (
            <div className="p-6 text-center text-sm text-[var(--color-text-muted)]">
              <p className="mb-3">此文件类型不支持内联预览。</p>
              <a
                href={url}
                download={name}
                className="nb-btn nb-btn-primary inline-flex"
              >
                下载
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── New session dialog (v0.51.4) ──────────────────────────────────────

function NewSessionDialog({
  onCancel,
  onCreate,
}: {
  onCancel: () => void;
  onCreate: (input: { title?: string; cwd?: string }) => void;
}) {
  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // v0.51.7: ESC 关闭（仅当子 picker 没开）；不再用 backdrop 点击关闭，
  // 避免用户敲到一半误点空白丢失草稿。
  useEffect(() => {
    if (pickerOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, pickerOpen]);

  const submit = async (): Promise<void> => {
    if (submitting) return;
    setSubmitting(true);
    try {
      onCreate({ title: title.trim() || undefined, cwd: cwd.trim() || undefined });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(45,55,72,0.4)] p-4"
      role="presentation"
    >
      <div
        className="nb-card bg-[var(--color-bg)] max-w-md w-full p-5"
        role="dialog"
        aria-modal="true"
        aria-label="新建对话"
      >
        <header className="flex items-center justify-between mb-4">
          <h2 className="font-[family-name:var(--font-heading)] font-bold text-lg">
            新建对话
          </h2>
          <button
            type="button"
            className="p-1 hover:bg-[var(--color-bg-cream)] rounded"
            onClick={onCancel}
            aria-label="关闭"
          >
            <X size={16} strokeWidth={3} />
          </button>
        </header>

        <div className="flex flex-col gap-4">
          <div>
            <label
              htmlFor="new-session-title"
              className="block text-xs font-bold mb-1.5 uppercase tracking-wider"
            >
              标题（可选）
            </label>
            <input
              id="new-session-title"
              type="text"
              className="nb-input w-full"
              placeholder="留空 = 自动用首条消息生成"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div>
            <label
              htmlFor="new-session-cwd"
              className="block text-xs font-bold mb-1.5 uppercase tracking-wider"
            >
              工作目录（可选）
            </label>
            <div className="flex gap-2">
              <input
                id="new-session-cwd"
                type="text"
                className="nb-input flex-1 font-[family-name:var(--font-mono)] text-sm"
                placeholder="/home/coral/projects/my-app"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
              />
              <button
                type="button"
                className="nb-btn flex-shrink-0"
                onClick={() => setPickerOpen(true)}
                aria-label="浏览选择目录"
                title="浏览选择目录"
              >
                <FolderOpen size={14} strokeWidth={2.5} />
                浏览
              </button>
            </div>
            <p className="text-[11px] text-[var(--color-text-muted)] mt-1.5 leading-relaxed">
              <Folder size={10} strokeWidth={2.5} className="inline mr-1 -mt-0.5" />
              Agent 在该目录下读写文件。绝对路径，必须存在。
              留空则用 daemon 启动时的目录。
            </p>
          </div>

          <div className="flex gap-2 justify-end pt-2">
            <button type="button" className="nb-btn" onClick={onCancel}>
              取消
            </button>
            <button
              type="button"
              className="nb-btn nb-btn-primary"
              onClick={submit}
              disabled={submitting}
            >
              {submitting ? (
                <Loader2 size={14} strokeWidth={3} className="animate-spin" />
              ) : (
                <Plus size={14} strokeWidth={3} />
              )}
              创建
            </button>
          </div>
        </div>
      </div>

      {pickerOpen && (
        <DirectoryPicker
          initialPath={cwd.trim() || undefined}
          onCancel={() => setPickerOpen(false)}
          onSelect={(picked) => {
            setCwd(picked);
            setPickerOpen(false);
          }}
        />
      )}
    </div>
  );
}

function MessageBubble({
  msg,
  sessionId,
  onPreviewAttachment,
}: {
  msg: ChatMessage;
  sessionId: string | null;
  onPreviewAttachment: (path: string) => void;
}) {
  const isUser = msg.role === 'user';
  const isError = msg.role === 'error';
  const blocks: ChatMessageBlock[] =
    msg.blocks && msg.blocks.length > 0
      ? msg.blocks
      : [{ type: 'text', text: msg.content }];
  const attachments = msg.attachments ?? [];
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
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-2 flex items-center gap-2">
          {isUser ? '你' : isError ? '错误' : 'assistant'}
          <span className="font-normal">·</span>
          <span className="font-normal">{formatTimeAgo(msg.ts)}</span>
        </p>
        <div className="flex flex-col gap-2">
          {blocks.map((b, i) => (
            <BlockRenderer key={i} block={b} />
          ))}
        </div>
        {/* v0.51.8: 附件展示（缩略图 / chip） */}
        {attachments.length > 0 && sessionId && (
          <div className="mt-3 pt-3 border-t-2 border-dashed border-[var(--color-text)]/30 flex flex-wrap gap-2">
            {attachments.map((p) => (
              <AttachmentThumb
                key={p}
                sessionId={sessionId}
                path={p}
                onPreview={() => onPreviewAttachment(p)}
              />
            ))}
          </div>
        )}
        {msg.truncated && (
          <p className="mt-3 px-3 py-2 bg-[var(--color-stuck-bg)] border-2 border-[var(--color-stuck)] rounded-lg text-xs text-[var(--color-stuck)] font-bold">
            ⚠ 输出超过 10MB，已截断
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * 消息气泡内的附件展示：
 *   - 图片：缩略图（点击放大预览）
 *   - 其它：chip + icon
 */
function AttachmentThumb({
  sessionId,
  path,
  onPreview,
}: {
  sessionId: string;
  path: string;
  onPreview: () => void;
}) {
  const name = path.split(/[\\/]/).pop() ?? path;
  if (isImagePath(path)) {
    return (
      <button
        type="button"
        onClick={onPreview}
        className="block rounded-md overflow-hidden border-2 border-[var(--color-text)] hover:shadow-[2px_2px_0_var(--color-text)] transition-shadow"
        title={`${name}\n点击放大`}
      >
        <img
          src={attachmentUrl(sessionId, path)}
          alt={name}
          className="block max-h-40 max-w-[12rem] object-cover"
          loading="lazy"
        />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onPreview}
      className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-[var(--color-bg)] border-2 border-[var(--color-text)] text-xs font-[family-name:var(--font-mono)] hover:bg-[var(--color-accent-mint)]"
      title={`${name}\n${path}\n点击预览`}
    >
      <FileText size={11} strokeWidth={2.5} className="flex-shrink-0" />
      <span className="truncate max-w-[200px]">{name}</span>
    </button>
  );
}

function StreamingBubble({
  pending,
}: {
  pending: {
    id: string;
    blocks: Array<
      | { type: 'text'; target: string; displayed: string }
      | { type: 'tool_use'; id: string; title: string; kind: string; status: string }
    >;
  };
}) {
  const lastTextIdx = (() => {
    for (let i = pending.blocks.length - 1; i >= 0; i--) {
      if (pending.blocks[i]!.type === 'text') return i;
    }
    return -1;
  })();
  return (
    <div className="self-start max-w-3xl">
      <div className="nb-card bg-[var(--color-bg)]">
        <p className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-2 flex items-center gap-2">
          assistant
          <span className="font-normal">·</span>
          <span className="flex items-center gap-1 font-normal text-[var(--color-running)]">
            <Loader2 size={10} strokeWidth={3} className="animate-spin" />
            streaming
          </span>
        </p>
        <div className="flex flex-col gap-2">
          {pending.blocks.length === 0 && (
            <p className="text-sm text-[var(--color-text-muted)] italic">…</p>
          )}
          {pending.blocks.map((b, i) => {
            if (b.type === 'text') {
              const isLast = i === lastTextIdx;
              return (
                <div key={i} className="relative">
                  <TextBlock text={b.displayed} />
                  {isLast && (
                    <span className="inline-block w-2 h-4 ml-1 bg-[var(--color-text)] animate-pulse align-middle" />
                  )}
                </div>
              );
            }
            return <ToolBlock key={i} tool={b} />;
          })}
        </div>
      </div>
    </div>
  );
}

function BlockRenderer({ block }: { block: ChatMessageBlock }) {
  if (block.type === 'text') return <TextBlock text={block.text} />;
  return <ToolBlock tool={block} />;
}

function TextBlock({ text }: { text: string }) {
  if (!text) return null;
  return (
    <div className="text-sm font-[family-name:var(--font-body)] break-words prose-chat">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function ToolBlock({
  tool,
}: {
  tool: { id: string; title: string; kind: string; status: string };
}) {
  const [open, setOpen] = useState(false);
  const done = tool.status === 'completed';
  const failed = tool.status === 'failed';
  const active = !done && !failed;
  return (
    <div className="border-2 border-[var(--color-text)] rounded-lg overflow-hidden bg-[var(--color-bg-cream)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-xs font-[family-name:var(--font-mono)] hover:bg-[var(--color-accent-yellow)] transition-colors"
      >
        <ChevronRight
          size={12}
          strokeWidth={3}
          className={['transition-transform', open ? 'rotate-90' : ''].join(' ')}
        />
        <Wrench size={12} strokeWidth={2.5} />
        <span className="font-bold">{tool.kind}</span>
        <span className="flex-1 text-left text-[var(--color-text-muted)] truncate">
          {tool.title}
        </span>
        {active && (
          <Loader2 size={12} strokeWidth={3} className="animate-spin text-[var(--color-running)]" />
        )}
        {done && <CheckCircle2 size={12} strokeWidth={2.5} className="text-[var(--color-running)]" />}
        {failed && <XCircle size={12} strokeWidth={2.5} className="text-[var(--color-crashed)]" />}
      </button>
      {open && (
        <div className="px-3 py-2 text-xs font-[family-name:var(--font-mono)] text-[var(--color-text-muted)] border-t-2 border-[var(--color-text)]">
          <div>id: <span className="text-[var(--color-text)]">{tool.id}</span></div>
          <div>status: <span className="text-[var(--color-text)]">{tool.status}</span></div>
        </div>
      )}
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
