import { useQuery } from '@tanstack/react-query';
import { RefreshCw, CheckCircle, AlertCircle } from 'lucide-react';
import { getSystemInfo, getEnv, runDoctor } from '../../shared/api/system';

export function SystemPage() {
  const infoQ = useQuery({ queryKey: ['system-info'], queryFn: getSystemInfo });
  const envQ = useQuery({ queryKey: ['system-env'], queryFn: getEnv });
  const doctorQ = useQuery({ queryKey: ['doctor'], queryFn: runDoctor });

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <header>
        <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold">系统 ⚙️</h1>
      </header>

      <section className="nb-card">
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold mb-3">
          版本与运行时
        </h2>
        {infoQ.data ? (
          <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-sm">
            <dt className="font-bold">sps-cli</dt>
            <dd className="font-[family-name:var(--font-mono)]">{infoQ.data.version}</dd>
            <dt className="font-bold">Node</dt>
            <dd className="font-[family-name:var(--font-mono)]">{infoQ.data.nodeVersion}</dd>
            <dt className="font-bold">Platform</dt>
            <dd className="font-[family-name:var(--font-mono)]">{infoQ.data.platform}</dd>
            <dt className="font-bold">PID</dt>
            <dd className="font-[family-name:var(--font-mono)]">{infoQ.data.pid ?? '—'}</dd>
            <dt className="font-bold">Uptime</dt>
            <dd className="font-[family-name:var(--font-mono)]">
              {formatUptime(infoQ.data.uptimeMs)}
            </dd>
          </dl>
        ) : (
          <p className="text-[var(--color-text-muted)]">加载中…</p>
        )}
      </section>

      <section className="nb-card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold">
            全局配置 <code className="text-sm font-[family-name:var(--font-mono)] font-normal bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] px-2 py-0.5 rounded">~/.coral/env</code>
          </h2>
          <span className="text-xs text-[var(--color-text-muted)]">
            敏感值脱敏
          </span>
        </div>
        {envQ.data && envQ.data.exists ? (
          <dl className="grid grid-cols-[220px_1fr] gap-y-1 text-sm font-[family-name:var(--font-mono)]">
            {envQ.data.entries.map((e) => (
              <div key={e.key} className="contents">
                <dt className="font-bold flex items-center gap-2">
                  {e.masked && <span className="text-[var(--color-stuck)]">🔒</span>}
                  {e.key}
                </dt>
                <dd className="text-[var(--color-text-muted)] truncate">{e.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <p className="text-[var(--color-text-muted)] text-sm">
            env 文件不存在。运行 <code className="bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] px-2 py-0.5 rounded font-[family-name:var(--font-mono)]">sps setup</code> 配置。
          </p>
        )}
      </section>

      <section className="nb-card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold">
            项目健康检查
          </h2>
          <button
            className="nb-btn nb-btn-mint"
            style={{ padding: '6px 12px', fontSize: 12 }}
            onClick={() => doctorQ.refetch()}
            type="button"
          >
            <RefreshCw size={12} strokeWidth={2.5} />
            重跑
          </button>
        </div>
        {doctorQ.data && doctorQ.data.data.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {doctorQ.data.data.map((r) => (
              <li
                key={r.project}
                className="flex items-center gap-3 px-3 py-2 bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded-lg"
              >
                {r.ok ? (
                  <CheckCircle size={16} className="text-[var(--color-running)]" strokeWidth={2.5} />
                ) : (
                  <AlertCircle size={16} className="text-[var(--color-stuck)]" strokeWidth={2.5} />
                )}
                <span className="font-bold font-[family-name:var(--font-mono)]">
                  {r.project}
                </span>
                {r.issues.length > 0 ? (
                  <span className="text-xs text-[var(--color-text-muted)]">
                    {r.issues.join('; ')}
                  </span>
                ) : (
                  <span className="text-xs text-[var(--color-running)] font-semibold">OK</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[var(--color-text-muted)] text-sm">
            还没有项目。
          </p>
        )}
      </section>
    </div>
  );
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}
