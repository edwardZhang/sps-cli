import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { ArrowLeft, FolderGit2, Settings, Workflow, Trash2, Save, RefreshCw, Loader2, Check, Edit3, Plus } from 'lucide-react';
import {
  createPipelineFile,
  deletePipelineFile,
  deleteProject,
  getProject,
  getProjectConf,
  listPipelines,
  switchPipeline,
  updateProjectConf,
} from '../../shared/api/projects';
import { useDialog } from '../../shared/components/DialogProvider';
import { PipelineEditor } from './PipelineEditor';
import { NewPipelineDialog } from './NewPipelineDialog';

type Tab = 'overview' | 'config' | 'pipelines' | 'danger';

export function ProjectDetailPage() {
  const { name = '' } = useParams();
  const nav = useNavigate();
  const [tab, setTab] = useState<Tab>('overview');

  const projectQ = useQuery({
    queryKey: ['project', name],
    queryFn: () => getProject(name),
    enabled: !!name,
  });

  return (
    <div className="flex flex-col gap-5 max-w-4xl">
      <header className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => nav('/projects')}
          className="nb-btn"
          style={{ padding: '6px 12px' }}
          aria-label="Back to projects"
        >
          <ArrowLeft size={14} strokeWidth={3} />
          Back
        </button>
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-bold flex-1">
          {name}
        </h1>
        <Link to={`/board?project=${encodeURIComponent(name)}`} className="nb-btn nb-btn-mint">
          Board
        </Link>
      </header>

      <nav className="flex gap-2 flex-wrap">
        <TabBtn current={tab} value="overview" onSelect={setTab} icon={FolderGit2}>Overview</TabBtn>
        <TabBtn current={tab} value="config" onSelect={setTab} icon={Settings}>Config</TabBtn>
        <TabBtn current={tab} value="pipelines" onSelect={setTab} icon={Workflow}>Pipelines</TabBtn>
        <TabBtn current={tab} value="danger" onSelect={setTab} icon={Trash2}>Danger zone</TabBtn>
      </nav>

      {tab === 'overview' && <OverviewTab name={name} data={projectQ.data} loading={projectQ.isLoading} />}
      {tab === 'config' && <ConfigTab name={name} />}
      {tab === 'pipelines' && <PipelinesTab name={name} />}
      {tab === 'danger' && <DangerTab name={name} repoDir={projectQ.data?.repoDir ?? null} />}
    </div>
  );
}

function TabBtn({
  current,
  value,
  onSelect,
  icon: Icon,
  children,
}: {
  current: Tab;
  value: Tab;
  onSelect: (v: Tab) => void;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  children: React.ReactNode;
}) {
  const active = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      aria-current={active ? 'page' : undefined}
      className={[
        'nb-btn',
        active ? 'nb-btn-primary' : '',
      ].join(' ')}
      style={{ padding: '6px 14px', fontSize: 13 }}
    >
      <Icon size={13} strokeWidth={2.5} />
      {children}
    </button>
  );
}

function OverviewTab({
  name,
  data,
  loading,
}: {
  name: string;
  data: ReturnType<typeof useQuery<typeof getProject extends (n: string) => Promise<infer R> ? R : never>>['data'] | undefined;
  loading: boolean;
}) {
  if (loading) {
    return <div className="nb-card"><p className="text-[var(--color-text-muted)]">Loading…</p></div>;
  }
  if (!data) {
    return (
      <div className="nb-card bg-[var(--color-crashed-bg)]">
        <p>Project {name} not found or unreadable.</p>
      </div>
    );
  }
  return (
    <div className="nb-card">
      <dl className="grid grid-cols-[160px_1fr] gap-y-3 text-sm">
        <dt className="font-bold">Repository</dt>
        <dd className="font-[family-name:var(--font-mono)]">{data.repoDir ?? '—'}</dd>
        <dt className="font-bold">PM backend</dt>
        <dd className="font-[family-name:var(--font-mono)]">{data.pmBackend}</dd>
        <dt className="font-bold">Agent</dt>
        <dd className="font-[family-name:var(--font-mono)]">{data.agentProvider}</dd>
        <dt className="font-bold">Cards</dt>
        <dd className="font-[family-name:var(--font-mono)]">
          {data.cards.total} total · {data.cards.inprogress} in progress · {data.cards.done} done
        </dd>
        <dt className="font-bold">Worker</dt>
        <dd className="font-[family-name:var(--font-mono)]">
          {data.workers.total} ({data.workers.active} active)
        </dd>
        <dt className="font-bold">Pipeline</dt>
        <dd className="font-[family-name:var(--font-mono)]">{data.pipelineStatus}</dd>
        <dt className="font-bold">Last activity</dt>
        <dd className="font-[family-name:var(--font-mono)]">
          {data.lastActivityAt ? new Date(data.lastActivityAt).toLocaleString() : '—'}
        </dd>
      </dl>
    </div>
  );
}

