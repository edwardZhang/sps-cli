import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation('system');
  const infoQ = useQuery({ queryKey: ['system-info'], queryFn: getSystemInfo });
  const envQ = useQuery({ queryKey: ['system-env'], queryFn: getEnv });
  const [editingEnv, setEditingEnv] = useState(false);

  return (
    <div className="flex flex-col gap-6 max-w-4xl">
      <header>
        <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold">{t('title')}</h1>
      </header>

      <VersionSection current={infoQ.data?.version} />

      <section className="nb-card">
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold mb-3">
          {t('runtime')}
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
          <p className="text-[var(--color-text-muted)]">{t('loading')}</p>
        )}
      </section>

      <section className="nb-card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold">
            {t('envSection')}<code className="text-sm font-[family-name:var(--font-mono)] font-normal bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] px-2 py-0.5 rounded">~/.coral/env</code>
          </h2>
          {!editingEnv ? (
            <button
              className="nb-btn"
              style={{ padding: '6px 12px', fontSize: 12 }}
              onClick={() => setEditingEnv(true)}
              type="button"
              aria-label={t('envEditAria')}
            >
              <Edit3 size={12} strokeWidth={2.5} /> {t('envEdit')}
            </button>
          ) : (
            <span className="text-xs text-[var(--color-stuck)] font-bold">{t('envEditing')}</span>
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
            {t('envMissing')}<code className="bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] px-2 py-0.5 rounded font-[family-name:var(--font-mono)]">sps setup</code>
          </p>
        )}
      </section>

      <DoctorSection />
    </div>
  );
}

function VersionSection({ current }: { current?: string }) {
  const { t } = useTranslation('system');
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
      title: t('upgradeTitle'),
      body: t('upgradeBody', { current, latest: latestQ.data?.latest }),
      confirm: t('upgradeConfirm'),
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
          title: t('upgradeDoneTitle'),
          body: t('upgradeDoneBody', { version: res.installedVersion }),
        });
      } else {
        const reason = res.installedVersion && res.installedVersion === current
          ? t('upgradeIneffectiveSameVersion', { version: res.installedVersion })
          : t('upgradeIneffectiveNoInstall');
        void alert({ title: t('upgradeIneffectiveTitle'), body: reason });
      }
    } catch (err) {
      setUpgradeLog((err as Error).message);
      void alert({ title: t('upgradeFailed'), body: (err as Error).message });
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
      void alert({ title: t('cmdCopiedTitle'), body: t('cmdCopiedBody', { cmd }) });
    } catch {
      void alert({ title: t('copyFailedTitle'), body: t('copyFailedBody', { cmd }) });
    }
  };

  return (
    <section className="nb-card">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold">
          {t('version')}
        </h2>
        <button
          className="nb-btn"
          style={{ padding: '6px 12px', fontSize: 12 }}
          onClick={() => latestQ.refetch()}
          disabled={latestQ.isFetching || !current}
          type="button"
          aria-label={t('checkUpdateAria')}
        >
          {latestQ.isFetching ? (
            <Loader2 size={12} strokeWidth={3} className="animate-spin" />
          ) : (
            <RefreshCw size={12} strokeWidth={2.5} />
          )}
          {t('checkUpdate')}
        </button>
      </div>
      <dl className="grid grid-cols-[160px_1fr] gap-y-2 text-sm">
        <dt className="font-bold">{t('spsCliCurrent')}</dt>
        <dd className="font-[family-name:var(--font-mono)]">{current ?? '—'}</dd>
        {latestQ.data && (
          <>
            <dt className="font-bold">{t('npmLatest')}</dt>
            <dd className="font-[family-name:var(--font-mono)] flex items-center gap-2 flex-wrap">
              {latestQ.data.latest}
              {latestQ.data.upToDate ? (
                <span className="nb-status" style={{ background: 'var(--color-running-bg)', color: 'var(--color-running)' }}>
                  {t('latestBadge')}
                </span>
              ) : (
                <>
                  <button
                    className="nb-btn nb-btn-primary"
                    style={{ padding: '3px 10px', fontSize: 11 }}
                    onClick={handleUpgrade}
                    disabled={upgrading}
                    type="button"
                    aria-label={t('upgradeAria')}
                  >
                    {upgrading ? (
                      <Loader2 size={11} strokeWidth={3} className="animate-spin" />
                    ) : (
                      <Download size={11} strokeWidth={2.5} />
                    )}
                    {t('upgrade')}
                  </button>
                  <button
                    className="nb-btn"
                    style={{ padding: '3px 10px', fontSize: 11 }}
                    onClick={handleCopyCommand}
                    type="button"
                    aria-label={t('copyCmdAria')}
                    title={t('copyCmdTitle')}
                  >
                    <Copy size={11} strokeWidth={2.5} /> {t('copyCmd')}
                  </button>
                </>
              )}
            </dd>
          </>
        )}
        {installedVersion && (
          <>
            <dt className="font-bold">{t('installed')}</dt>
            <dd className="font-[family-name:var(--font-mono)] flex items-center gap-2">
              {installedVersion}
              {installedVersion === latestQ.data?.latest ? (
                <span className="nb-status" style={{ background: 'var(--color-running-bg)', color: 'var(--color-running)' }}>
                  {t('installedActive')}
                </span>
              ) : installedVersion === current ? (
                <span className="nb-status" style={{ background: 'var(--color-stuck-bg)', color: 'var(--color-stuck)' }}>
                  {t('installedFailed')}
                </span>
              ) : null}
            </dd>
          </>
        )}
        {latestQ.isError && (
          <>
            <dt className="font-bold">{t('checkLabel')}</dt>
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
  const { t } = useTranslation('system');
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
        title: status === 409 ? t('envEtagConflict') : t('envSaveFailed'),
        body:
          status === 409
            ? t('envEtagBody')
            : err instanceof Error ? err.message : String(err),
      });
    },
  });

  if (rawQ.isLoading) {
    return <p className="text-[var(--color-text-muted)]">{t('loading')}</p>;
  }

  return (
    <div>
      <p className="text-xs text-[var(--color-stuck)] font-bold mb-2">
        {t('envWarn')}
      </p>
      <textarea
        className="nb-input w-full font-[family-name:var(--font-mono)] text-xs"
        style={{ minHeight: 320, resize: 'vertical' }}
        value={draft ?? ''}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        aria-label={t('envEditorAria')}
      />
      <div className="flex items-center justify-between mt-3">
        <span className="text-xs text-[var(--color-text-muted)] font-[family-name:var(--font-mono)]">
          {etag ? `etag: ${etag}` : ''}
          {dirty ? t('envUnsaved') : ''}
        </span>
        <div className="flex gap-2">
          <button
            className="nb-btn"
            style={{ padding: '6px 12px' }}
            onClick={onClose}
            disabled={saveMutation.isPending}
            type="button"
          >
            <X size={12} strokeWidth={3} /> {t('envCancel')}
          </button>
          <button
            className="nb-btn nb-btn-primary"
            style={{ padding: '6px 12px' }}
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending}
            type="button"
            aria-label={t('envSaveAria')}
          >
            {saveMutation.isPending ? (
              <Loader2 size={12} strokeWidth={3} className="animate-spin" />
            ) : (
              <Save size={12} strokeWidth={3} />
            )}
            {t('envSave')}
          </button>
        </div>
      </div>
    </div>
  );
}

