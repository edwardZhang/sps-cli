/**
 * Reusable directory picker modal.
 *
 * 浏览器 native picker 拿不到绝对路径（同源限制），所以走 console-server 的
 * /api/fs/browse 端点（仅监听 127.0.0.1，本机用户调用）。
 *
 * v0.51.5 起从 ChatPage 抽出，供 chat / project / 其他 cwd 选择场景复用。
 */
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  Folder,
  Home,
  Loader2,
  X,
} from 'lucide-react';
import { browseDirectory } from '../api/fs';

export function DirectoryPicker({
  initialPath,
  onCancel,
  onSelect,
  title = '选择目录',
}: {
  initialPath?: string;
  onCancel: () => void;
  onSelect: (path: string) => void;
  title?: string;
}) {
  const [path, setPath] = useState<string | null>(initialPath ?? null);

  const browseQ = useQuery({
    queryKey: ['fs-browse', path],
    queryFn: () => browseDirectory(path ?? undefined),
    // 不缓存 — 文件系统会变；每次开 picker 都拉新
    staleTime: 0,
    gcTime: 0,
  });

  // 初次进入用 server 返回的 home（没指定 path 时）
  const currentPath = browseQ.data?.path ?? path ?? '';
  const parent = browseQ.data?.parent ?? null;
  const home = browseQ.data?.home ?? null;

  // v0.51.7: ESC 关闭；不再 backdrop 点击关闭，避免误点丢失浏览状态。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(45,55,72,0.5)] p-4"
      role="presentation"
    >
      <div
        className="nb-card bg-[var(--color-bg)] max-w-lg w-full p-5 flex flex-col"
        style={{ maxHeight: '70vh' }}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <header className="flex items-center justify-between mb-3 shrink-0">
          <h3 className="font-[family-name:var(--font-heading)] font-bold text-base">
            {title}
          </h3>
          <button
            type="button"
            className="p-1 hover:bg-[var(--color-bg-cream)] rounded"
            onClick={onCancel}
            aria-label="关闭"
          >
            <X size={14} strokeWidth={3} />
          </button>
        </header>

        {/* 当前路径 + 导航按钮 */}
        <div className="flex items-center gap-2 mb-3 shrink-0">
          <button
            type="button"
            className="nb-btn flex-shrink-0"
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={() => parent && setPath(parent)}
            disabled={!parent || browseQ.isLoading}
            aria-label="上级目录"
            title="上级目录"
          >
            <ArrowUp size={12} strokeWidth={3} />
          </button>
          <button
            type="button"
            className="nb-btn flex-shrink-0"
            style={{ padding: '4px 10px', fontSize: 12 }}
            onClick={() => home && setPath(home)}
            disabled={!home || browseQ.isLoading}
            aria-label="回到 Home"
            title="回到 Home"
          >
            <Home size={12} strokeWidth={3} />
          </button>
          <div
            className="flex-1 min-w-0 nb-input font-[family-name:var(--font-mono)] text-xs px-2 py-1.5 truncate"
            title={currentPath}
            dir="rtl"
          >
            {currentPath || '...'}
          </div>
        </div>

        {/* 条目列表 */}
        <div className="flex-1 overflow-y-auto border-2 border-[var(--color-text)] rounded-lg bg-[var(--color-bg-cream)] min-h-0">
          {browseQ.isLoading && (
            <div className="flex items-center justify-center py-12 text-[var(--color-text-muted)]">
              <Loader2 size={16} strokeWidth={3} className="animate-spin mr-2" />
              加载中...
            </div>
          )}
          {browseQ.isError && (
            <div className="p-4 text-sm text-[var(--color-crashed)]">
              <p className="font-bold mb-1">读取失败</p>
              <p className="text-xs font-[family-name:var(--font-mono)] break-all">
                {browseQ.error instanceof Error ? browseQ.error.message : String(browseQ.error)}
              </p>
            </div>
          )}
          {browseQ.data && (
            <ul className="divide-y-2 divide-[var(--color-text)]/20">
              {browseQ.data.entries.length === 0 && (
                <li className="p-4 text-xs text-[var(--color-text-subtle)] italic text-center">
                  — 空目录 —
                </li>
              )}
              {browseQ.data.entries.map((entry) => (
                <li key={entry.name}>
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm hover:bg-[var(--color-accent-mint)] disabled:opacity-50 disabled:cursor-not-allowed font-[family-name:var(--font-mono)]"
                    disabled={!entry.isDirectory}
                    onClick={() => {
                      if (!entry.isDirectory) return;
                      const sep =
                        currentPath.endsWith('/') || currentPath.endsWith('\\') ? '' : '/';
                      setPath(`${currentPath}${sep}${entry.name}`);
                    }}
                    title={entry.isDirectory ? `进入 ${entry.name}/` : '文件不可选'}
                  >
                    {entry.isDirectory ? (
                      <Folder
                        size={14}
                        strokeWidth={2.5}
                        className="flex-shrink-0 text-[var(--color-text)]"
                      />
                    ) : (
                      <span className="w-3.5 h-3.5 flex-shrink-0" />
                    )}
                    <span className="truncate">{entry.name}</span>
                    {entry.isDirectory && (
                      <ChevronRight
                        size={12}
                        strokeWidth={2.5}
                        className="ml-auto flex-shrink-0 text-[var(--color-text-muted)]"
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex gap-2 justify-end pt-3 shrink-0">
          <button type="button" className="nb-btn" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="nb-btn nb-btn-primary"
            onClick={() => onSelect(currentPath)}
            disabled={!currentPath || browseQ.isLoading || browseQ.isError}
          >
            <CheckCircle2 size={14} strokeWidth={3} />
            选此目录
          </button>
        </div>
      </div>
    </div>
  );
}
