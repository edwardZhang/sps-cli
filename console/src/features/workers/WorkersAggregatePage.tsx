import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Skull,
  Terminal,
  Zap,
  Clock,
  TimerReset,
} from 'lucide-react';
import {
  getWorkerDetail,
  getWorkersAggregate,
  killWorker,
  launchWorker,
  listWorkers,
  type AggregateWorker,
  type ProjectCapacity,
  type Worker,
  type WorkerState,
} from '../../shared/api/workers';
import { useDialog } from '../../shared/components/DialogProvider';

/**
 * Workers 聚合视图（v0.50.13 起：右侧改为项目级详情）
 *
 * 三段式 + 右侧 project detail panel：
 *   Alerts：stuck / crashed worker 置顶（有才显示）
 *   Active：running / starting 的卡片式展示
 *   Capacity：项目级总览
 *   右侧：选中项目的 workers 列表（卡片 tabs）+ 选中 worker 详情
 *
 * 点击 Capacity 项目行 / Alert 卡 / Active 卡都会设置右侧 = 对应项目；
 * 如果点的是具体 worker 卡，默认 tab 落在它；否则落在项目的第一个 worker。
 */
export function WorkersAggregatePage() {
  const qc = useQueryClient();
  // v0.50.13：selected scope = project（可选 slot 作为默认 tab）
  const [selected, setSelected] = useState<{ project: string; slot?: number } | null>(null);

  const aggQ = useQuery({
    queryKey: ['workers-agg'],
    queryFn: getWorkersAggregate,
    refetchInterval: 5000, // 5s 兜底
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

  // v0.50.13：allWorkers 已不需要（右侧按 project fetch listWorkers）

  const totals = useMemo(() => {
    if (!aggQ.data) return { projects: 0, running: 0, starting: 0, stuck: 0, crashed: 0, idle: 0 };
    const t = { projects: aggQ.data.capacity.length, running: 0, starting: 0, stuck: 0, crashed: 0, idle: 0 };
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
      {/* 顶部 title 占满整页宽度 */}
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold tracking-tight">
            Workers 👷
          </h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            跨 {totals.projects} 项目 · {totals.running} 跑 · {totals.starting} 启动 ·{' '}
            <span className="text-[var(--color-stuck)]">{totals.stuck} 卡</span> ·{' '}
            <span className="text-[var(--color-crashed)]">{totals.crashed} 崩</span> · {totals.idle} 闲
          </p>
        </div>
        <button
          className="nb-btn"
          style={{ padding: '6px 12px', fontSize: 12 }}
          onClick={() => aggQ.refetch()}
          disabled={aggQ.isFetching}
          type="button"
          aria-label="刷新"
        >
          {aggQ.isFetching ? (
            <Loader2 size={12} strokeWidth={3} className="animate-spin" />
          ) : (
            <RefreshCw size={12} strokeWidth={2.5} />
          )}
          刷新
        </button>
      </header>

      {/* 下方左右分栏：各占 50%；高度一致 */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 flex-1 min-h-0">
        {/* 左：主区 */}
        <div className="flex flex-col gap-4 overflow-auto pr-2">
          {aggQ.isLoading && (
            <p className="text-[var(--color-text-muted)] italic">加载中…</p>
          )}
          {aggQ.isError && (
            <div className="nb-card bg-[var(--color-crashed-bg)]">
              <p>加载失败: {aggQ.error instanceof Error ? aggQ.error.message : String(aggQ.error)}</p>
            </div>
          )}

          {aggQ.data && (
            <>
              {/* Alerts */}
              <AlertsSection
                alerts={aggQ.data.alerts}
                selected={selected}
                onSelect={(project, slot) => setSelected({ project, slot })}
              />

              {/* Active */}
              <ActiveSection
                active={aggQ.data.active}
                selected={selected}
                onSelect={(project, slot) => setSelected({ project, slot })}
              />

              {/* Capacity */}
              <CapacitySection
                capacity={aggQ.data.capacity}
                selected={selected}
                onSelect={(project) => setSelected({ project })}
              />
            </>
          )}
        </div>

        {/* 右：project-scoped detail panel */}
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
                <Activity size={32} className="mx-auto mb-3 text-[var(--color-text-subtle)]" strokeWidth={2} />
                <p className="text-sm text-[var(--color-text-muted)]">
                  点击项目 / worker 查看详情
                </p>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

// ── Alerts section ─────────────────────────────────────────────────

function AlertsSection({
  alerts,
  selected,
  onSelect,
}: {
  alerts: AggregateWorker[];
  selected: { project: string; slot?: number } | null;
  onSelect: (project: string, slot: number) => void;
}) {
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
                  {w.state === 'crashed' ? 'PID 已死。' : `marker 停 ${formatRelative(w.markerUpdatedAt)}。`}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

// ── Active section ─────────────────────────────────────────────────

function ActiveSection({
  active,
  selected,
  onSelect,
}: {
  active: AggregateWorker[];
  selected: { project: string; slot?: number } | null;
  onSelect: (project: string, slot: number) => void;
}) {
  if (active.length === 0) {
    return (
      <div className="nb-card bg-[var(--color-bg-cream)]">
        <p className="text-sm text-[var(--color-text-muted)] italic">
          没有 worker 在运行。
        </p>
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
                <span className={`text-xs font-[family-name:var(--font-mono)] ${runtimeColor(w.runtimeMs)}`}>
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
                  <Terminal size={9} strokeWidth={2.5} className="inline-block mr-1 align-text-bottom" />
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

// ── Capacity section ───────────────────────────────────────────────

function CapacitySection({
  capacity,
  selected,
  onSelect,
}: {
  capacity: ProjectCapacity[];
  selected: { project: string; slot?: number } | null;
  onSelect: (project: string) => void;
}) {
  if (capacity.length === 0) {
    return null;
  }
  return (
    <section>
      <h2 className="font-[family-name:var(--font-heading)] text-sm font-bold uppercase tracking-wider mb-2">
        Capacity
      </h2>
      <div className="nb-card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--color-bg-cream)] border-b-2 border-[var(--color-text)]">
              <th className="px-3 py-2 text-left font-bold text-xs uppercase tracking-wider">项目</th>
              <th className="px-3 py-2 text-left font-bold text-xs uppercase tracking-wider">占用</th>
              <th className="px-3 py-2 text-right font-bold text-xs uppercase tracking-wider">running</th>
              <th className="px-3 py-2 text-right font-bold text-xs uppercase tracking-wider">其它</th>
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
                    {c.stuck > 0 && <span className="text-[var(--color-stuck)] font-bold mr-2">stuck {c.stuck}</span>}
                    {c.crashed > 0 && <span className="text-[var(--color-crashed)] font-bold mr-2">crashed {c.crashed}</span>}
                    {busy === 0 && <span>idle</span>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <span className="text-xs text-[var(--color-text-muted)]">
                      详情 →
                    </span>
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
    case 'running': return 'var(--color-running-bg)';
    case 'starting': return 'var(--color-secondary)';
    case 'stuck': return 'var(--color-stuck-bg)';
    case 'crashed': return 'var(--color-crashed-bg)';
    default: return 'var(--color-idle-bg)';
  }
}

// ── Project workers panel (右侧) ───────────────────────────────
//
// v0.50.13：右侧详情 scope 改为项目。顶部是 worker tabs（卡片样式），
// 下面展示选中 worker 的完整详情（原 二级 WorkersPage modal 内容）。

function ProjectWorkersPanel({
  project,
  initialSlot,
  onChange,
}: {
  project: string;
  initialSlot: number | undefined;
  onChange: () => void;
}) {
  const workersQ = useQuery({
    queryKey: ['workers', project],
    queryFn: () => listWorkers(project),
    refetchInterval: 3000,
  });
  const workers = workersQ.data?.data ?? [];

  // 当前 tab：优先用 initialSlot（从 Alert/Active 点进来时带过来），否则第一个
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  useEffect(() => {
    if (workers.length === 0) {
      setActiveSlot(null);
      return;
    }
    // 切项目时重置；initialSlot 对应有 worker 就用它
    const fallback = workers[0]!.slot;
    setActiveSlot((prev) => {
      // 当前 prev 在新 workers 列表里还存在就保留
      if (prev != null && workers.some((w) => w.slot === prev)) return prev;
      if (initialSlot != null && workers.some((w) => w.slot === initialSlot)) return initialSlot;
      return fallback;
    });
    // 依赖 project + initialSlot + workers 长度，避免 workers 数组引用每次 refetch 变化时抖动
  }, [project, initialSlot, workers.length]);

  const activeWorker = workers.find((w) => w.slot === activeSlot) ?? null;

  return (
    <div className="flex flex-col h-full">
      {/* 顶部：项目名 + worker tabs */}
      <div className="px-4 py-3 border-b-2 border-[var(--color-text)] bg-[var(--color-bg-cream)]">
        <div className="flex items-center justify-between mb-2">
          <span className="font-[family-name:var(--font-mono)] font-bold truncate">{project}</span>
          <Link
            to={`/board?project=${encodeURIComponent(project)}`}
            className="text-xs underline text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          >
            看板 →
          </Link>
        </div>

        {workersQ.isLoading && workers.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)] italic">加载 workers…</p>
        ) : workers.length === 0 ? (
          <p className="text-xs text-[var(--color-text-muted)] italic">该项目没有 worker slot。</p>
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

      {/* 下部：active worker 详情 */}
      {activeWorker ? (
        <WorkerDetail
          project={project}
          worker={activeWorker}
          onChange={onChange}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center p-6 text-center">
          <p className="text-sm text-[var(--color-text-muted)]">
            {workers.length === 0 ? '无 worker' : '请选择一个 worker'}
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
        <div className="text-[11px] text-[var(--color-text-muted)] italic">空闲</div>
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
            <div className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)] mb-1">当前卡片</div>
            <div className="text-sm font-semibold break-words">#{worker.card.seq} · {worker.card.title}</div>
          </div>
        ) : (
          <div className="text-sm text-[var(--color-text-muted)] italic">slot 空闲，没有当前卡片。</div>
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
            Claude 输出 · 最近 {recentOutput.length} 行
          </div>
          {detailQ.isLoading && recentOutput.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)] italic">加载中…</p>
          ) : recentOutput.length === 0 ? (
            <p className="text-xs text-[var(--color-text-muted)] italic">
              还没收到 session 输出。Worker 刚启动时需要几秒。
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
              Supervisor 心跳 · 最近 {recentLogs.length} 行
            </div>
            <pre className="text-xs font-[family-name:var(--font-mono)] bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap break-words opacity-80">
              {recentLogs.map((l) => `${l.ts ?? ''} [${l.level}] ${l.msg}`).join('\n')}
            </pre>
            <Link
              to={`/logs?project=${encodeURIComponent(project)}&worker=${worker.slot}`}
              className="text-xs underline text-[var(--color-running)] mt-1 inline-block"
            >
              查看完整 log →
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
                title: `重启 worker-${worker.slot}`,
                body: `先杀进程，再重新 launch 到 #${worker.card!.seq}`,
                confirm: '重启',
              });
              if (!ok) return;
              try { await killWorker(project, worker.slot); } catch { /* 已死 */ }
              try {
                await launchWorker(project, worker.slot, worker.card!.seq);
                onChange();
              } catch (err) {
                void alert({ title: '重启失败', body: err instanceof Error ? err.message : String(err) });
              }
            }}
          >
            <TimerReset size={11} strokeWidth={2.5} /> 重启
          </button>
        )}
        {worker.state !== 'idle' && (
          <button
            type="button"
            className="nb-btn nb-btn-danger"
            style={{ padding: '4px 10px', fontSize: 11 }}
            onClick={async () => {
              const ok = await confirm({
                title: `终止 worker-${worker.slot}`,
                body: '当前任务强制中断。',
                confirm: '终止',
                danger: true,
              });
              if (!ok) return;
              try {
                await killWorker(project, worker.slot);
                onChange();
              } catch (err) {
                void alert({ title: '终止失败', body: err instanceof Error ? err.message : String(err) });
              }
            }}
          >
            <Zap size={11} strokeWidth={2.5} /> 终止
          </button>
        )}
      </div>
    </>
  );
}

// ── Shared bits ────────────────────────────────────────────────────

function StateBadge({ state }: { state: WorkerState }) {
  const config: Record<WorkerState, { bg: string; color: string; label: string; icon?: React.ReactNode }> = {
    running: { bg: 'var(--color-running-bg)', color: 'var(--color-running)', label: 'running' },
    starting: { bg: 'var(--color-secondary)', color: 'var(--color-text)', label: 'starting', icon: <Loader2 size={9} strokeWidth={3} className="animate-spin" /> },
    stuck: { bg: 'var(--color-stuck-bg)', color: 'var(--color-stuck)', label: 'stuck' },
    crashed: { bg: 'var(--color-crashed-bg)', color: 'var(--color-crashed)', label: 'crashed', icon: <Skull size={9} strokeWidth={2.5} /> },
    idle: { bg: 'var(--color-idle-bg)', color: 'var(--color-idle)', label: 'idle' },
  };
  const c = config[state];
  return (
    <span
      className="nb-status inline-flex items-center gap-1"
      style={{ background: c.bg, color: c.color }}
    >
      {c.icon}
      {c.label}
    </span>
  );
}

function formatRuntime(ms: number | null): string {
  if (ms == null || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function runtimeColor(ms: number | null): string {
  if (ms == null || ms <= 0) return 'text-[var(--color-text-muted)]';
  const minutes = ms / 60000;
  if (minutes < 10) return 'text-[var(--color-running)]';
  if (minutes < 60) return 'text-[var(--color-stuck)]';
  return 'text-[var(--color-crashed)]';
}

function formatRelative(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 10_000) return `${Math.floor(diff / 1000)}s 前`;
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s 前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m 前`;
  return `${Math.floor(diff / 3_600_000)}h 前`;
}
