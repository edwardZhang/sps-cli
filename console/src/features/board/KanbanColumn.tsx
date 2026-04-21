import type { Card as CardT } from '../../shared/api/cards';
import { KanbanCard } from './KanbanCard';

export function KanbanColumn({
  label,
  bg,
  cards,
  onCardClick,
}: {
  label: string;
  bg: string;
  cards: CardT[];
  onCardClick: (card: CardT) => void;
}) {
  return (
    <div
      className="flex flex-col gap-2 p-3 rounded-2xl border-[3px] border-[var(--color-text)] min-h-[340px]"
      style={{ background: bg }}
    >
      <div className="flex items-center justify-between px-1 pb-2 border-b-2 border-[var(--color-text)]">
        <span className="font-[family-name:var(--font-heading)] font-bold text-sm uppercase tracking-wider">
          {label}
        </span>
        <span className="font-[family-name:var(--font-mono)] font-bold text-xs px-2 py-0.5 bg-[var(--color-bg)] border-2 border-[var(--color-text)] rounded-full">
          {cards.length}
        </span>
      </div>
      <div className="flex flex-col gap-2">
        {cards.length === 0 && (
          <div className="text-xs text-[var(--color-text-muted)] text-center py-6 italic">
            — 空 —
          </div>
        )}
        {cards.map((card) => (
          <KanbanCard
            key={card.seq}
            card={card}
            onClick={() => onCardClick(card)}
            done={label === 'Done'}
          />
        ))}
      </div>
    </div>
  );
}
