import { useState } from 'react';
import type { Card as CardT } from '../../shared/api/cards';
import { KanbanCard } from './KanbanCard';

export function KanbanColumn({
  label,
  bg,
  cards,
  onCardClick,
  onDropCard,
}: {
  label: string;
  bg: string;
  cards: CardT[];
  onCardClick: (card: CardT) => void;
  /** 拖进来的卡片：seq + 目标 state（由 column 决定）。不传则不开启拖放。 */
  onDropCard?: (seq: number) => void;
}) {
  const [isDragOver, setIsDragOver] = useState(false);

  return (
    <div
      className={[
        'flex flex-col p-3 rounded-2xl border-[3px] min-h-[280px] h-full min-h-0 overflow-hidden',
        'transition-all',
        isDragOver
          ? 'border-[var(--color-cta)] shadow-[4px_4px_0_var(--color-cta)]'
          : 'border-[var(--color-text)]',
      ].join(' ')}
      style={{ background: bg }}
      onDragOver={(e) => {
        if (!onDropCard) return;
        const hasCard = e.dataTransfer.types.includes('application/x-sps-card-seq');
        if (!hasCard) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!isDragOver) setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        setIsDragOver(false);
        if (!onDropCard) return;
        const raw = e.dataTransfer.getData('application/x-sps-card-seq');
        const seq = Number.parseInt(raw, 10);
        if (Number.isFinite(seq)) {
          e.preventDefault();
          onDropCard(seq);
        }
      }}
    >
      <div className="flex items-center justify-between px-1 pb-2 mb-2 border-b-2 border-[var(--color-text)] shrink-0">
        <span className="font-[family-name:var(--font-heading)] font-bold text-sm uppercase tracking-wider">
          {label}
        </span>
        <span className="font-[family-name:var(--font-mono)] font-bold text-xs px-2 py-0.5 bg-[var(--color-bg)] border-2 border-[var(--color-text)] rounded-full">
          {cards.length}
        </span>
      </div>
      <div
        className="flex flex-col gap-2 flex-1 min-h-0 overflow-y-auto pr-1 -mr-1"
        // 滚动条样式：Pastel Neubrutalism — 浅 track + 深拇指
        style={{ scrollbarWidth: 'thin', scrollbarColor: 'var(--color-text) transparent' }}
      >
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
            draggable={!!onDropCard}
          />
        ))}
      </div>
    </div>
  );
}
