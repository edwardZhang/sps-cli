/**
 * @module        features/workers/components/ActiveSection
 * @description   running / starting 的 worker 卡片展示
 */
import { Activity, Terminal } from 'lucide-react';
import type { AggregateWorker } from '../../../shared/api/workers';
import { StateBadge } from './shared/StateBadge';
import { formatRelative, formatRuntime, runtimeColor } from './shared/formatters';

interface Props {
  active: AggregateWorker[];
  selected: { project: string; slot?: number } | null;
  onSelect: (project: string, slot: number) => void;
}

export function ActiveSection({ active, selected, onSelect }: Props) {
  if (active.length === 0) {
    return (
      <div className="nb-card bg-[var(--color-bg-cream)]">
        <p className="text-sm text-[var(--color-text-muted)] italic">没有 worker 在运行。</p>
      </div>
    );
  }
  return (
    <section>
      <h2 className="font-[family-name:var(--font-heading)] text-sm font-bold uppercase tracking-wider mb-2 flex items-center gap-2">
        <Activity size={14} strokeWidth={2.5} />
        Active ({active.length})
      </h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {active.map((w) => {
          const isSel = selected?.project === w.project && selected?.slot === w.slot;
          return (
            <button
              key={`${w.project}-${w.slot}`}
              type="button"
              onClick={() => onSelect(w.project, w.slot)}
              className={[
                'nb-card p-3 text-left',
                w.state === 'starting' ? 'bg-[var(--color-secondary)]' : 'bg-[var(--color-running-bg)]',
                isSel ? 'ring-4 ring-[var(--color-text)]' : '',
              ].join(' ')}
            >
              <div className="flex items-center gap-2 mb-1">
                <StateBadge state={w.state} />
                <span className="font-[family-name:var(--font-mono)] font-bold text-sm flex-1 truncate">
                  {w.project}/worker-{w.slot}
                </span>
                <span
                  className={`text-xs font-[family-name:var(--font-mono)] ${runtimeColor(w.runtimeMs)}`}
                >
                  {formatRuntime(w.runtimeMs)}
                </span>
              </div>
              {w.card && (
                <div className="text-sm font-semibold mb-1 truncate">
                  #{w.card.seq} · {w.card.title}
                </div>
              )}
              <div className="text-xs text-[var(--color-text-muted)] font-[family-name:var(--font-mono)] flex items-center gap-2 mb-1">
                {w.stage && <span>stage: {w.stage}</span>}
                {w.markerUpdatedAt && (
                  <span className="ml-auto">marker {formatRelative(w.markerUpdatedAt)}</span>
                )}
              </div>
              {w.lastLogLine && (
                <div className="text-[11px] font-[family-name:var(--font-mono)] text-[var(--color-text-muted)] bg-[var(--color-bg)] border-2 border-[var(--color-text)] rounded px-2 py-1 mt-2 truncate">
                  <Terminal
                    size={9}
                    strokeWidth={2.5}
                    className="inline-block mr-1 align-text-bottom"
                  />
                  {w.lastLogLine.msg}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
