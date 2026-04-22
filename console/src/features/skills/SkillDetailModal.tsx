import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, Link as LinkIcon, Snowflake, Flame } from 'lucide-react';
import {
  getSkill,
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
  const { confirm } = useDialog();
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

  const handleLink = async (project: string): Promise<void> => {
    await linkSkill(name, project);
    refetch();
    onChange();
  };
  const handleUnlink = async (project: string): Promise<void> => {
    const ok = await confirm({
      title: `从 ${project} 移除 ${name}`,
      body: 'skill 链接会被解除，项目后续运行时将无法使用该 skill。',
      confirm: '移除',
      danger: true,
    });
    if (!ok) return;
    await unlinkSkill(name, project);
    refetch();
    onChange();
  };
  const handleFreeze = async (project: string): Promise<void> => {
    await freezeSkill(name, project);
    refetch();
    onChange();
  };
  const handleUnfreeze = async (project: string): Promise<void> => {
    const ok = await confirm({
      title: `解冻 ${name} @ ${project}`,
      body: '本地对这个 skill 的改动会被覆盖，回到最新共享版本。',
      confirm: '解冻',
      danger: true,
    });
    if (!ok) return;
    await unfreezeSkill(name, project);
    refetch();
    onChange();
  };

  const stateMap = new Map((data?.linkedProjects ?? []).map((p) => [p.project, p.state]));

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-start justify-center p-6 bg-black/30 overflow-auto"
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} className="nb-card mt-8 w-full max-w-4xl">
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
            aria-label="关闭"
            type="button"
          >
            <X size={16} strokeWidth={3} />
          </button>
        </header>

        {isLoading && <p>加载中…</p>}
        {isError && (
          <p className="text-[var(--color-crashed)]">
            加载失败: {error instanceof Error ? error.message : String(error)}
          </p>
        )}

        {data && (
          <div className="flex flex-col gap-4">
            <div className="nb-card bg-[var(--color-bg-cream)] p-4">
              <h3 className="font-[family-name:var(--font-heading)] text-sm font-bold mb-3 uppercase tracking-wider">
                项目链接状态
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
                    还没有任何项目。先去创建一个项目。
                  </p>
                )}
              </div>
            </div>

            <div>
              <h3 className="font-[family-name:var(--font-heading)] text-sm font-bold mb-2 uppercase tracking-wider">
                SKILL.md 预览
              </h3>
              <pre className="text-xs whitespace-pre-wrap font-[family-name:var(--font-mono)] bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded-lg p-4 max-h-80 overflow-auto">
                {data.body || '(empty)'}
              </pre>
            </div>

            {data.references.length > 0 && (
              <div>
                <h3 className="font-[family-name:var(--font-heading)] text-sm font-bold mb-2 uppercase tracking-wider">
                  References
                </h3>
                <ul className="text-sm space-y-1 font-[family-name:var(--font-mono)]">
                  {data.references.map((r) => (
                    <li key={r.name} className="flex items-center gap-3">
                      <span>{r.name}</span>
                      <span className="text-xs text-[var(--color-text-subtle)]">
                        {r.lines} lines
                      </span>
                    </li>
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
