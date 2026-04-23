import type { Card as CardT } from '../../shared/api/cards';
import { SkillBadge, LabelBadge } from '../../shared/components/Badges';

export function KanbanCard({
  card,
  onClick,
  done,
  draggable,
}: {
  card: CardT;
  onClick: () => void;
  done?: boolean;
  draggable?: boolean;
}) {
  const running = card.labels.some((l) => l.startsWith('STARTED-')) && !done;
  return (
    <article
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-sps-card-seq', String(card.seq));
        e.dataTransfer.effectAllowed = 'move';
      }}
      tabIndex={0}
      role="button"
      aria-label={`Card #${card.seq}: ${card.title}`}
      className={[
        'bg-[var(--color-bg)] border-[3px] border-[var(--color-text)] rounded-xl p-3',
        'shadow-[3px_3px_0_var(--color-text)] cursor-pointer',
        'transition-[transform,box-shadow] duration-[180ms] ease-out',
        'hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[5px_5px_0_var(--color-text)]',
        'focus:outline-none focus-visible:ring-[3px] focus-visible:ring-offset-2 focus-visible:ring-[var(--color-text)]',
        done ? 'opacity-60' : '',
        draggable ? 'active:cursor-grabbing' : '',
      ].join(' ')}
    >
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="font-[family-name:var(--font-mono)] font-bold text-[11px] px-2 py-0.5 bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded-full">
          #{card.seq}
        </span>
        {running && (
          <span className="nb-status" style={{ background: 'var(--color-running-bg)', color: 'var(--color-running)' }}>
            running
          </span>
        )}
      </div>
      <p className={`font-bold text-sm leading-5 mb-2 line-clamp-2 ${done ? 'line-through decoration-2' : ''}`}>
        {card.title}
      </p>
      {(card.skills.length > 0 || card.labels.length > 0) && (
        <div className="flex flex-wrap gap-1 mb-2">
          {card.skills.slice(0, 3).map((s) => (
            <SkillBadge key={s} name={s} />
          ))}
          {card.labels.filter((l) => l === 'NEEDS-FIX').map((l) => (
            <LabelBadge key={l} label={l} kind="warn" />
          ))}
        </div>
      )}
      {card.checklist && card.checklist.total > 0 && (
        <ChecklistPreview stats={card.checklist} />
      )}
      <div className="pt-2 border-t-[1.5px] border-dashed border-[var(--color-border-light)] flex items-center gap-2 text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-subtle)]">
        <span>{formatTimeAgo(card.updatedAt ?? card.createdAt)}</span>
        {card.branch && <span className="truncate">· {card.branch}</span>}
      </div>
    </article>
  );
}

/**
 * 检查清单只读预览 —— 卡片上展示进度 + 前 3 条 item（其余省略）。
 * 由 worker 写入 md 文件的 `## 检查清单` section；UI 不可编辑。
 */
function ChecklistPreview({
  stats,
}: {
  stats: { total: number; done: number; percent: number; items: { text: string; done: boolean }[] };
}) {
  return (
    <div className="mb-2">
      <div className="flex items-center justify-between text-[11px] font-[family-name:var(--font-mono)] mb-1">
        <span className="font-bold">
          检查清单 {stats.done}/{stats.total}
        </span>
        <span className="text-[var(--color-text-subtle)]">{stats.percent}%</span>
      </div>
      <div className="w-full h-1.5 bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded-full overflow-hidden mb-1.5">
        <div
          className="h-full bg-[var(--color-cta)] transition-[width] duration-200"
          style={{ width: `${stats.percent}%` }}
        />
      </div>
      <ul className="text-[11px] space-y-0.5">
        {stats.items.slice(0, 3).map((item, i) => (
          <li
            key={i}
            className={`flex items-start gap-1 ${item.done ? 'opacity-60 line-through' : ''}`}
          >
            <span className="flex-shrink-0 mt-0.5">{item.done ? '✓' : '○'}</span>
            <span className="line-clamp-1">{item.text}</span>
          </li>
        ))}
        {stats.items.length > 3 && (
          <li className="text-[var(--color-text-subtle)] italic pl-3">
            … 还有 {stats.items.length - 3} 条
          </li>
        )}
      </ul>
    </div>
  );
}

function formatTimeAgo(ts: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return '刚才';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}
