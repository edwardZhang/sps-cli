import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw,
  CheckCircle,
  AlertCircle,
  Edit3,
  Save,
  X,
  Download,
  Loader2,
} from 'lucide-react';
import {
  getEnv,
  getEnvRaw,
  getLatestVersion,
  getSystemInfo,
  runDoctor,
  updateEnv,
  upgradeSps,
} from '../../shared/api/system';
import { useDialog } from '../../shared/components/DialogProvider';

export function SystemPage() {
  const infoQ = useQuery({ queryKey: ['system-info'], queryFn: getSystemInfo });
  const envQ = useQuery({ queryKey: ['system-env'], queryFn: getEnv });
  const doctorQ = useQuery({ queryKey: ['doctor'], queryFn: runDoctor });
  const [editingEnv, setEditingEnv] = useState(false);

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <header>
        <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold">系统 ⚙️</h1>
      </header>

      <VersionSection current={infoQ.data?.version} />

      <section className="nb-card">
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold mb-3">
          运行时
        </h2>
        {infoQ.data ? (
          <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-sm">
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
          {!editingEnv ? (
            <button
              className="nb-btn"
              style={{ padding: '6px 12px', fontSize: 12 }}
              onClick={() => setEditingEnv(true)}
              type="button"
              aria-label="编辑 env 文件"
            >
              <Edit3 size={12} strokeWidth={2.5} /> 编辑
            </button>
          ) : (
            <span className="text-xs text-[var(--color-stuck)] font-bold">⚠ 编辑模式</span>
          )}
        </div>

        {editingEnv ? (
          <EnvEditor
            onClose={() => {
              setEditingEnv(false);
              envQ.refetch();
            }}
          />
        ) : envQ.data && envQ.data.exists ? (
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
            env 文件不存在。点"编辑"或者终端运行 <code className="bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] px-2 py-0.5 rounded font-[family-name:var(--font-mono)]">sps setup</code>。
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

function VersionSection({ current }: { current?: string }) {
  const { confirm, alert } = useDialog();
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeLog, setUpgradeLog] = useState<string | null>(null);
  const latestQ = useQuery({
    queryKey: ['latest-version'],
    queryFn: getLatestVersion,
    enabled: false, // 手动触发，避免每次 mount 都去查 npm registry
  });

  const handleUpgrade = async (): Promise<void> => {
    const ok = await confirm({
      title: '升级 sps-cli',
      body: `当前 ${current}，升级到 ${latestQ.data?.latest}。要求所有 pipeline 已停止。升级后请重启 sps console 生效。`,
      confirm: '升级',
    });
    if (!ok) return;
    setUpgrading(true);
    setUpgradeLog(null);
    try {
      const res = await upgradeSps();
      setUpgradeLog(res.output);
      if (res.ok) {
        void alert({
          title: '升级完成',
          body: '请手动 `pkill -f "sps console"` 再重新启动以生效。',
        });
      } else {
        void alert({ title: '升级失败', body: res.output.slice(-500) });
      }
    } catch (err) {
      setUpgradeLog((err as Error).message);
      void alert({ title: '升级失败', body: (err as Error).message });
    } finally {
      setUpgrading(false);
    }
  };

  return (
    <section className="nb-card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold">
          版本
        </h2>
        <button
          className="nb-btn"
          style={{ padding: '6px 12px', fontSize: 12 }}
          onClick={() => latestQ.refetch()}
          disabled={latestQ.isFetching || !current}
          type="button"
          aria-label="检查最新版本"
        >
          {latestQ.isFetching ? (
            <Loader2 size={12} strokeWidth={3} className="animate-spin" />
          ) : (
            <RefreshCw size={12} strokeWidth={2.5} />
          )}
          检查更新
        </button>
      </div>
      <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-sm">
        <dt className="font-bold">sps-cli (当前)</dt>
        <dd className="font-[family-name:var(--font-mono)]">{current ?? '—'}</dd>
        {latestQ.data && (
          <>
            <dt className="font-bold">npm (最新)</dt>
            <dd className="font-[family-name:var(--font-mono)] flex items-center gap-2">
              {latestQ.data.latest}
              {latestQ.data.upToDate ? (
                <span className="nb-status" style={{ background: 'var(--color-running-bg)', color: 'var(--color-running)' }}>
                  最新
                </span>
              ) : (
                <button
                  className="nb-btn nb-btn-primary"
                  style={{ padding: '3px 10px', fontSize: 11 }}
                  onClick={handleUpgrade}
                  disabled={upgrading}
                  type="button"
                  aria-label="升级到最新版本"
                >
                  {upgrading ? (
                    <Loader2 size={11} strokeWidth={3} className="animate-spin" />
                  ) : (
                    <Download size={11} strokeWidth={2.5} />
                  )}
                  升级
                </button>
              )}
            </dd>
          </>
        )}
        {latestQ.isError && (
          <>
            <dt className="font-bold">检查</dt>
            <dd className="text-[var(--color-crashed)] text-xs">
              {latestQ.error instanceof Error ? latestQ.error.message : String(latestQ.error)}
            </dd>
          </>
        )}
      </dl>
      {upgradeLog && (
        <pre className="mt-3 text-xs font-[family-name:var(--font-mono)] bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded-lg p-3 max-h-40 overflow-auto whitespace-pre-wrap">
          {upgradeLog}
        </pre>
      )}
    </section>
  );
}

function EnvEditor({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { alert } = useDialog();
  const rawQ = useQuery({ queryKey: ['system-env-raw'], queryFn: getEnvRaw });
  const [draft, setDraft] = useState<string | null>(null);
  const [etag, setEtag] = useState<string | null>(null);

  // v0.49 修复：hydrate draft from query data in useEffect，不在 render 期 setState
  useEffect(() => {
    if (rawQ.data && draft === null) {
      setDraft(rawQ.data.content);
      setEtag(rawQ.data.etag);
    }
  }, [rawQ.data, draft]);

  const dirty = draft !== null && rawQ.data && draft !== rawQ.data.content;

  const saveMutation = useMutation({
    mutationFn: () => {
      if (draft === null) throw new Error('no draft');
      return updateEnv(draft, etag ?? '');
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['system-env'] });
      qc.invalidateQueries({ queryKey: ['system-env-raw'] });
      onClose();
    },
    onError: (err) => {
      const status = (err as Error & { status?: number }).status;
      void alert({
        title: status === 409 ? 'env 被其他地方修改了' : '保存失败',
        body:
          status === 409
            ? '请点取消后重开编辑。'
            : err instanceof Error ? err.message : String(err),
      });
    },
  });

  if (rawQ.isLoading) {
    return <p className="text-[var(--color-text-muted)]">加载中…</p>;
  }

  return (
    <div>
      <p className="text-xs text-[var(--color-stuck)] font-bold mb-2">
        ⚠ 文件包含凭证明文。保存时保持 0600 权限。
      </p>
      <textarea
        className="nb-input w-full font-[family-name:var(--font-mono)] text-xs"
        style={{ minHeight: 320, resize: 'vertical' }}
        value={draft ?? ''}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        aria-label="env 文件编辑器"
      />
      <div className="flex items-center justify-between mt-3">
        <span className="text-xs text-[var(--color-text-muted)] font-[family-name:var(--font-mono)]">
          {etag ? `etag: ${etag}` : ''}
          {dirty ? ' · ● 未保存' : ''}
        </span>
        <div className="flex gap-2">
          <button
            className="nb-btn"
            style={{ padding: '6px 12px' }}
            onClick={onClose}
            disabled={saveMutation.isPending}
            type="button"
          >
            <X size={12} strokeWidth={3} /> 取消
          </button>
          <button
            className="nb-btn nb-btn-primary"
            style={{ padding: '6px 12px' }}
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending}
            type="button"
            aria-label="保存 env"
          >
            {saveMutation.isPending ? (
              <Loader2 size={12} strokeWidth={3} className="animate-spin" />
            ) : (
              <Save size={12} strokeWidth={3} />
            )}
            保存
          </button>
        </div>
      </div>
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