// v0.50.14：真实 doctor 替代原 shallow doctorAll
// v0.50.17：warm-load 改走 /api/projects（不再有单独的 shallow doctor 路径）
function DoctorSection() {
  const { t } = useTranslation('system');
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
        title: t('doctor.doctorActionFailed', { action: fix ? t('doctor.actionFix') : t('doctor.actionCheck') }),
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
        <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold">{t('doctor.title')}</h2>
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
          {t('doctor.checkAll')}
        </button>
      </div>
      {projects.length === 0 ? (
        <p className="text-[var(--color-text-muted)] text-sm">{t('doctor.noProjects')}</p>
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
                    aria-label={isExpanded ? t('doctor.collapse') : t('doctor.expand')}
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
                      <span className="text-xs text-[var(--color-text-muted)]">{t('doctor.clickCheck')}</span>
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
                    aria-label={t('doctor.checkAria')}
                  >
                    {isLoading === 'check' ? (
                      <Loader2 size={11} strokeWidth={3} className="animate-spin" />
                    ) : (
                      <RefreshCw size={11} strokeWidth={2.5} />
                    )}
                    {t('doctor.check')}
                  </button>
                  {/* v0.50.22：修复按钮总是可见——老项目从没 check 过也能直接修。
                      sps doctor --fix 是幂等的：没问题时 noop，有问题才动手。
                      仅在已经 check 过且完全 OK 时禁用（显性提示无事可做）。 */}
                  <button
                    className="nb-btn nb-btn-primary"
                    style={{ padding: '4px 10px', fontSize: 11 }}
                    onClick={() => {
                      void runCheck(p.project, true);
                    }}
                    disabled={!!isLoading || (hasDet && det.ok)}
                    type="button"
                    aria-label={t('doctor.fixAria')}
                    title={
                      hasDet && det.ok
                        ? t('doctor.fixNothing')
                        : t('doctor.fixHint')
                    }
                  >
                    {isLoading === 'fix' ? (
                      <Loader2 size={11} strokeWidth={3} className="animate-spin" />
                    ) : (
                      <Wrench size={11} strokeWidth={2.5} />
                    )}
                    {t('doctor.fix')}
                  </button>
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
                        <div className="text-xs font-bold text-[var(--color-running)] mb-1">{t('doctor.fixed')}</div>
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
