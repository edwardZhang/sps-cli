import { useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Terminal, Zap, Info, Loader2, RefreshCw } from 'lucide-react';
import { getWorkerDetail, killWorker, launchWorker, listWorkers, type Worker } from '../../shared/api/workers';
import { ProjectPicker } from '../../shared/components/ProjectPicker';
import { useDialog } from '../../shared/components/DialogProvider';
import { useProjectStream } from '../../shared/hooks/useProjectStream';

export function WorkersPage() {
  const [params, setParams] = useSearchParams();
  const project = params.get('project');
  useProjectStream(project);
  const qc = useQueryClient();
  const [detailSlot, setDetailSlot] = useState<number | null>(null);

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['workers', project],
    queryFn: () => listWorkers(project ?? ''),
    enabled: !!project,
    refetchInterval: 5000,
  });

  if (!project) {
    return (
      <div className="nb-card max-w-2xl bg-[var(--color-accent-yellow)]">
        <h1 className="font-[family-name:var(--font-heading)] text-2xl font-bold mb-2">
          Workers 👷
        </h1>
        <p className="text-sm text-[var(--color-text-muted)]">
          在 URL 上加 <code className="bg-[var(--color-bg)] border-2 border-[var(--color-text)] px-2 py-0.5 rounded">?project=xx</code>，或从<Link to="/projects" className="underline font-semibold"> 项目列表</Link> 打开看板后跳转。
        </p>
      </div>
    );
  }

  const workers = data?.data ?? [];
  const running = workers.filter((w) => w.state === 'running').length;
  const stuck = workers.filter((w) => w.state === 'stuck').length;
  const crashed = workers.filter((w) => w.state === 'crashed').length;

  return (
    <div className="flex flex-col gap-4 max-w-6xl">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold tracking-tight">
            Workers 👷
          </h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            {workers.length} 个 slot · {running} running · {stuck} stuck · {crashed} crashed
          </p>
        </div>
        <div className="flex gap-3 items-center">
          <ProjectPicker current={project} onChange={(n) => setParams({ project: n })} />
          <button className="nb-btn nb-btn-yellow" onClick={() => refetch()} type="button">
            <RotateCcw size={14} strokeWidth={2.5} /> 刷新
          </button>
        </div>
      </header>

      {isLoading && <p className="text-[var(--color-text-muted)]">加载中…</p>}
      {isError && (
        <div className="nb-card bg-[var(--color-crashed-bg)]">
          <p className="font-semibold">加载失败: {error instanceof Error ? error.message : String(error)}</p>
        </div>
      )}

      {!isLoading && workers.length === 0 && (
        <div className="nb-card bg-[var(--color-bg-cream)]">
          <p className="text-[var(--color-text-muted)]">当前没有 worker slot。启动一次 pipeline 就会出现。</p>
        </div>
      )}

      {workers.length > 0 && (
        <div className="nb-card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[var(--color-bg-cream)] border-b-2 border-[var(--color-text)]">
                <Th w="70px">Slot</Th>
                <Th>Card</Th>
                <Th w="110px">Status</Th>
                <Th w="90px">Stage</Th>
                <Th w="90px">PID</Th>
                <Th w="120px">Runtime</Th>
                <Th w="260px" right>Action</Th>
              </tr>
            </thead>
            <tbody>
              {workers.map((w) => (
                <WorkerRow
                  key={w.slot}
                  project={project}
                  worker={w}
                  onChange={() => qc.invalidateQueries({ queryKey: ['workers', project] })}
                  onDetail={() => setDetailSlot(w.slot)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detailSlot !== null && (
        <WorkerDetailModal
          project={project}
          slot={detailSlot}
          onClose={() => setDetailSlot(null)}
          onChange={() => qc.invalidateQueries({ queryKey: ['workers', project] })}
        />
      )}
    </div>
  );
}

function Th({ children, w, right }: { children: React.ReactNode; w?: string; right?: boolean }) {
  return (
    <th
      className={[
        'px-4 py-3 text-left font-[family-name:var(--font-heading)] font-bold text-[12px] uppercase tracking-wider text-[var(--color-text-muted)]',
        right ? 'text-right' : '',
      ].join(' ')}
      style={w ? { width: w } : undefined}
    >
      {children}
    </th>
  );
}

function WorkerRow({
  project,
  worker,
  onChange,
  onDetail,
}: {
  project: string;
  worker: Worker;
  onChange: () => void;
  onDetail: () => void;
}) {
  const { confirm, alert } = useDialog();
  const idle = worker.state === 'idle';
  const canRestart = worker.state === 'crashed' || worker.state === 'stuck';
  return (
    <tr className="border-b border-dashed border-[var(--color-border-light)] last:border-0 hover:bg-[var(--color-accent-yellow)] transition-colors">
      <td className="px-4 py-3 font-[family-name:var(--font-mono)] font-bold">{worker.slot}</td>
      <td className="px-4 py-3">
        {worker.card ? (
          <span className="font-semibold">
            <span className="inline-block px-2 py-0.5 text-xs bg-[var(--color-accent-purple)] border-2 border-[var(--color-text)] rounded-full font-[family-name:var(--font-mono)] mr-2">
              #{worker.card.seq}
            </span>
            {worker.card.title}
          </span>
        ) : (
          <em className="text-[var(--color-text-subtle)]">— 空闲 —</em>
        )}
      </td>
      <td className="px-4 py-3">
        <StatusPill state={worker.state} />
      </td>
      <td className="px-4 py-3 font-[family-name:var(--font-mono)] text-[var(--color-text-muted)]">
        {worker.stage || '—'}
      </td>
      <td className="px-4 py-3 font-[family-name:var(--font-mono)] text-[var(--color-text-muted)]">
        {worker.pid ?? '—'}
      </td>
      <td className="px-4 py-3 font-[family-name:var(--font-mono)] text-[var(--color-text-muted)]">
        {formatRuntime(worker.runtimeMs)}
      </td>
      <td className="px-4 py-3 text-right space-x-2">
        <button
          className="nb-btn"
          style={{ padding: '4px 10px', fontSize: 11 }}
          onClick={onDetail}
          type="button"
          aria-label={`查看 worker-${worker.slot} 详情`}
        >
          <Info size={12} strokeWidth={2.5} /> 详情
        </button>
        {canRestart && worker.card && (
          <button
            className="nb-btn nb-btn-mint"
            style={{ padding: '4px 10px', fontSize: 11 }}
            onClick={async () => {
              const ok = await confirm({
                title: `重启 worker-${worker.slot}`,
                body: `先杀掉当前进程，然后重新 launch 到卡 #${worker.card!.seq}。`,
                confirm: '重启',
              });
              if (!ok) return;
              try {
                await killWorker(project, worker.slot);
              } catch { /* 可能已经死了 */ }
              try {
                await launchWorker(project, worker.slot, worker.card!.seq);
                onChange();
              } catch (err) {
                void alert({
                  title: '重启失败',
                  body: err instanceof Error ? err.message : String(err),
                });
              }
            }}
            type="button"
          >
            <RefreshCw size={12} strokeWidth={2.5} /> 重启
          </button>
        )}
        {!idle && (
          <>
            <Link
              to={`/logs?project=${encodeURIComponent(project)}&worker=${worker.slot}`}
              className="nb-btn"
              style={{ display: 'inline-flex', padding: '4px 10px', fontSize: 11 }}
            >
              <Terminal size={12} strokeWidth={2.5} /> log
            </Link>
            <button
              className="nb-btn nb-btn-danger"
              style={{ padding: '4px 10px', fontSize: 11 }}
              onClick={async () => {
                const ok = await confirm({
                  title: `终止 worker-${worker.slot}`,
                  body: '当前任务会被强制中断，未保存的工作可能丢失。',
                  confirm: '终止',
                  danger: true,
                });
                if (!ok) return;
                await killWorker(project, worker.slot);
                onChange();
              }}
              type="button"
            >
              <Zap size={12} strokeWidth={2.5} /> 终止
            </button>
          </>
        )}
      </td>
    </tr>
  );
}

function WorkerDetailModal({
  project,
  slot,
  onClose,
  onChange,
}: {
  project: string;
  slot: number;
  onClose: () => void;
  onChange: () => void;
}) {
  const { confirm, alert } = useDialog();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['worker-detail', project, slot],
    queryFn: () => getWorkerDetail(project, slot),
    refetchInterval: 3000,
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-start justify-center p-6 bg-black/30 overflow-auto"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="nb-card mt-8 w-full max-w-3xl"
      >
        <header className="flex items-center justify-between mb-3">
          <div>
            <h2 className="font-[family-name:var(--font-heading)] text-2xl font-bold">
              worker-{slot}
            </h2>
            <p className="text-xs text-[var(--color-text-muted)] font-[family-name:var(--font-mono)] mt-0.5">
              {project}
            </p>
          </div>
          <div className="flex gap-2">
            <button
              className="nb-btn"
              style={{ padding: '6px 12px' }}
              onClick={() => refetch()}
              type="button"
              aria-label="刷新"
            >
              <RotateCcw size={12} strokeWidth={2.5} /> 刷新
            </button>
            <button
              className="nb-btn nb-btn-mint p-2"
              onClick={onClose}
              type="button"
              aria-label="关闭"
            >
              ✕
            </button>
          </div>
        </header>

        {isLoading && <p className="text-[var(--color-text-muted)]">加载中…</p>}
        {isError && (
          <p className="text-[var(--color-crashed)]">
            加载失败: {error instanceof Error ? error.message : String(error)}
          </p>
        )}

        {data && (
          <div className="flex flex-col gap-4">
            <div className="nb-card bg-[var(--color-bg-cream)] p-4">
              <dl className="grid grid-cols-[130px_1fr] gap-y-2 text-sm">
                <dt className="font-bold">状态</dt>
                <dd><StatusPill state={data.state} /></dd>
                <dt className="font-bold">PID</dt>
                <dd className="font-[family-name:var(--font-mono)]">{data.pid ?? '—'}</dd>
                <dt className="font-bold">Card</dt>
                <dd className="font-[family-name:var(--font-mono)]">
                  {data.card ? `#${data.card.seq} · ${data.card.title}` : '—'}
                </dd>
                <dt className="font-bold">Stage</dt>
                <dd className="font-[family-name:var(--font-mono)]">{data.stage ?? '—'}</dd>
                <dt className="font-bold">Runtime</dt>
                <dd className="font-[family-name:var(--font-mono)]">{formatRuntime(data.runtimeMs)}</dd>
                <dt className="font-bold">Marker</dt>
                <dd className="font-[family-name:var(--font-mono)] text-xs text-[var(--color-text-muted)] break-all">
                  {data.markerPath}
                </dd>
                <dt className="font-bold">Marker 更新</dt>
                <dd className="font-[family-name:var(--font-mono)] text-xs">
                  {data.markerUpdatedAt
                    ? `${new Date(data.markerUpdatedAt).toLocaleString()} (${formatRelative(data.markerUpdatedAt)})`
                    : '—'}
                </dd>
              </dl>
            </div>

            <div>
              <h3 className="font-[family-name:var(--font-heading)] text-sm font-bold mb-2 uppercase tracking-wider">
                最近 {data.recentLogs.length} 行日志
              </h3>
              {data.recentLogs.length === 0 ? (
                <p className="text-xs text-[var(--color-text-muted)] italic">
                  没找到带 worker-{slot} 标签的日志。去 Logs 页看全量。
                </p>
              ) : (
                <pre className="text-xs font-[family-name:var(--font-mono)] bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded-lg p-3 max-h-64 overflow-auto whitespace-pre-wrap break-words">
                  {data.recentLogs
                    .map((l) => `${l.ts ?? ''} [${l.level}] ${l.msg}`)
                    .join('\n')}
                </pre>
              )}
              <Link
                to={`/logs?project=${encodeURIComponent(project)}&worker=${slot}`}
                className="inline-block mt-2 text-xs underline text-[var(--color-running)]"
              >
                查看完整 log →
              </Link>
            </div>

            <div className="flex gap-2 justify-end border-t-2 border-dashed border-[var(--color-text)] pt-3">
              {(data.state === 'crashed' || data.state === 'stuck') && data.card && (
                <button
                  className="nb-btn nb-btn-mint"
                  onClick={async () => {
                    const ok = await confirm({
                      title: `重启 worker-${slot}`,
                      body: `先杀掉当前进程，重新 launch 到卡 #${data.card!.seq}。`,
                      confirm: '重启',
                    });
                    if (!ok) return;
                    try { await killWorker(project, slot); } catch { /* 已死 */ }
                    try {
                      await launchWorker(project, slot, data.card!.seq);
                      onChange();
                      refetch();
                    } catch (err) {
                      void alert({
                        title: '重启失败',
                        body: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }}
                  type="button"
                >
                  <RefreshCw size={14} strokeWidth={2.5} /> 重启
                </button>
              )}
              {data.state !== 'idle' && (
                <button
                  className="nb-btn nb-btn-danger"
                  onClick={async () => {
                    const ok = await confirm({
                      title: `终止 worker-${slot}`,
                      body: '当前任务会被强制中断。',
                      confirm: '终止',
                      danger: true,
                    });
                    if (!ok) return;
                    try {
                      await killWorker(project, slot);
                      onChange();
                      refetch();
                    } catch (err) {
                      void alert({
                        title: '终止失败',
                        body: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }}
                  type="button"
                >
                  <Zap size={14} strokeWidth={3} /> 终止
                </button>
              )}
              {data.state === 'running' && (
                <Loader2 size={14} strokeWidth={3} className="animate-spin self-center text-[var(--color-running)]" />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatRelative(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s 前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m 前`;
  return `${Math.floor(diff / 3_600_000)}h 前`;
}

function StatusPill({ state }: { state: Worker['state'] }) {
  const config: Record<Worker['state'], { bg: string; color: string }> = {
    running:  { bg: 'var(--color-running-bg)', color: 'var(--color-running)' },
    stuck:    { bg: 'var(--color-stuck-bg)',   color: 'var(--color-stuck)' },
    crashed:  { bg: 'var(--color-crashed-bg)', color: 'var(--color-crashed)' },
    idle:     { bg: 'var(--color-idle-bg)',    color: 'var(--color-idle)' },
  };
  const { bg, color } = config[state];
  return <span className="nb-status" style={{ background: bg, color }}>{state}</span>;
}

function formatRuntime(ms: number | null): string {
  if (ms == null || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
