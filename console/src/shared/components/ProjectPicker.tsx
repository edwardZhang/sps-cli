import { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { listProjects } from '../api/projects';

export function ProjectPicker({
  current,
  onChange,
}: {
  current: string;
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useQuery({ queryKey: ['projects'], queryFn: listProjects });

  useEffect(() => {
    const onDoc = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="inline-flex items-center gap-2 px-3 py-2 bg-[var(--color-bg)] border-[3px] border-[var(--color-text)] rounded-xl shadow-[3px_3px_0_var(--color-text)] font-[family-name:var(--font-mono)] text-sm font-bold hover:-translate-x-px hover:-translate-y-px hover:shadow-[4px_4px_0_var(--color-text)] transition-[transform,box-shadow] duration-150"
        onClick={() => setOpen((v) => !v)}
      >
        {current}
        <ChevronDown size={14} strokeWidth={2.5} />
      </button>
      {open && data && (
        <div className="absolute right-0 mt-2 z-20 min-w-[200px] bg-[var(--color-bg)] border-[3px] border-[var(--color-text)] rounded-xl shadow-[5px_5px_0_var(--color-text)] overflow-hidden">
          {data.data.map((p) => (
            <button
              key={p.name}
              type="button"
              onClick={() => {
                onChange(p.name);
                setOpen(false);
              }}
              className={[
                'w-full text-left px-4 py-2 text-sm font-semibold',
                p.name === current
                  ? 'bg-[var(--color-accent-mint)]'
                  : 'hover:bg-[var(--color-bg-cream)]',
              ].join(' ')}
            >
              <span className="font-[family-name:var(--font-mono)]">{p.name}</span>
              <span className="ml-2 text-xs text-[var(--color-text-muted)]">
                {p.cards.total} cards
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
