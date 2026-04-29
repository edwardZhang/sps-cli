/**
 * @module        features/workers/WorkersAggregatePage
 * @description   Workers 聚合视图（跨项目）—— thin shell，子组件在 ./components/
 *
 * 布局：
 *   顶部 header（总览统计 + 刷新）
 *   左右分栏：
 *     左主区：Alerts / Active / Capacity 三段
 *     右详情：ProjectWorkersPanel（选中项目的 worker tabs + 详情）
 *
 * 选中状态 scope = project（可选 slot 做默认 tab）：
 *   - Capacity 行点击：只选 project
 *   - Alerts / Active 卡片点击：选 project + slot
 *
 * v0.50.18：从 745 行大文件拆出子组件，此文件 ~150 行
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Activity, Loader2, RefreshCw } from 'lucide-react';
import { getWorkersAggregate } from '../../shared/api/workers';
import { AlertsSection } from './components/AlertsSection';
import { ActiveSection } from './components/ActiveSection';
import { CapacitySection } from './components/CapacitySection';
import { ProjectWorkersPanel } from './components/ProjectWorkersPanel';

export function WorkersAggregatePage() {
  const { t } = useTranslation('workers');
  const qc = useQueryClient();
  const [selected, setSelected] = useState<{ project: string; slot?: number } | null>(null);

  const aggQ = useQuery({
    queryKey: ['workers-agg'],
    queryFn: getWorkersAggregate,
    refetchInterval: 5000,
  });

  // 多项目 SSE 订阅：每个项目一个 stream，worker 事件进来即 invalidate
  useEffect(() => {
    if (!aggQ.data) return;
    const projects = aggQ.data.capacity.map((c) => c.project);
    const srcs: EventSource[] = [];
    for (const project of projects) {
      const es = new EventSource(`/stream/projects/${encodeURIComponent(project)}`);
      const handler = (): void => {
        qc.invalidateQueries({ queryKey: ['workers-agg'] });
      };
      es.addEventListener('worker.updated', handler);
      es.addEventListener('worker.added', handler);
      es.addEventListener('worker.deleted', handler);
      es.addEventListener('card.updated', handler); // 标签变化影响 starting 判定
      srcs.push(es);
    }
    return () => {
      for (const es of srcs) es.close();
    };
  }, [aggQ.data?.capacity.map((c) => c.project).join(','), qc]); // eslint-disable-line react-hooks/exhaustive-deps

  const totals = useMemo(() => {
    if (!aggQ.data) return { projects: 0, running: 0, starting: 0, stuck: 0, crashed: 0, idle: 0 };
    const t = {
      projects: aggQ.data.capacity.length,
      running: 0,
      starting: 0,
      stuck: 0,
      crashed: 0,
      idle: 0,
    };
    for (const c of aggQ.data.capacity) {
      t.running += c.running;
      t.starting += c.starting;
      t.stuck += c.stuck;
      t.crashed += c.crashed;
      t.idle += c.idle;
    }
    return t;
  }, [aggQ.data]);

  return (
    <div className="flex flex-col gap-4 h-[calc(100vh-140px)]">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold tracking-tight">
            {t('title')} 👷
          </h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            {t('summary', { projects: totals.projects, running: totals.running, starting: totals.starting })}
            <span className="text-[var(--color-stuck)]">{t('stuck', { count: totals.stuck })}</span> ·{' '}
            <span className="text-[var(--color-crashed)]">{t('crashed', { count: totals.crashed })}</span>{t('idle', { count: totals.idle })}
          </p>
        </div>
        <button
          className="nb-btn"
          style={{ padding: '6px 12px', fontSize: 12 }}
          onClick={() => aggQ.refetch()}
          disabled={aggQ.isFetching}
          type="button"
          aria-label={t('refreshAria')}
        >
          {aggQ.isFetching ? (
            <Loader2 size={12} strokeWidth={3} className="animate-spin" />
          ) : (
            <RefreshCw size={12} strokeWidth={2.5} />
          )}
          {t('refresh')}
        </button>
      </header>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 flex-1 min-h-0">
        <div className="flex flex-col gap-4 overflow-auto pr-2">
          {aggQ.isLoading && <p className="text-[var(--color-text-muted)] italic">{t('loading')}</p>}
          {aggQ.isError && (
            <div className="nb-card bg-[var(--color-crashed-bg)]">
              <p>{t('loadFailed', { error: aggQ.error instanceof Error ? aggQ.error.message : String(aggQ.error) })}</p>
            </div>
          )}

          {aggQ.data && (
            <>
              <AlertsSection
                alerts={aggQ.data.alerts}
                selected={selected}
                onSelect={(project, slot) => setSelected({ project, slot })}
              />
              <ActiveSection
                active={aggQ.data.active}
                selected={selected}
                onSelect={(project, slot) => setSelected({ project, slot })}
              />
              <CapacitySection
                capacity={aggQ.data.capacity}
                selected={selected}
                onSelect={(project) => setSelected({ project })}
              />
            </>
          )}
        </div>

        <aside className="nb-card p-0 overflow-hidden flex flex-col h-full">
          {selected ? (
            <ProjectWorkersPanel
              project={selected.project}
              initialSlot={selected.slot}
              onChange={() => qc.invalidateQueries({ queryKey: ['workers-agg'] })}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center p-6 text-center">
              <div>
                <Activity
                  size={32}
                  className="mx-auto mb-3 text-[var(--color-text-subtle)]"
                  strokeWidth={2}
                />
                <p className="text-sm text-[var(--color-text-muted)]">{t('selectHint')}</p>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
