/**
 * @module        features/workers/components/CapacitySection
 * @description   项目级 slot 占用总览表
 */
import { useTranslation } from 'react-i18next';
import type { ProjectCapacity } from '../../../shared/api/workers';

interface Props {
  capacity: ProjectCapacity[];
  selected: { project: string; slot?: number } | null;
  onSelect: (project: string) => void;
}

export function CapacitySection({ capacity, selected, onSelect }: Props) {
  const { t } = useTranslation('workers');
  if (capacity.length === 0) {
    return null;
  }
  return (
    <section>
      <h2 className="font-[family-name:var(--font-heading)] text-sm font-bold uppercase tracking-wider mb-2">
        {t('capacity.title')}
      </h2>
      <div className="nb-card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--color-bg-cream)] border-b-2 border-[var(--color-text)]">
              <th className="px-3 py-2 text-left font-bold text-xs uppercase tracking-wider">{t('capacity.project')}</th>
              <th className="px-3 py-2 text-left font-bold text-xs uppercase tracking-wider">{t('capacity.inUse')}</th>
              <th className="px-3 py-2 text-right font-bold text-xs uppercase tracking-wider">running</th>
              <th className="px-3 py-2 text-right font-bold text-xs uppercase tracking-wider">{t('capacity.other')}</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {capacity.map((c) => {
              const busy = c.running + c.starting + c.stuck + c.crashed;
              const isSel = selected?.project === c.project;
              return (
                <tr
                  key={c.project}
                  onClick={() => onSelect(c.project)}
                  className={[
                    'border-b border-dashed border-[var(--color-border-light)] last:border-0 cursor-pointer hover:bg-[var(--color-accent-yellow)]',
                    isSel ? 'bg-[var(--color-accent-yellow)]' : '',
                  ].join(' ')}
                >
                  <td className="px-3 py-2 font-[family-name:var(--font-mono)] font-bold">
                    {c.project}
                  </td>
                  <td className="px-3 py-2">
                    <SlotDots total={c.total} cap={c} />
                  </td>
                  <td className="px-3 py-2 text-right font-[family-name:var(--font-mono)]">
                    <span className="text-[var(--color-running)] font-bold">{c.running}</span>
                    <span className="text-[var(--color-text-muted)]">/{c.total}</span>
                  </td>
                  <td className="px-3 py-2 text-right text-xs font-[family-name:var(--font-mono)] text-[var(--color-text-muted)]">
                    {c.starting > 0 && <span className="mr-2">starting {c.starting}</span>}
                    {c.stuck > 0 && (
                      <span className="text-[var(--color-stuck)] font-bold mr-2">stuck {c.stuck}</span>
                    )}
                    {c.crashed > 0 && (
                      <span className="text-[var(--color-crashed)] font-bold mr-2">
                        crashed {c.crashed}
                      </span>
                    )}
                    {busy === 0 && <span>idle</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="text-xs text-[var(--color-text-muted)]">{t('capacity.details')}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SlotDots({ total, cap }: { total: number; cap: ProjectCapacity }) {
  const dots: string[] = [];
  for (let i = 0; i < cap.crashed; i++) dots.push('crashed');
  for (let i = 0; i < cap.stuck; i++) dots.push('stuck');
  for (let i = 0; i < cap.starting; i++) dots.push('starting');
  for (let i = 0; i < cap.running; i++) dots.push('running');
  for (let i = 0; i < cap.idle; i++) dots.push('idle');
  return (
    <div className="flex gap-1 items-center">
      {dots.map((s, i) => (
        <span
          key={i}
          className="inline-block w-3 h-3 rounded-full border-2 border-[var(--color-text)]"
          style={{ background: dotColor(s) }}
          title={s}
        />
      ))}
      <span className="text-xs text-[var(--color-text-muted)] ml-2 font-[family-name:var(--font-mono)]">
        {total} slot{total !== 1 ? 's' : ''}
      </span>
    </div>
  );
}

function dotColor(s: string): string {
  switch (s) {
    case 'running':
      return 'var(--color-running-bg)';
    case 'starting':
      return 'var(--color-secondary)';
    case 'stuck':
      return 'var(--color-stuck-bg)';
    case 'crashed':
      return 'var(--color-crashed-bg)';
    default:
      return 'var(--color-idle-bg)';
  }
}
