import type { Card as CardT } from '../../shared/api/cards';
import { SkillBadge, LabelBadge } from '../../shared/components/Badges';

export function KanbanCard({
  card,
  onClick,
  done,
}: {
  card: CardT;
  onClick: () => void;
  done?: boolean;
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
      <div className="pt-2 border-t-[1.5px] border-dashed border-[var(--color-border-light)] flex items-center gap-2 text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-subtle)]">
        <span>{formatTimeAgo(card.updatedAt ?? card.createdAt)}</span>
        {card.branch && <span className="truncate">· {card.branch}</span>}
      </div>
    </article>
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
