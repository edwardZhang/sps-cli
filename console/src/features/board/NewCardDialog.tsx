import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Plus, X } from 'lucide-react';
import { listSkills } from '../../shared/api/skills';

/**
 * 新建卡片对话框（v0.49.6）：标题 + 描述 + skill 多选。
 * 替代原来的 prompt() 单输入。
 */
export function NewCardDialog({
  project,
  isPending,
  onCancel,
  onCreate,
}: {
  project: string;
  isPending: boolean;
  onCancel: () => void;
  onCreate: (input: {
    title: string;
    description: string;
    skills: string[];
    labels: string[];
    /**
     * v0.51.10：入场状态。默认 'Planning'（卡进 Planning 等用户手动派发，
     * 符合 "Planning = 人工暂存" 的语义）；勾"立即派发"则 'Backlog'。
     */
    initialState: 'Planning' | 'Backlog';
  }) => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [selectedSkills, setSelectedSkills] = useState<Set<string>>(new Set());
  // v0.51.10：默认 false → 卡进 Planning（人工暂存）；勾上 → Backlog（立即派发）
  const [dispatchImmediate, setDispatchImmediate] = useState(false);

  const skillsQ = useQuery({
    queryKey: ['skills-all', project],
    queryFn: () => listSkills(project),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const validTitle = title.trim().length > 0 && title.trim().length <= 200;
  const canSubmit = validTitle && !isPending;

  const toggleSkill = (name: string): void => {
    const next = new Set(selectedSkills);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelectedSkills(next);
  };

  const submit = (): void => {
    if (!canSubmit) return;
    onCreate({
      title: title.trim(),
      description: description.trim(),
      skills: [...selectedSkills],
      // v0.51.10: AI-PIPELINE 是 "SPS 管的卡" 的标记，永远加；不再用它做 trigger
      labels: ['AI-PIPELINE'],
      initialState: dispatchImmediate ? 'Backlog' : 'Planning',
    });
  };

  const skills = skillsQ.data?.data ?? [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-40 flex items-start justify-center p-6 bg-black/30 overflow-auto"
    >
      <div
        className="nb-card mt-8 w-full max-w-xl flex flex-col"
        style={{ maxHeight: 'calc(100vh - 64px)' }}
      >
        <header className="flex items-center justify-between mb-4 flex-shrink-0">
          <h2 className="font-[family-name:var(--font-heading)] text-2xl font-bold">
            New card
          </h2>
          <button
            className="nb-btn nb-btn-mint p-2"
            onClick={onCancel}
            type="button"
            aria-label="Close"
          >
            <X size={14} strokeWidth={3} />
          </button>
        </header>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          className="flex flex-col gap-4 overflow-auto"
        >
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-bold">Title *</span>
            <input
              type="text"
              className="nb-input w-full"
              placeholder="e.g. Wire up GitHub OAuth login"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              autoFocus
              required
            />
            <span className="text-xs text-[var(--color-text-muted)]">
              Short, focused goal (              写简短明了的目标（&lt;200 字符）lt;200 chars)
            </span>
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-bold">Description</span>
            <textarea
              className="nb-input w-full"
              style={{ minHeight: 120, resize: 'vertical' }}
              placeholder="User story, requirements, acceptance criteria, references… Claude reads this on launch."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
            <span className="text-xs text-[var(--color-text-muted)]">
              Markdown supported. If empty, Claude only has the title to work from.
            </span>
          </label>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-bold">Skills</span>
            <span className="text-xs text-[var(--color-text-muted)]">
              Which skills to load (frontmatter `skills:`). Optional — workers fall back to project-level skills.
            </span>
            {skillsQ.isLoading && (
              <p className="text-xs text-[var(--color-text-muted)] italic">Loading skills…</p>
            )}
            {skillsQ.isError && (
              <p className="text-xs text-[var(--color-crashed)]">
                Failed to load skills (won''t block create): {skillsQ.error instanceof Error ? skillsQ.error.message : String(skillsQ.error)}
              </p>
            )}
            {skills.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {skills.map((s) => {
                  const checked = selectedSkills.has(s.name);
                  return (
                    <button
                      key={s.name}
                      type="button"
                      onClick={() => toggleSkill(s.name)}
                      className={[
                        'px-2.5 py-1 text-xs font-[family-name:var(--font-mono)] rounded-full border-2 transition-all',
                        checked
                          ? 'bg-[var(--color-accent-mint)] border-[var(--color-text)] shadow-[2px_2px_0_var(--color-text)] font-bold'
                          : 'bg-[var(--color-bg)] border-[var(--color-border-light)] hover:border-[var(--color-text)]',
                      ].join(' ')}
                      aria-pressed={checked}
                    >
                      {s.name}
                    </button>
                  );
                })}
              </div>
            )}
            {selectedSkills.size > 0 && (
              <p className="text-xs text-[var(--color-text-muted)]">
                Selected {selectedSkills.size} of: {[...selectedSkills].join(', ')}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-sm font-bold">Dispatch</span>
            <label className="flex items-center gap-3 cursor-pointer select-none p-3 border-[2px] border-[var(--color-text)] rounded-lg bg-[var(--color-bg-cream)]">
              <input
                type="checkbox"
                className="w-4 h-4 accent-[var(--color-cta)] cursor-pointer"
                checked={dispatchImmediate}
                onChange={(e) => setDispatchImmediate(e.target.checked)}
              />
              <div className="flex-1">
                <div className="text-sm font-bold">Dispatch immediately (goes straight to Backlog)</div>
                <div className="text-xs text-[var(--color-text-muted)] mt-0.5">
                  Default off: card lands in <code className="font-mono">Planning</code>; drag it to <code className="font-mono">Backlog</code> to start work.
                  Checked: skip staging — the next tick dispatches a worker.
                </div>
              </div>
            </label>
          </div>
        </form>

        <div className="flex gap-2 justify-end mt-4 pt-3 border-t-2 border-dashed border-[var(--color-text)] flex-shrink-0">
          <button
            className="nb-btn"
            style={{ padding: '6px 14px' }}
            onClick={onCancel}
            disabled={isPending}
            type="button"
          >
            Cancel
          </button>
          <button
            className="nb-btn nb-btn-primary"
            style={{ padding: '6px 14px' }}
            onClick={submit}
            disabled={!canSubmit}
            type="button"
            aria-label="Create card"
          >
            {isPending ? (
              <Loader2 size={13} strokeWidth={3} className="animate-spin" />
            ) : (
              <Plus size={13} strokeWidth={3} />
            )}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
