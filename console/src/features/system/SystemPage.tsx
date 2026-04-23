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
  Wrench,
  Copy,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import {
  getEnv,
  getEnvRaw,
  getLatestVersion,
  getSystemInfo,
  runProjectDoctor,
  updateEnv,
  upgradeSps,
  type DoctorCheck,
  type DoctorProjectResult,
} from '../../shared/api/system';
import { listProjects } from '../../shared/api/projects';
import { useDialog } from '../../shared/components/DialogProvider';

export function SystemPage() {
  const infoQ = useQuery({ queryKey: ['system-info'], queryFn: getSystemInfo });
  const envQ = useQuery({ queryKey: ['system-env'], queryFn: getEnv });
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

      <DoctorSection />
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

  const [installedVersion, setInstalledVersion] = useState<string | null>(null);
  const [upgradeCommand, setUpgradeCommand] = useState<string>('npm i -g @coralai/sps-cli@latest');

  const handleUpgrade = async (): Promise<void> => {
    const ok = await confirm({
      title: '升级 sps-cli',
      body: `当前 ${current}，升级到 ${latestQ.data?.latest}。要求所有 pipeline 已停止。升级后请重启 sps console 生效。`,
      confirm: '升级',
    });
    if (!ok) return;
    setUpgrading(true);
    setUpgradeLog(null);
    setInstalledVersion(null);
    try {
      const res = await upgradeSps();
      setUpgradeLog(res.output);
      setInstalledVersion(res.installedVersion);
      setUpgradeCommand(res.command);
      if (res.ok) {
        void alert({
          title: '升级完成',
          body: `装上了 v${res.installedVersion}。请 \`pkill -f "sps console"\` 再重启以生效。`,
        });
      } else {
        // 详细错误区分：npm 跑完了但版本没变 vs npm 失败
        const reason = res.installedVersion && res.installedVersion === current
          ? `npm 执行完毕但版本没变（仍 ${res.installedVersion}）——多半是权限或 registry 问题。可复制下面的命令在终端手动跑。`
          : `npm 没装上新版本。可复制命令手动跑，或看下面日志定位。`;
        void alert({ title: '升级未生效', body: reason });
      }
    } catch (err) {
      setUpgradeLog((err as Error).message);
      void alert({ title: '升级失败', body: (err as Error).message });
    } finally {
      setUpgrading(false);
    }
  };

  const handleCopyCommand = async (): Promise<void> => {
    const cmd = latestQ.data && !latestQ.data.upToDate
      ? `npm i -g @coralai/sps-cli@${latestQ.data.latest}`
      : upgradeCommand;
    try {
      await navigator.clipboard.writeText(cmd);
      void alert({ title: '命令已复制', body: `粘贴到终端运行即可：\n${cmd}` });
    } catch {
      void alert({ title: '复制失败', body: `请手动复制：\n${cmd}` });
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
            <dd className="font-[family-name:var(--font-mono)] flex items-center gap-2 flex-wrap">
              {latestQ.data.latest}
              {latestQ.data.upToDate ? (
                <span className="nb-status" style={{ background: 'var(--color-running-bg)', color: 'var(--color-running)' }}>
                  最新
                </span>
              ) : (
                <>
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
                  <button
                    className="nb-btn"
                    style={{ padding: '3px 10px', fontSize: 11 }}
                    onClick={handleCopyCommand}
                    type="button"
                    aria-label="复制升级命令"
                    title="自动升级失败时手动跑"
                  >
                    <Copy size={11} strokeWidth={2.5} /> 复制命令
                  </button>
                </>
              )}
            </dd>
          </>
        )}
        {installedVersion && (
          <>
            <dt className="font-bold">已安装</dt>
            <dd className="font-[family-name:var(--font-mono)] flex items-center gap-2">
              {installedVersion}
              {installedVersion === latestQ.data?.latest ? (
                <span className="nb-status" style={{ background: 'var(--color-running-bg)', color: 'var(--color-running)' }}>
                  已生效（重启 console 后可见）
                </span>
              ) : installedVersion === current ? (
                <span className="nb-status" style={{ background: 'var(--color-stuck-bg)', color: 'var(--color-stuck)' }}>
                  未升级成功
                </span>
              ) : null}
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

// v0.50.14：真实 doctor 替代原 shallow doctorAll
// v0.50.17：warm-load 改走 /api/projects（不再有单独的 shallow doctor 路径）
function DoctorSection() {
  const { alert } = useDialog();
  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: listProjects });
  // 存每个项目的 detailed doctor 结果
  const [details, setDetails] = useState<Record<string, DoctorProjectResult>>({});
  const [loading, setLoading] = useState<Record<string, 'check' | 'fix' | null>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const projects = (projectsQ.data?.data ?? []).map((p) => ({ project: p.name }));

  const runCheck = async (project: string, fix: boolean): Promise<void> => {
    setLoading((l) => ({ ...l, [project]: fix ? 'fix' : 'check' }));
    try {
      const res = await runProjectDoctor(project, fix);
      setDetails((d) => ({ ...d, [project]: res }));
      setExpanded((e) => ({ ...e, [project]: true }));
    } catch (err) {
      void alert({
        title: `doctor ${fix ? '修复' : '检查'}失败`,
        body: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setLoading((l) => ({ ...l, [project]: null }));
    }
  };

  const checkAll = async (): Promise<void> => {
    for (const p of projects) {
      await runCheck(p.project, false);
    }
  };

  return (
    <section className="nb-card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold">项目健康检查</h2>
        <button
          className="nb-btn nb-btn-mint"
          style={{ padding: '6px 12px', fontSize: 12 }}
          onClick={() => {
            void checkAll();
          }}
          disabled={projects.length === 0 || Object.values(loading).some(Boolean)}
          type="button"
        >
          <RefreshCw size={12} strokeWidth={2.5} />
          检查全部
        </button>
      </div>
      {projects.length === 0 ? (
        <p className="text-[var(--color-text-muted)] text-sm">还没有项目。</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {projects.map((p) => {
            const det = details[p.project];
            const isLoading = loading[p.project];
            const failCount = det ? det.checks.filter((c) => c.status === 'fail').length : 0;
            const warnCount = det ? det.checks.filter((c) => c.status === 'warn').length : 0;
            const isExpanded = expanded[p.project] ?? false;
            const hasDet = det != null;
            return (
              <li
                key={p.project}
                className="bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded-lg"
              >
                <div className="flex items-center gap-3 px-3 py-2">
                  <button
                    type="button"
                    onClick={() => setExpanded((e) => ({ ...e, [p.project]: !isExpanded }))}
                    disabled={!hasDet}
                    className="flex items-center gap-2 flex-1 text-left min-w-0"
                    aria-label={isExpanded ? '折叠' : '展开'}
                  >
                    {hasDet && det.ok ? (
                      <CheckCircle size={16} className="text-[var(--color-running)] shrink-0" strokeWidth={2.5} />
                    ) : hasDet ? (
                      <AlertCircle size={16} className="text-[var(--color-stuck)] shrink-0" strokeWidth={2.5} />
                    ) : (
                      <CheckCircle size={16} className="text-[var(--color-text-subtle)] shrink-0" strokeWidth={2.5} />
                    )}
                    {hasDet && (isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />)}
                    <span className="font-bold font-[family-name:var(--font-mono)]">{p.project}</span>
                    {hasDet ? (
                      det.ok ? (
                        <span className="text-xs text-[var(--color-running)] font-semibold">OK</span>
                      ) : (
                        <span className="text-xs text-[var(--color-stuck)] font-semibold">
                          {failCount} fail · {warnCount} warn
                        </span>
                      )
                    ) : (
                      <span className="text-xs text-[var(--color-text-muted)]">点 "检查" 运行 sps doctor</span>
                    )}
                  </button>
                  <button
                    className="nb-btn"
                    style={{ padding: '4px 10px', fontSize: 11 }}
                    onClick={() => {
                      void runCheck(p.project, false);
                    }}
                    disabled={!!isLoading}
                    type="button"
                    aria-label="检查"
                  >
                    {isLoading === 'check' ? (
                      <Loader2 size={11} strokeWidth={3} className="animate-spin" />
                    ) : (
                      <RefreshCw size={11} strokeWidth={2.5} />
                    )}
                    检查
                  </button>
                  {hasDet && !det.ok && (
                    <button
                      className="nb-btn nb-btn-primary"
                      style={{ padding: '4px 10px', fontSize: 11 }}
                      onClick={() => {
                        void runCheck(p.project, true);
                      }}
                      disabled={!!isLoading}
                      type="button"
                      aria-label="自动修复"
                    >
                      {isLoading === 'fix' ? (
                        <Loader2 size={11} strokeWidth={3} className="animate-spin" />
                      ) : (
                        <Wrench size={11} strokeWidth={2.5} />
                      )}
                      修复
                    </button>
                  )}
                </div>
                {isExpanded && hasDet && (
                  <div className="border-t-2 border-dashed border-[var(--color-text)] px-3 py-2">
                    <ul className="flex flex-col gap-1 text-xs font-[family-name:var(--font-mono)]">
                      {det.checks.map((c, i) => (
                        <CheckRow key={`${c.name}-${i}`} check={c} />
                      ))}
                    </ul>
                    {det.fixes.length > 0 && (
                      <div className="mt-3 bg-[var(--color-running-bg)] border-2 border-[var(--color-running)] rounded p-2">
                        <div className="text-xs font-bold text-[var(--color-running)] mb-1">已修复</div>
                        <ul className="text-xs list-disc pl-4">
                          {det.fixes.map((f, i) => <li key={i}>{f}</li>)}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CheckRow({ check }: { check: DoctorCheck }) {
  const icon =
    check.status === 'pass' ? <CheckCircle size={12} className="text-[var(--color-running)]" strokeWidth={2.5} /> :
    check.status === 'fail' ? <AlertCircle size={12} className="text-[var(--color-crashed)]" strokeWidth={2.5} /> :
    check.status === 'warn' ? <AlertCircle size={12} className="text-[var(--color-stuck)]" strokeWidth={2.5} /> :
    <span className="w-3 h-3 rounded-full bg-[var(--color-text-subtle)] inline-block" />;
  return (
    <li className="flex items-start gap-2">
      <span className="pt-0.5 shrink-0">{icon}</span>
      <span className="font-bold w-32 shrink-0">{check.name}</span>
      <span className="text-[var(--color-text-muted)] break-words">{check.message}</span>
    </li>
  );
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${m}m ${sec}s` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}
