import { useSearchParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Terminal, Zap } from 'lucide-react';
import { listWorkers, killWorker, type Worker } from '../../shared/api/workers';
import { ProjectPicker } from '../../shared/components/ProjectPicker';
import { useProjectStream } from '../../shared/hooks/useProjectStream';

export function WorkersPage() {
  const [params, setParams] = useSearchParams();
  const project = params.get('project');
  useProjectStream(project);
  const qc = useQueryClient();

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
                <Th w="200px" right>Action</Th>
              </tr>
            </thead>
            <tbody>
              {workers.map((w) => (
                <WorkerRow
                  key={w.slot}
                  project={project}
                  worker={w}
                  onChange={() => qc.invalidateQueries({ queryKey: ['workers', project] })}
                />
              ))}
            </tbody>
          </table>
        </div>
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
}: {
  project: string;
  worker: Worker;
  onChange: () => void;
}) {
  const idle = worker.state === 'idle';
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
        {!idle && (
          <>
            <Link
              to={`/logs?project=${encodeURIComponent(project)}&worker=${worker.slot}`}
              className="nb-btn nb-btn-sm"
              style={{ display: 'inline-flex', padding: '4px 10px', fontSize: 11 }}
            >
              <Terminal size={12} strokeWidth={2.5} /> log
            </Link>
            <button
              className="nb-btn nb-btn-danger"
              style={{ padding: '4px 10px', fontSize: 11 }}
              onClick={async () => {
                if (!window.confirm(`终止 worker-${worker.slot}？`)) return;
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
