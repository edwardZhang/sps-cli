import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Play, RotateCcw, GitBranch, Edit3, Save, Loader2, Plus } from 'lucide-react';
import {
  getCard,
  launchCard,
  resetCard,
  updateCard,
} from '../../shared/api/cards';
import { listSkills } from '../../shared/api/skills';
import { SkillBadge, LabelBadge } from '../../shared/components/Badges';
import { useDialog } from '../../shared/components/DialogProvider';

/** 从 body 里抽出 "## 描述" 段的内容（用于编辑态 textarea 初始值）。 */
function extractDescription(body: string): string {
  const lines = body.split('\n');
  const descIdx = lines.findIndex((l) => /^##\s+描述\s*$/.test(l));
  if (descIdx === -1) return '';
  let nextIdx = lines.length;
  for (let i = descIdx + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i] ?? '')) { nextIdx = i; break; }
  }
  return lines.slice(descIdx + 1, nextIdx).join('\n').trim();
}

export function CardDetailModal({
  project,
  seq,
  onClose,
  onChanged,
}: {
  project: string;
  seq: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const qc = useQueryClient();
  const { confirm, alert } = useDialog();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['card', project, seq],
    queryFn: () => getCard(project, seq),
  });

  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState('');
  const [draftDesc, setDraftDesc] = useState('');
  const [draftSkills, setDraftSkills] = useState<Set<string>>(new Set());
  const [draftLabels, setDraftLabels] = useState<string[]>([]);
  const [newLabelInput, setNewLabelInput] = useState('');

  const skillsQ = useQuery({
    queryKey: ['skills-all', project],
    queryFn: () => listSkills(project),
    enabled: editing, // 只在编辑时才拉
  });

  // Hydrate drafts from server data whenever we enter edit mode or data changes while editing
  useEffect(() => {
    if (editing && data) {
      setDraftTitle(data.title);
      setDraftDesc(extractDescription(data.body));
      setDraftSkills(new Set(data.skills));
      setDraftLabels([...data.labels]);
    }
  }, [editing, data]);

  // Escape 关闭或取消编辑
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        if (editing) setEditing(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, editing]);

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!data) throw new Error('no data');
      // Only send changed fields
      const patch: { title?: string; description?: string; skills?: string[]; labels?: string[] } = {};
      const trimmedTitle = draftTitle.trim();
      if (trimmedTitle && trimmedTitle !== data.title) patch.title = trimmedTitle;
      const currentDesc = extractDescription(data.body);
      if (draftDesc !== currentDesc) patch.description = draftDesc;
      const newSkills = [...draftSkills].sort();
      const curSkills = [...data.skills].sort();
      if (JSON.stringify(newSkills) !== JSON.stringify(curSkills)) patch.skills = newSkills;
      if (JSON.stringify(draftLabels) !== JSON.stringify(data.labels)) patch.labels = draftLabels;
      if (Object.keys(patch).length === 0) {
        return Promise.resolve({ ok: true, noop: true });
      }
      return updateCard(project, seq, patch);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['card', project, seq] });
      qc.invalidateQueries({ queryKey: ['cards', project] });
      setEditing(false);
      onChanged();
    },
    onError: (err) => {
      void alert({
        title: '保存失败',
        body: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const dirty = useMemo(() => {
    if (!editing || !data) return false;
    if (draftTitle.trim() !== data.title) return true;
    if (draftDesc !== extractDescription(data.body)) return true;
    const a = [...draftSkills].sort();
    const b = [...data.skills].sort();
    if (JSON.stringify(a) !== JSON.stringify(b)) return true;
    if (JSON.stringify(draftLabels) !== JSON.stringify(data.labels)) return true;
    return false;
  }, [editing, data, draftTitle, draftDesc, draftSkills, draftLabels]);

  const toggleSkill = (name: string): void => {
    const next = new Set(draftSkills);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setDraftSkills(next);
  };

  const addLabel = (): void => {
    const l = newLabelInput.trim();
    if (!l) return;
    if (draftLabels.includes(l)) { setNewLabelInput(''); return; }
    setDraftLabels([...draftLabels, l]);
    setNewLabelInput('');
  };

  const removeLabel = (l: string): void => {
    setDraftLabels(draftLabels.filter((x) => x !== l));
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="card-modal-title"
      className="fixed inset-0 z-40 flex items-start justify-center p-6 bg-black/30 overflow-auto"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="nb-card mt-12 w-full max-w-3xl bg-[var(--color-bg)]"
      >
        <header className="flex items-start justify-between gap-4 mb-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-1">
              <span className="font-[family-name:var(--font-mono)] font-bold text-xs px-2 py-0.5 bg-[var(--color-accent-purple)] border-2 border-[var(--color-text)] rounded-full">
                #{seq}
              </span>
              {data?.state && (
                <span className="font-[family-name:var(--font-mono)] text-xs px-2 py-0.5 bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded-full font-semibold">
                  {data.state}
                </span>
              )}
              {editing && (
                <span className="text-xs font-bold text-[var(--color-stuck)]">⚠ 编辑中</span>
              )}
            </div>
            {!editing ? (
              <h2 id="card-modal-title" className="font-[family-name:var(--font-heading)] text-2xl font-bold break-words">
                {data?.title ?? '加载中…'}
              </h2>
            ) : (
              <input
                type="text"
                className="nb-input w-full font-[family-name:var(--font-heading)] text-xl font-bold"
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                maxLength={200}
                aria-label="卡片标题"
              />
            )}
          </div>
          <div className="flex gap-2 flex-shrink-0">
            {!editing && data && (
              <button
                onClick={() => setEditing(true)}
                className="nb-btn"
                style={{ padding: '6px 12px' }}
                type="button"
                aria-label="编辑卡片"
              >
                <Edit3 size={12} strokeWidth={2.5} /> 编辑
              </button>
            )}
            <button
              onClick={onClose}
              className="nb-btn nb-btn-mint p-2"
              aria-label="关闭"
              type="button"
            >
              <X size={14} strokeWidth={3} />
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
            {data.branch && !editing && (
              <div className="flex items-center gap-2 text-sm">
                <GitBranch size={14} />
                <span className="font-[family-name:var(--font-mono)]">{data.branch}</span>
              </div>
            )}

            {/* Skills */}
            {!editing ? (
              (data.skills.length > 0 || data.labels.length > 0) && (
                <div className="flex items-center gap-2 flex-wrap">
                  {data.skills.map((s) => <SkillBadge key={s} name={s} />)}
                  {data.labels.map((l) => (
                    <LabelBadge key={l} label={l} kind={l === 'NEEDS-FIX' ? 'warn' : 'default'} />
                  ))}
                </div>
              )
            ) : (
              <>
                <div>
                  <div className="text-sm font-bold mb-1.5">Skills</div>
                  {skillsQ.isLoading && (
                    <p className="text-xs text-[var(--color-text-muted)] italic">加载 skill 列表…</p>
                  )}
                  {skillsQ.data && skillsQ.data.data.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {skillsQ.data.data.map((s) => {
                        const checked = draftSkills.has(s.name);
                        return (
                          <button
                            key={s.name}
                            type="button"
                            onClick={() => toggleSkill(s.name)}
                            aria-pressed={checked}
                            className={[
                              'px-2.5 py-1 text-xs font-[family-name:var(--font-mono)] rounded-full border-2 transition-all',
                              checked
                                ? 'bg-[var(--color-accent-mint)] border-[var(--color-text)] shadow-[2px_2px_0_var(--color-text)] font-bold'
                                : 'bg-[var(--color-bg)] border-[var(--color-border-light)] hover:border-[var(--color-text)]',
                            ].join(' ')}
                          >
                            {s.name}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Labels — free-form chip input */}
                <div>
                  <div className="text-sm font-bold mb-1.5">Labels</div>
                  <div className="flex flex-wrap gap-1.5 items-center">
                    {draftLabels.map((l) => (
                      <span
                        key={l}
                        className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-[family-name:var(--font-mono)] bg-[var(--color-accent-yellow)] border-2 border-[var(--color-text)] rounded-full"
                      >
                        {l}
                        <button
                          type="button"
                          onClick={() => removeLabel(l)}
                          className="hover:text-[var(--color-crashed)]"
                          aria-label={`删除 ${l}`}
                        >
                          <X size={10} strokeWidth={3} />
                        </button>
                      </span>
                    ))}
                    <input
                      type="text"
                      className="nb-input"
                      style={{ padding: '4px 8px', fontSize: 12, width: 140 }}
                      placeholder="+ 添加 label"
                      value={newLabelInput}
                      onChange={(e) => setNewLabelInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          addLabel();
                        }
                      }}
                    />
                    {newLabelInput && (
                      <button
                        type="button"
                        className="nb-btn"
                        style={{ padding: '2px 6px', fontSize: 11 }}
                        onClick={addLabel}
                        aria-label="添加 label"
                      >
                        <Plus size={10} strokeWidth={3} />
                      </button>
                    )}
                  </div>
                  <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                    注意：AI-PIPELINE / STARTED-* / COMPLETED-* / NEEDS-FIX 由流水线自动管理，手动改可能被覆盖
                  </p>
                </div>
              </>
            )}

            {/* Checklist — read-only always (CLI 管理) */}
            {data.checklist.total > 0 && (
              <div className="nb-card bg-[var(--color-bg-cream)] p-3">
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold text-sm">
                    检查清单 {data.checklist.done}/{data.checklist.total}
                  </span>
                  <div className="w-24 h-2 bg-[var(--color-bg)] border-2 border-[var(--color-text)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[var(--color-cta)]"
                      style={{ width: `${data.checklist.percent}%` }}
                    />
                  </div>
                </div>
                <ul className="text-sm space-y-1">
                  {data.checklist.items.map((item, i) => (
                    <li key={i} className={`flex items-start gap-2 ${item.done ? 'opacity-60 line-through' : ''}`}>
                      <span>{item.done ? '✓' : '○'}</span>
                      <span>{item.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Description */}
            {!editing ? (
              data.body && (
                <div>
                  <h3 className="font-[family-name:var(--font-heading)] text-sm font-bold mb-2 uppercase tracking-wider">
                    正文
                  </h3>
                  <pre className="text-xs whitespace-pre-wrap font-[family-name:var(--font-mono)] bg-[var(--color-bg-cream)] border-2 border-[var(--color-text)] rounded-lg p-4 max-h-64 overflow-auto">
                    {data.body.trim() || '（空）'}
                  </pre>
                </div>
              )
            ) : (
              <div>
                <h3 className="font-[family-name:var(--font-heading)] text-sm font-bold mb-2 uppercase tracking-wider">
                  描述
                </h3>
                <textarea
                  className="nb-input w-full font-[family-name:var(--font-mono)] text-xs"
                  style={{ minHeight: 180, resize: 'vertical' }}
                  value={draftDesc}
                  onChange={(e) => setDraftDesc(e.target.value)}
                  aria-label="卡片描述"
                />
                <p className="text-[10px] text-[var(--color-text-muted)] mt-1">
                  只替换 "## 描述" 段的内容；检查清单和日志段不动。
                </p>
              </div>
            )}

            {/* Action bar */}
            <div className="flex gap-2 pt-2 border-t-2 border-[var(--color-border-light)] justify-end">
              {!editing ? (
                <>
                  <button
                    className="nb-btn nb-btn-primary"
                    type="button"
                    onClick={async () => {
                      try {
                        await launchCard(project, seq);
                        onChanged();
                      } catch (err) {
                        void alert({
                          title: '启动 worker 失败',
                          body: err instanceof Error ? err.message : String(err),
                        });
                      }
                    }}
                  >
                    <Play size={14} strokeWidth={3} />
                    启动 worker
                  </button>
                  <button
                    className="nb-btn nb-btn-yellow"
                    type="button"
                    onClick={async () => {
                      const ok = await confirm({
                        title: `重置卡片 #${seq}`,
                        body: '卡片状态会回到初始，已做的 checklist 会清空。',
                        confirm: '重置',
                        danger: true,
                      });
                      if (!ok) return;
                      try {
                        await resetCard(project, seq);
                        onChanged();
                        onClose();
                      } catch (err) {
                        void alert({
                          title: '重置失败',
                          body: err instanceof Error ? err.message : String(err),
                        });
                      }
                    }}
                  >
                    <RotateCcw size={14} strokeWidth={2.5} />
                    重置卡片
                  </button>
                </>
              ) : (
                <>
                  <button
                    className="nb-btn"
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      refetch();
                    }}
                    disabled={saveMutation.isPending}
                  >
                    取消
                  </button>
                  <button
                    className="nb-btn nb-btn-primary"
                    type="button"
                    onClick={() => saveMutation.mutate()}
                    disabled={!dirty || !draftTitle.trim() || saveMutation.isPending}
                    aria-label="保存卡片修改"
                  >
                    {saveMutation.isPending ? (
                      <Loader2 size={14} strokeWidth={3} className="animate-spin" />
                    ) : (
                      <Save size={14} strokeWidth={3} />
                    )}
                    保存
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
