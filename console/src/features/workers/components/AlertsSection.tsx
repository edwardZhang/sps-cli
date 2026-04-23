/**
 * @module        features/workers/components/AlertsSection
 * @description   stuck / crashed worker 置顶展示
 */
import { AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import type { AggregateWorker } from '../../../shared/api/workers';
import { StateBadge } from './shared/StateBadge';
import { formatRelative, formatRuntime } from './shared/formatters';

interface Props {
  alerts: AggregateWorker[];
  selected: { project: string; slot?: number } | null;
  onSelect: (project: string, slot: number) => void;
}

export function AlertsSection({ alerts, selected, onSelect }: Props) {
  if (alerts.length === 0) {
    return (
      <div className="nb-card bg-[var(--color-running-bg)] flex items-center gap-3">
        <CheckCircle2 size={18} strokeWidth={2.5} className="text-[var(--color-running)]" />
        <span className="text-sm font-bold text-[var(--color-running)]">全部 worker 健康</span>
      </div>
    );
  }
  return (
    <section>
      <h2 className="font-[family-name:var(--font-heading)] text-sm font-bold uppercase tracking-wider mb-2 flex items-center gap-2 text-[var(--color-crashed)]">
        <AlertTriangle size={14} strokeWidth={2.5} />
        Alerts ({alerts.length})
      </h2>
      <div className="flex flex-col gap-2">
        {alerts.map((w) => {
          const isSel = selected?.project === w.project && selected?.slot === w.slot;
          return (
            <button
              key={`${w.project}-${w.slot}`}
              type="button"
              onClick={() => onSelect(w.project, w.slot)}
              className={[
                'nb-card p-3 text-left',
                w.state === 'crashed' ? 'bg-[var(--color-crashed-bg)]' : 'bg-[var(--color-stuck-bg)]',
                isSel ? 'ring-4 ring-[var(--color-text)]' : '',
              ].join(' ')}
            >
              <div className="flex items-center gap-2 text-sm">
                <StateBadge state={w.state} />
                <span className="font-[family-name:var(--font-mono)] font-bold">
                  {w.project}/worker-{w.slot}
                </span>
                {w.card && (
                  <span className="truncate">
                    #{w.card.seq} {w.card.title}
                  </span>
                )}
                <span className="ml-auto text-xs text-[var(--color-text-muted)] font-[family-name:var(--font-mono)] flex items-center gap-1">
                  <Clock size={10} strokeWidth={2.5} />
                  {formatRuntime(w.runtimeMs)}
                </span>
              </div>
              {w.markerUpdatedAt && (
                <div className="text-xs text-[var(--color-text-muted)] mt-1 font-[family-name:var(--font-mono)]">
                  {w.state === 'crashed'
                    ? 'PID 已死。'
                    : `marker 停 ${formatRelative(w.markerUpdatedAt)}。`}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