function ConfigTab({ name }: { name: string }) {
  const qc = useQueryClient();
  const { alert } = useDialog();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['project-conf', name],
    queryFn: () => getProjectConf(name),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [etag, setEtag] = useState<string | null>(null);

  // v0.49 修复：hydrate from query in useEffect，不在 render 期 setState
  useEffect(() => {
    if (data && draft === null) {
      setDraft(data.content);
      setEtag(data.etag);
    }
  }, [data, draft]);

  const dirty = draft !== null && data !== undefined && draft !== data.content;

  const saveMutation = useMutation({
    mutationFn: () => {
      if (draft === null || etag === null) throw new Error('no draft');
      return updateProjectConf(name, draft, etag);
    },
    onSuccess: (res) => {
      setEtag(res.etag);
      qc.invalidateQueries({ queryKey: ['project-conf', name] });
      qc.invalidateQueries({ queryKey: ['project', name] });
    },
    onError: (err) => {
      const status = (err as Error & { status?: number }).status;
      void alert({
        title: status === 409 ? 'Config was modified elsewhere' : 'Save failed',
        body:
          status === 409
            ? 'The conf file was modified while you were editing. Click "Reload" before editing again.'
            : err instanceof Error ? err.message : String(err),
      });
    },
  });

  if (isLoading) {
    return <div className="nb-card"><p className="text-[var(--color-text-muted)]">Loading…</p></div>;
  }
  if (isError) {
    return (
      <div className="nb-card bg-[var(--color-crashed-bg)]">
        <p>Load failed: {error instanceof Error ? error.message : String(error)}</p>
      </div>
    );
  }

  return (
    <div className="nb-card">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="font-[family-name:var(--font-heading)] text-lg font-bold">
            <code className="font-[family-name:var(--font-mono)] text-sm bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] px-2 py-0.5 rounded">
              ~/.coral/projects/{name}/conf
            </code>
          </h2>
          {etag && (
            <p className="text-xs text-[var(--color-text-muted)] font-[family-name:var(--font-mono)] mt-1">
              etag: {etag}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            className="nb-btn"
            style={{ padding: '6px 12px' }}
            onClick={() => {
              setDraft(null);
              refetch();
            }}
            disabled={saveMutation.isPending}
            aria-label="Reload"
          >
            <RefreshCw size={13} strokeWidth={2.5} />
            Reload
          </button>
          <button
            type="button"
            className="nb-btn nb-btn-primary"
            style={{ padding: '6px 12px' }}
            onClick={() => saveMutation.mutate()}
            disabled={!dirty || saveMutation.isPending}
            aria-label="Save config"
          >
            {saveMutation.isPending ? (
              <Loader2 size={13} strokeWidth={3} className="animate-spin" />
            ) : saveMutation.isSuccess && !dirty ? (
              <Check size={13} strokeWidth={3} />
            ) : (
              <Save size={13} strokeWidth={3} />
            )}
            Save
          </button>
        </div>
      </div>
      <textarea
        className="nb-input w-full font-[family-name:var(--font-mono)] text-xs"
        style={{ minHeight: 480, resize: 'vertical' }}
        value={draft ?? ''}
        onChange={(e) => setDraft(e.target.value)}
        spellCheck={false}
        aria-label="Conf file editor"
      />
      {dirty && (
        <p className="text-xs text-[var(--color-stuck)] mt-2 font-bold">
          ● unsaved changes
        </p>
      )}
    </div>
  );
}

function PipelinesTab({ name }: { name: string }) {
  const qc = useQueryClient();
  const { confirm, alert } = useDialog();
  const { data, isLoading } = useQuery({
    queryKey: ['project-pipelines', name],
    queryFn: () => listPipelines(name),
  });
  const [editingFile, setEditingFile] = useState<string | null>(null);
  const [newDialogOpen, setNewDialogOpen] = useState(false);

  const switchMutation = useMutation({
    mutationFn: (pipeline: string) => switchPipeline(name, pipeline),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-pipelines', name] }),
    onError: (err) => {
      void alert({
        title: 'Switch failed',
        body: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (file: string) => deletePipelineFile(name, file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project-pipelines', name] }),
    onError: (err) => {
      void alert({
        title: 'Delete failed',
        body: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const createMutation = useMutation({
    mutationFn: (args: { name: string; template: 'blank' | 'sample' | 'active' }) =>
      createPipelineFile(name, args.name, args.template),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['project-pipelines', name] });
      setNewDialogOpen(false);
      setEditingFile(res.name); // 新建后直接打开编辑器
    },
    onError: (err) => {
      void alert({
        title: 'Create failed',
        body: err instanceof Error ? err.message : String(err),
      });
    },
  });

  if (isLoading) {
    return <div className="nb-card"><p className="text-[var(--color-text-muted)]">Loading…</p></div>;
  }

  // 合并 active + available 成一个统一列表显示
  const allRows: Array<{ name: string; isActive: boolean }> = [];
  if (data?.active) {
    allRows.push({ name: data.active, isActive: true });
  }
  for (const p of data?.available ?? []) {
    allRows.push({ name: p.name, isActive: false });
  }

  return (
    <>
      <div className="nb-card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-[family-name:var(--font-heading)] text-lg font-bold">
            Pipelines
          </h2>
          <button
            type="button"
            className="nb-btn nb-btn-mint"
            style={{ padding: '6px 12px', fontSize: 12 }}
            onClick={() => setNewDialogOpen(true)}
            disabled={createMutation.isPending}
            aria-label="New pipeline"
          >
            <Plus size={12} strokeWidth={3} />
            New pipeline
          </button>
        </div>

        {allRows.length === 0 ? (
          <p className="text-sm text-[var(--color-text-muted)] italic p-4 border-2 border-dashed border-[var(--color-text)] rounded-lg text-center">
            No pipeline files yet. Click "New pipeline" to start.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {allRows.map((p) => (
              <li
                key={p.name}
                className="flex items-center gap-3 p-3 bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded-lg"
              >
                <Workflow size={16} strokeWidth={2.5} />
                <span className="font-[family-name:var(--font-mono)] font-bold flex-1">
                  {p.name}
                </span>
                {p.isActive && (
                  <span className="nb-status" style={{ background: 'var(--color-running-bg)', color: 'var(--color-running)' }}>
                    active
                  </span>
                )}
                <div className="flex gap-1">
                  <button
                    type="button"
                    className="nb-btn"
                    style={{ padding: '4px 10px', fontSize: 11 }}
                    onClick={() => setEditingFile(p.name)}
                    aria-label={`Edit ${p.name}`}
                  >
                    <Edit3 size={11} strokeWidth={2.5} />
                    Edit
                  </button>
                  {!p.isActive && (
                    <>
                      <button
                        type="button"
                        className="nb-btn nb-btn-primary"
                        style={{ padding: '4px 10px', fontSize: 11 }}
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Switch to ${p.name}`,
                            body: `Current project.yaml will be overwritten with the contents of ${p.name}. Continue?`,
                            confirm: 'Switch',
                          });
                          if (!ok) return;
                          switchMutation.mutate(p.name);
                        }}
                        disabled={switchMutation.isPending}
                        aria-label={`Switch to ${p.name}`}
                      >
                        Switch
                      </button>
                      <button
                        type="button"
                        className="nb-btn nb-btn-danger"
                        style={{ padding: '4px 10px', fontSize: 11 }}
                        onClick={async () => {
                          const ok = await confirm({
                            title: `Delete ${p.name}`,
                            body: 'This pipeline file will be permanently deleted.',
                            confirm: 'Delete',
                            danger: true,
                          });
                          if (!ok) return;
                          deleteMutation.mutate(p.name);
                        }}
                        disabled={deleteMutation.isPending}
                        aria-label={`Delete ${p.name}`}
                      >
                        <Trash2 size={11} strokeWidth={2.5} />
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      {editingFile && (
        <PipelineEditor
          projectName={name}
          file={editingFile}
          onClose={() => setEditingFile(null)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['project-pipelines', name] });
          }}
        />
      )}

      {newDialogOpen && (
        <NewPipelineDialog
          hasActive={!!data?.active}
          hasSample={true /* 假定 init 时总会创建 */}
          isPending={createMutation.isPending}
          onCancel={() => setNewDialogOpen(false)}
          onCreate={(n, t) => createMutation.mutate({ name: n, template: t })}
        />
      )}
    </>
  );
}

function DangerTab({ name, repoDir }: { name: string; repoDir: string | null }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const { alert } = useDialog();
  const [confirmName, setConfirmName] = useState('');
  const [includeClaude, setIncludeClaude] = useState(true);

  const deleteMutation = useMutation({
    mutationFn: () => deleteProject(name, { includeClaudeDir: includeClaude }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      const removed = result.claudeRemoved.filter((r) => r.ok).map((r) => r.path);
      void alert({
        title: 'Deleted',
        body:
          removed.length > 0
            ? `Project deleted. Also cleaned up:\n${removed.join('\n')}`
            : 'Project deleted.',
      }).then(() => nav('/projects'));
    },
    onError: (err) => {
      void alert({
        title: 'Delete failed',
        body: err instanceof Error ? err.message : String(err),
      });
    },
  });

  return (
    <div className="nb-card bg-[var(--color-crashed-bg)]">
      <h2 className="font-[family-name:var(--font-heading)] text-lg font-bold mb-2 text-[var(--color-crashed)]">
        Delete project
      </h2>
      <p className="text-sm mb-4">
        This will clean up <code className="font-[family-name:var(--font-mono)] bg-[var(--color-bg)] border-2 border-[var(--color-text)] px-1.5 py-0.5 rounded">~/.coral/projects/{name}/</code>(including all cards, runtime, logs).
      </p>

      {repoDir && (
        <label className="flex items-start gap-2 mb-4 p-3 bg-[var(--color-bg)] border-2 border-[var(--color-text)] rounded-lg cursor-pointer">
          <input
            type="checkbox"
            checked={includeClaude}
            onChange={(e) => setIncludeClaude(e.target.checked)}
            className="mt-0.5"
          />
          <div className="flex-1">
            <div className="text-sm font-bold">Also clean up the repo's .claude/</div>
            <div className="text-xs text-[var(--color-text-muted)] font-[family-name:var(--font-mono)]">
              {repoDir}/.claude/
            </div>
            <div className="text-xs text-[var(--color-text-muted)] mt-1">
              The repo itself is untouched; only this directory is cleaned.
            </div>
          </div>
        </label>
      )}

      <div className="mb-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-bold">
            Type the project name <code className="font-[family-name:var(--font-mono)] text-xs">{name}</code> to confirm:
          </span>
          <input
            type="text"
            className="nb-input w-full font-[family-name:var(--font-mono)]"
            value={confirmName}
            onChange={(e) => setConfirmName(e.target.value)}
            placeholder={name}
          />
        </label>
      </div>

      <button
        type="button"
        className="nb-btn nb-btn-danger"
        disabled={confirmName !== name || deleteMutation.isPending}
        onClick={() => deleteMutation.mutate()}
        aria-label="Permanently delete project"
      >
        {deleteMutation.isPending ? (
          <Loader2 size={14} strokeWidth={3} className="animate-spin" />
        ) : (
          <Trash2 size={14} strokeWidth={3} />
        )}
        Permanently delete
      </button>
    </div>
  );
}
