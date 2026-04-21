import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { X, Play, RotateCcw, GitBranch } from 'lucide-react';
import { getCard, launchCard, resetCard } from '../../shared/api/cards';
import { SkillBadge, LabelBadge } from '../../shared/components/Badges';

export function CardDetailModal({
  project,
  seq,
  onClose,
  onChanged,
}: {
  project: string;
  seq: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['card', project, seq],
    queryFn: () => getCard(project, seq),
  });

  // 支持 Escape 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="card-modal-title"
      className="fixed inset-0 z-40 flex items-start justify-center p-6 bg-black/30 overflow-auto"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="nb-card mt-12 w-full max-w-3xl bg-[var(--color-bg)]"
      >
        <header className="flex items-start justify-between gap-4 mb-4">
          <div>
            <div className="flex items-center gap-3 mb-1">
              <span className="font-[family-name:var(--font-mono)] font-bold text-xs px-2 py-0.5 bg-[var(--color-accent-purple)] border-2 border-[var(--color-text)] rounded-full">
                #{seq}
              </span>
              {data?.state && (
                <span className="font-[family-name:var(--font-mono)] text-xs px-2 py-0.5 bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded-full font-semibold">
                  {data.state}
                </span>
              )}
            </div>
            <h2 id="card-modal-title" className="font-[family-name:var(--font-heading)] text-2xl font-bold">
              {data?.title ?? '加载中…'}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="nb-btn nb-btn-mint p-2"
            aria-label="关闭"
            type="button"
          >
            <X size={16} strokeWidth={3} />
          </button>
        </header>

        {isLoading && <p className="text-[var(--color-text-muted)]">加载中…</p>}
        {isError && (
          <p className="text-[var(--color-crashed)]">
            加载失败: {error instanceof Error ? error.message : String(error)}
          </p>
        )}

        {data && (
          <div className="flex flex-col gap-4">
            {data.branch && (
              <div className="flex items-center gap-2 text-sm">
                <GitBranch size={14} />
                <span className="font-[family-name:var(--font-mono)]">{data.branch}</span>
              </div>
            )}

            {(data.skills.length > 0 || data.labels.length > 0) && (
              <div className="flex items-center gap-2 flex-wrap">
                {data.skills.map((s) => <SkillBadge key={s} name={s} />)}
                {data.labels.map((l) => (
                  <LabelBadge key={l} label={l} kind={l === 'NEEDS-FIX' ? 'warn' : 'default'} />
                ))}
              </div>
            )}

            {data.checklist.total > 0 && (
              <div className="nb-card bg-[var(--color-bg-cream)] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold text-sm">
                    检查清单 {data.checklist.done}/{data.checklist.total}
                  </span>
                  <div className="w-24 h-2 bg-[var(--color-bg)] border-2 border-[var(--color-text)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[var(--color-cta)]"
                      style={{ width: `${data.checklist.percent}%` }}
                    />
                  </div>
                </div>
                <ul className="text-sm space-y-1">
                  {data.checklist.items.map((item, i) => (
                    <li key={i} className={`flex items-start gap-2 ${item.done ? 'opacity-60 line-through' : ''}`}>
                      <span>{item.done ? '✓' : '○'}</span>
                      <span>{item.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {data.body && (
              <div>
                <h3 className="font-[family-name:var(--font-heading)] text-sm font-bold mb-2 uppercase tracking-wider">
                  正文
                </h3>
                <pre className="text-xs whitespace-pre-wrap font-[family-name:var(--font-mono)] bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded-lg p-4 max-h-64 overflow-auto">
                  {data.body.trim() || '（空）'}
                </pre>
              </div>
            )}

            <div className="flex gap-3 pt-2 border-t-2 border-[var(--color-border-light)]">
              <button
                className="nb-btn nb-btn-primary"
                type="button"
                onClick={async () => {
                  await launchCard(project, seq);
                  onChanged();
                }}
              >
                <Play size={14} strokeWidth={3} />
                启动 worker
              </button>
              <button
                className="nb-btn nb-btn-yellow"
                type="button"
                onClick={async () => {
                  if (!window.confirm(`重置卡片 #${seq}？`)) return;
                  await resetCard(project, seq);
                  onChanged();
                  onClose();
                }}
              >
                <RotateCcw size={14} strokeWidth={2.5} />
                重置卡片
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
