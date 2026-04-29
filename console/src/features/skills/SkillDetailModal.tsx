import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Link as LinkIcon, Snowflake, Flame, ChevronRight, FileText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import {
  getSkill,
  getSkillReference,
  linkSkill,
  unlinkSkill,
  freezeSkill,
  unfreezeSkill,
} from '../../shared/api/skills';
import { useDialog } from '../../shared/components/DialogProvider';

export function SkillDetailModal({
  name,
  projects,
  onClose,
  onChange,
}: {
  name: string;
  projects: string[];
  onClose: () => void;
  onChange: () => void;
}) {
  const { confirm, alert } = useDialog();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['skill', name],
    queryFn: () => getSkill(name),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // v0.50.21：所有操作包 try/catch + alert，否则 async onClick 抛错会被 React 吞，
  // 用户看到的效果就是"点了没反应"。
  const runAction = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      await refetch();
      onChange();
    } catch (err) {
      void alert({
        title: `${label} failed`,
        body: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleLink = (project: string): Promise<void> =>
    runAction('link', () => linkSkill(name, project));

  const handleUnlink = async (project: string): Promise<void> => {
    const ok = await confirm({
      title: `Remove ${name} from ${project}`,
      body: 'The skill link will be removed; this project will no longer load the skill on future runs.',
      confirm: 'Remove',
      danger: true,
    });
    if (!ok) return;
    await runAction('unlink', () => unlinkSkill(name, project));
  };

  const handleFreeze = (project: string): Promise<void> =>
    runAction('freeze', () => freezeSkill(name, project));

  const handleUnfreeze = async (project: string): Promise<void> => {
    const ok = await confirm({
      title: `Unfreeze ${name} @ ${project}`,
      body: 'Local edits to this skill will be overwritten; it returns to the latest shared version.',
      confirm: 'Unfreeze',
      danger: true,
    });
    if (!ok) return;
    await runAction('unfreeze', () => unfreezeSkill(name, project));
  };

  const stateMap = new Map((data?.linkedProjects ?? []).map((p) => [p.project, p.state]));

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-start justify-center p-6 bg-black/30 overflow-auto"
    >
      <div className="nb-card mt-8 w-full max-w-4xl">
        <header className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="font-[family-name:var(--font-heading)] text-3xl font-bold">
              {name}
            </h2>
            {data && (
              <p className="text-sm text-[var(--color-text-muted)] mt-1">
                {data.category} · {data.origin || 'local'}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="nb-btn nb-btn-mint p-2"
            aria-label="Close"
            type="button"
          >
            <X size={16} strokeWidth={3} />
          </button>
        </header>

        {isLoading && <p>Loading…</p>}
        {isError && (
          <p className="text-[var(--color-crashed)]">
            Load failed: {error instanceof Error ? error.message : String(error)}
          </p>
        )}

        {data && (
          <div className="flex flex-col gap-4">
            <div className="nb-card bg-[var(--color-bg-cream)] p-4">
              <h3 className="font-[family-name:var(--font-heading)] text-sm font-bold mb-3 uppercase tracking-wider">
                Project link status
              </h3>
              <div className="flex flex-col gap-2">
                {projects.map((proj) => {
                  const state = stateMap.get(proj);
                  return (
                    <div
                      key={proj}
                      className="flex items-center justify-between gap-3 p-2 bg-[var(--color-bg)] border-2 border-[var(--color-text)] rounded-lg"
                    >
                      <div className="flex items-center gap-3">
                        <span className="font-[family-name:var(--font-mono)] font-bold text-sm">
                          {proj}
                        </span>
                        {state === 'linked' && (
                          <span className="nb-status" style={{ background: 'var(--color-running-bg)', color: 'var(--color-running)' }}>
                            linked
                          </span>
                        )}
                        {state === 'frozen' && (
                          <span className="nb-status" style={{ background: 'var(--color-stuck-bg)', color: 'var(--color-stuck)' }}>
                            frozen
                          </span>
                        )}
                        {!state && (
                          <span className="nb-status" style={{ background: 'var(--color-idle-bg)', color: 'var(--color-idle)' }}>
                            absent
                          </span>
                        )}
                      </div>
                      <div className="flex gap-2">
                        {!state && (
                          <button
                            className="nb-btn nb-btn-primary"
                            style={{ padding: '4px 10px', fontSize: 11 }}
                            onClick={() => handleLink(proj)}
                            type="button"
                          >
                            <LinkIcon size={11} /> link
                          </button>
                        )}
                        {state === 'linked' && (
                          <>
                            <button
                              className="nb-btn"
                              style={{ padding: '4px 10px', fontSize: 11 }}
                              onClick={() => handleFreeze(proj)}
                              type="button"
                            >
                              <Snowflake size={11} /> freeze
                            </button>
                            <button
                              className="nb-btn nb-btn-danger"
                              style={{ padding: '4px 10px', fontSize: 11 }}
                              onClick={() => handleUnlink(proj)}
                              type="button"
                            >
                              unlink
                            </button>
                          </>
                        )}
                        {state === 'frozen' && (
                          <>
                            <button
                              className="nb-btn"
                              style={{ padding: '4px 10px', fontSize: 11 }}
                              onClick={() => handleUnfreeze(proj)}
                              type="button"
                            >
                              <Flame size={11} /> unfreeze
                            </button>
                            <button
                              className="nb-btn nb-btn-danger"
                              style={{ padding: '4px 10px', fontSize: 11 }}
                              onClick={() => handleUnlink(proj)}
                              type="button"
                            >
                              unlink
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
                {projects.length === 0 && (
                  <p className="text-sm text-[var(--color-text-muted)] italic">
                    No projects yet. Create one first.
                  </p>
                )}
              </div>
            </div>

            <div>
              <h3 className="font-[family-name:var(--font-heading)] text-sm font-bold mb-2 uppercase tracking-wider">
                SKILL.md preview
              </h3>
              <div className="prose-chat bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded-lg p-4 max-h-80 overflow-auto text-sm">
                {data.body ? (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[rehypeHighlight]}
                  >
                    {data.body}
                  </ReactMarkdown>
                ) : (
                  <p className="text-[var(--color-text-muted)] italic">(empty)</p>
                )}
              </div>
            </div>

            {data.references.length > 0 && (
              <div>
                <h3 className="font-[family-name:var(--font-heading)] text-sm font-bold mb-2 uppercase tracking-wider">
                  References
                </h3>
                <ul className="flex flex-col gap-2">
                  {data.references.map((r) => (
                    <ReferenceRow key={r.name} skillName={name} file={r.name} lines={r.lines} />
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ReferenceRow({
  skillName,
  file,
  lines,
}: {
  skillName: string;
  file: string;
  lines: number;
}) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['skill-ref', skillName, file],
    queryFn: () => getSkillReference(skillName, file),
    enabled: open,
    staleTime: Infinity,
  });
  return (
    <li className="border-2 border-[var(--color-text)] rounded-lg overflow-hidden bg-[var(--color-bg-cream)]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${file}`}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-sm font-[family-name:var(--font-mono)] hover:bg-[var(--color-accent-yellow)] transition-colors"
      >
        <ChevronRight
          size={12}
          strokeWidth={3}
          className={['transition-transform', open ? 'rotate-90' : ''].join(' ')}
        />
        <FileText size={12} strokeWidth={2.5} />
        <span className="flex-1 text-left font-bold">{file}</span>
        <span className="text-xs text-[var(--color-text-subtle)]">{lines} lines</span>
      </button>
      {open && (
        <div className="px-4 py-3 border-t-2 border-[var(--color-text)] bg-[var(--color-bg)] max-h-96 overflow-auto">
          {isLoading && <p className="text-xs text-[var(--color-text-muted)]">加载中…</p>}
          {isError && (
            <p className="text-xs text-[var(--color-crashed)]">
              Load failed: {error instanceof Error ? error.message : String(error)}
            </p>
          )}
          {data && (
            <div className="prose-chat text-sm">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
              >
                {data.content}
              </ReactMarkdown>
            </div>
          )}
        </div>
      )}
    </li>
  );
}
