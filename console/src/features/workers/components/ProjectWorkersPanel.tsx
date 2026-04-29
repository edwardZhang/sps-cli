/**
 * @module        features/workers/components/ProjectWorkersPanel
 * @description   右侧 detail panel——项目 scope：顶部 worker tabs + 下方选中 worker 详情
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Terminal, TimerReset, Zap } from 'lucide-react';
import {
  getWorkerDetail,
  killWorker,
  launchWorker,
  listWorkers,
  type Worker,
} from '../../../shared/api/workers';
import { useDialog } from '../../../shared/components/DialogProvider';
import { StateBadge } from './shared/StateBadge';
import { formatRelative, formatRuntime } from './shared/formatters';

interface Props {
  project: string;
  initialSlot: number | undefined;
  onChange: () => void;
}

export function ProjectWorkersPanel({ project, initialSlot, onChange }: Props) {
  const { t } = useTranslation('workers');
  const workersQ = useQuery({
    queryKey: ['workers', project],
    queryFn: () => listWorkers(project),
    refetchInterval: 3000,
  });
  const workers = workersQ.data?.data ?? [];

  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  useEffect(() => {
    if (workers.length === 0) {
      setActiveSlot(null);
      return;
    }
    const fallback = workers[0]!.slot;
    setActiveSlot((prev) => {
      if (prev != null && workers.some((w) => w.slot === prev)) return prev;
      if (initialSlot != null && workers.some((w) => w.slot === initialSlot)) return initialSlot;
      return fallback;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, initialSlot, workers.length]);

  const activeWorker = workers.find((w) => w.slot === activeSlot) ?? null;

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b-2 border-[var(--color-text)] bg-[var(--color-bg-cream)]">
        <div className="flex items-center justify-between mb-2">
          <span className="font-[family-name:var(--font-mono)] font-bold truncate">{project}</span>
          <Link
            to={`/board?project=${encodeURIComponent(project)}`}
            className="text-xs underline text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            {t('capacity.boardLink')}
          </Link>
        </div>

        {workersQ.isLoading && workers.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)] italic">{t('capacity.loadingWorkers')}</p>
        ) : workers.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)] italic">{t('capacity.noSlots')}</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {workers.map((w) => (
              <WorkerTab
                key={w.slot}
                worker={w}
                active={w.slot === activeSlot}
                onClick={() => setActiveSlot(w.slot)}
              />
            ))}
          </div>
        )}
      </div>

      {activeWorker ? (
        <WorkerDetail project={project} worker={activeWorker} onChange={onChange} />
      ) : (
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <p className="text-sm text-[var(--color-text-muted)]">
            {workers.length === 0 ? t('capacity.noWorkers') : t('capacity.selectWorker')}
          </p>
        </div>
      )}
    </div>
  );
}

function WorkerTab({
  worker,
  active,
  onClick,
}: {
  worker: Worker;
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation('workers');
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        'nb-card p-2 text-left min-w-[130px] transition-transform',
        active ? 'ring-4 ring-[var(--color-text)]' : 'opacity-80 hover:opacity-100',
      ].join(' ')}
    >
      <div className="flex items-center gap-2 mb-1">
        <StateBadge state={worker.state} />
        <span className="font-[family-name:var(--font-mono)] font-bold text-xs">
          worker-{worker.slot}
        </span>
      </div>
      {worker.card ? (
        <div className="text-[11px] truncate font-[family-name:var(--font-mono)]">
          #{worker.card.seq} {worker.card.title}
        </div>
      ) : (
        <div className="text-[11px] text-[var(--color-text-muted)] italic">{t('capacity.idle')}</div>
      )}
    </button>
  );
}

function WorkerDetail({
  project,
  worker,
  onChange,
}: {
  project: string;
  worker: Worker;
  onChange: () => void;
}) {
  const { t } = useTranslation('workers');
  const { confirm, alert } = useDialog();
  const canRestart = worker.state === 'crashed' || worker.state === 'stuck';
  const detailQ = useQuery({
    queryKey: ['worker-detail', project, worker.slot],
    queryFn: () => getWorkerDetail(project, worker.slot),
    refetchInterval: 3000,
  });
  const recentOutput = detailQ.data?.recentOutput ?? [];
  const recentLogs = detailQ.data?.recentLogs ?? [];

  return (
    <>
      <div className="flex-1 overflow-auto p-4 flex flex-col gap-4">
        {worker.card ? (
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">
              {t('capacity.currentCard')}
            </div>
            <div className="text-sm font-semibold break-words">
              #{worker.card.seq} · {worker.card.title}
            </div>
          </div>
        ) : (
          <div className="text-sm text-[var(--color-text-muted)] italic">
            {t('capacity.slotIdle')}
          </div>
        )}

        <dl className="grid grid-cols-[100px_1fr] gap-y-2 text-sm">
          <dt className="font-bold">Stage</dt>
          <dd className="font-[family-name:var(--font-mono)]">{worker.stage ?? '—'}</dd>
          <dt className="font-bold">PID</dt>
          <dd className="font-[family-name:var(--font-mono)]">{worker.pid ?? '—'}</dd>
          <dt className="font-bold">Runtime</dt>
          <dd className="font-[family-name:var(--font-mono)]">{formatRuntime(worker.runtimeMs)}</dd>
          <dt className="font-bold">Started</dt>
          <dd className="font-[family-name:var(--font-mono)] text-xs">
            {worker.startedAt ? new Date(worker.startedAt).toLocaleString() : '—'}
          </dd>
          <dt className="font-bold">Marker</dt>
          <dd className="font-[family-name:var(--font-mono)] text-xs">
            {worker.markerUpdatedAt ? formatRelative(worker.markerUpdatedAt) : '—'}
          </dd>
        </dl>

        <div>
          <div className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1 flex items-center gap-1">
            <Terminal size={10} strokeWidth={2.5} />
            {t('capacity.outputRecent', { count: recentOutput.length })}
          </div>
          {detailQ.isLoading && recentOutput.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)] italic">{t('loading')}</p>
          ) : recentOutput.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)] italic">
              {t('capacity.outputEmpty')}
            </p>
          ) : (
            <pre className="text-xs font-[family-name:var(--font-mono)] bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded p-2 max-h-80 overflow-auto whitespace-pre-wrap break-words">
              {recentOutput
                .map((l) => {
                  const prefix = l.ts ? `${l.ts} [${l.kind}] ` : `[${l.kind}] `;
                  return `${prefix}${l.text}`;
                })
                .join('\n')}
            </pre>
          )}
        </div>

        {recentLogs.length > 0 && (
          <div>
            <div className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1 opacity-60">
              {t('capacity.heartbeatRecent', { count: recentLogs.length })}
            </div>
            <pre className="text-xs font-[family-name:var(--font-mono)] bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap break-words opacity-80">
              {recentLogs.map((l) => `${l.ts ?? ''} [${l.level}] ${l.msg}`).join('\n')}
            </pre>
            <Link
              to={`/logs?project=${encodeURIComponent(project)}&worker=${worker.slot}`}
              className="text-xs underline text-[var(--color-running)] mt-1 inline-block"
            >
              {t('capacity.viewFullLog')}
            </Link>
          </div>
        )}
      </div>

      <div className="px-4 py-3 border-t-2 border-[var(--color-text)] bg-[var(--color-bg-cream)] flex gap-2 justify-end flex-wrap">
        {canRestart && worker.card && (
          <button
            type="button"
            className="nb-btn nb-btn-mint"
            style={{ padding: '4px 10px', fontSize: 11 }}
            onClick={async () => {
              const ok = await confirm({
                title: t('actions.restartTitle', { slot: worker.slot }),
                body: t('actions.restartBody', { seq: worker.card!.seq }),
                confirm: t('actions.restartConfirm'),
              });
              if (!ok) return;
              try {
                await killWorker(project, worker.slot);
              } catch {
                /* 已死 */
              }
              try {
                await launchWorker(project, worker.slot, worker.card!.seq);
                onChange();
              } catch (err) {
                void alert({
                  title: t('actions.restartFailed'),
                  body: err instanceof Error ? err.message : String(err),
                });
              }
            }}
          >
            <TimerReset size={11} strokeWidth={2.5} /> {t('actions.restart')}
          </button>
        )}
        {worker.state !== 'idle' && (
          <button
            type="button"
            className="nb-btn nb-btn-danger"
            style={{ padding: '4px 10px', fontSize: 11 }}
            onClick={async () => {
              const ok = await confirm({
                title: t('actions.killTitle', { slot: worker.slot }),
                body: t('actions.killBody'),
                confirm: t('actions.killConfirm'),
                danger: true,
              });
              if (!ok) return;
              try {
                await killWorker(project, worker.slot);
                onChange();
              } catch (err) {
                void alert({
                  title: t('actions.killFailed'),
                  body: err instanceof Error ? err.message : String(err),
                });
              }
            }}
          >
            <Zap size={11} strokeWidth={2.5} /> {t('actions.kill')}
          </button>
        )}
      </div>
    </>
  );
}
