import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Square, RotateCcw, Plus, Search, Filter, X, ChevronDown, Loader2 } from 'lucide-react';
import { NewCardDialog } from './NewCardDialog';
import { listProjects } from '../../shared/api/projects';
import {
  listCards,
  startPipeline,
  stopPipeline,
  resetPipeline,
  createCard,
  moveCard,
  type Card as CardT,
} from '../../shared/api/cards';
import { useProjectStream } from '../../shared/hooks/useProjectStream';
import { KanbanColumn } from './KanbanColumn';
import { CardDetailModal } from './CardDetailModal';
import { ProjectPicker } from '../../shared/components/ProjectPicker';
import { useDialog } from '../../shared/components/DialogProvider';

// v0.49.8：展开全部 canonical states，每列单独显示。Canceled 折叠进 Done（少见状态）
const COLUMNS: Array<{ state: string; label: string; bg: string }> = [
  { state: 'Planning',    label: 'Planning',    bg: 'var(--color-accent-purple)' },
  { state: 'Backlog',     label: 'Backlog',     bg: 'var(--color-bg-cream)' },
  { state: 'Todo',        label: 'Todo',        bg: 'var(--color-accent-yellow)' },
  { state: 'Inprogress',  label: 'Inprogress',  bg: 'var(--color-secondary)' },
  { state: 'QA',          label: 'QA / Review', bg: 'var(--color-accent-pink)' },
  { state: 'Done',        label: 'Done',        bg: 'var(--color-accent-mint)' },
];

// v0.49.4：记住上次打开的看板项目
const LAST_BOARD_KEY = 'sps-console:last-board-project';

function loadLastProject(): string | null {
  if (typeof window === 'undefined') return null;
  try { return localStorage.getItem(LAST_BOARD_KEY); } catch { return null; }
}
function saveLastProject(name: string): void {
  if (typeof window === 'undefined') return;
  try { localStorage.setItem(LAST_BOARD_KEY, name); } catch { /* quota */ }
}

export function BoardPage() {
  const [params, setParams] = useSearchParams();
  const project = params.get('project');
  const [detailSeq, setDetailSeq] = useState<number | null>(null);
  const [keyword, setKeyword] = useState('');
  const [skillFilter, setSkillFilter] = useState<Set<string>>(() => new Set());
  const [labelFilter, setLabelFilter] = useState<Set<string>>(() => new Set());
  const { confirm, alert } = useDialog();

  useProjectStream(project);

  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: listProjects });
  const cardsQ = useQuery({
    queryKey: ['cards', project],
    queryFn: () => listCards(project ?? ''),
    enabled: !!project,
  });

  const qc = useQueryClient();
  const refetchAll = (): void => {
    qc.invalidateQueries({ queryKey: ['cards', project] });
    qc.invalidateQueries({ queryKey: ['projects'] });
    qc.invalidateQueries({ queryKey: ['pipeline-status', project] });
  };

  const setProject = (name: string): void => {
    setParams({ project: name });
  };

  // v0.49.4: 进 /board 没 ?project= 且上次有记录 → 自动恢复
  useEffect(() => {
    if (project) {
      saveLastProject(project);
      return;
    }
    const last = loadLastProject();
    if (last && projectsQ.data?.data.some((p) => p.name === last)) {
      setParams({ project: last }, { replace: true });
    }
  }, [project, projectsQ.data, setParams]);

  // ── v0.49.4 Mutations with explicit error handling ──
  const startMutation = useMutation({
    mutationFn: () => startPipeline(project!),
    onSuccess: () => {
      refetchAll();
    },
    onError: (err) => {
      void alert({
        title: 'Failed to start pipeline',
        body: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => stopPipeline(project!),
    onSuccess: () => refetchAll(),
    onError: (err) => {
      void alert({
        title: 'Failed to stop pipeline',
        body: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => resetPipeline(project!, { all: true }),
    onSuccess: () => refetchAll(),
    onError: (err) => {
      void alert({
        title: 'Reset failed',
        body: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const [newCardOpen, setNewCardOpen] = useState(false);

  const createCardMutation = useMutation({
    mutationFn: (input: {
      title: string;
      description: string;
      skills: string[];
      labels: string[];
      initialState: 'Planning' | 'Backlog';
    }) => createCard(project!, input),
    onSuccess: () => {
      refetchAll();
      setNewCardOpen(false);
    },
    onError: (err) => {
      void alert({
        title: 'Failed to create card',
        body: err instanceof Error ? err.message : String(err),
      });
    },
  });

  const moveCardMutation = useMutation({
    mutationFn: ({ seq, state }: { seq: number; state: string }) =>
      moveCard(project!, seq, state),
    onMutate: async ({ seq, state }) => {
      // Optimistic: 立即在 cache 里改 card state
      await qc.cancelQueries({ queryKey: ['cards', project] });
      const prev = qc.getQueryData<{ data: CardT[] }>(['cards', project]);
      if (prev) {
        qc.setQueryData<{ data: CardT[] }>(['cards', project], {
          ...prev,
          data: prev.data.map((c) => (c.seq === seq ? { ...c, state } : c)),
        });
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      // 回滚
      if (ctx?.prev) qc.setQueryData(['cards', project], ctx.prev);
      void alert({
        title: 'Failed to move card',
        body: err instanceof Error ? err.message : String(err),
      });
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['cards', project] });
    },
  });

  const cards = cardsQ.data?.data ?? [];

  // v0.48.1 聚合出项目所有用到的 skill / label，供筛选下拉
  // v0.49 修复：hook 必须在所有 early return 之前调用（React rules-of-hooks）
  const { allSkills, allLabels } = useMemo(() => {
    const sk = new Set<string>();
    const lb = new Set<string>();
    for (const c of cards) {
      for (const s of c.skills) sk.add(s);
      for (const l of c.labels) lb.add(l);
    }
    return {
      allSkills: [...sk].sort(),
      allLabels: [...lb].sort(),
    };
  }, [cards]);

  if (!project) {
    return (
      <div className="flex flex-col gap-6 max-w-4xl">
        <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold">Board</h1>
        <div className="nb-card bg-[var(--color-accent-yellow)] max-w-2xl">
          <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold mb-3">
            Select a project 🎯
          </h2>
          <p className="text-sm mb-4 text-[var(--color-text-muted)]">
            The board is per-project. Pick one to start:
          </p>
          <div className="flex flex-wrap gap-2">
            {projectsQ.data?.data.map((p) => (
              <button
                key={p.name}
                className="nb-btn nb-btn-blue"
                onClick={() => setProject(p.name)}
                type="button"
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  const filtered = cards.filter((c) => {
    // 关键字模糊：title / skill / label 任一命中
    if (keyword) {
      const kw = keyword.toLowerCase();
      const hit =
        c.title.toLowerCase().includes(kw) ||
        c.skills.some((s) => s.toLowerCase().includes(kw)) ||
        c.labels.some((l) => l.toLowerCase().includes(kw));
      if (!hit) return false;
    }
    // skill 下拉：多选 AND 于关键字
    if (skillFilter.size > 0) {
      const hasAny = c.skills.some((s) => skillFilter.has(s));
      if (!hasAny) return false;
    }
    // label 下拉：多选 AND 于关键字 + skill
    if (labelFilter.size > 0) {
      const hasAny = c.labels.some((l) => labelFilter.has(l));
      if (!hasAny) return false;
    }
    return true;
  });
  const projectSummary = projectsQ.data?.data.find((p) => p.name === project);
  const running = projectSummary?.pipelineStatus === 'running';

  return (
    <div className="flex flex-col gap-4 max-w-full flex-1 min-h-0">
      <header className="flex items-center justify-between flex-wrap gap-3 shrink-0">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold tracking-tight">
            Board ✨
          </h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">
            {projectSummary
              ? `${projectSummary.name} · ${projectSummary.cards.total} cards · ${projectSummary.workers.active} workers active`
              : 'Loading…'}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <ProjectPicker current={project} onChange={setProject} />
          {/* v0.50.3：启停合并单按钮，按 pipeline 当前状态切换 */}
          <button
            className={running ? 'nb-btn nb-btn-danger' : 'nb-btn nb-btn-primary'}
            onClick={() => (running ? stopMutation.mutate() : startMutation.mutate())}
            disabled={startMutation.isPending || stopMutation.isPending}
            type="button"
            aria-label={running ? 'Stop pipeline' : 'Start pipeline'}
            title={running ? 'Stop pipeline' : 'Start pipeline'}
          >
            {startMutation.isPending || stopMutation.isPending ? (
              <Loader2 size={14} strokeWidth={3} className="animate-spin" />
            ) : running ? (
              <Square size={14} strokeWidth={3} />
            ) : (
              <Play size={14} strokeWidth={3} />
            )}
            {running ? 'Stop' : 'Start'}
          </button>
          <button
            className="nb-btn nb-btn-yellow"
            type="button"
            onClick={async () => {
              const ok = await confirm({
                title: 'Reset entire pipeline',
                body: "This clears every card's run state, worker markers, and branches. Cannot be undone.",
                confirm: 'Reset all',
                danger: true,
              });
              if (!ok) return;
              resetMutation.mutate();
            }}
            disabled={resetMutation.isPending}
          >
            {resetMutation.isPending ? (
              <Loader2 size={14} strokeWidth={3} className="animate-spin" />
            ) : (
              <RotateCcw size={14} strokeWidth={2.5} />
            )}
            Reset
          </button>
          <button
            className="nb-btn nb-btn-mint"
            type="button"
            onClick={() => setNewCardOpen(true)}
            disabled={createCardMutation.isPending}
          >
            {createCardMutation.isPending ? (
              <Loader2 size={14} strokeWidth={3} className="animate-spin" />
            ) : (
              <Plus size={14} strokeWidth={3} />
            )}
            New card
          </button>
        </div>
      </header>

      <div className="flex items-center gap-3 flex-wrap shrink-0">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-subtle)]" />
          <input
            className="nb-input pl-9 w-full"
            placeholder="Search title / skill / label…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label="Search cards"
          />
        </div>
        <MultiSelect
          label="skill"
          options={allSkills}
          selected={skillFilter}
          onChange={setSkillFilter}
        />
        <MultiSelect
          label="label"
          options={allLabels}
          selected={labelFilter}
          onChange={setLabelFilter}
        />
        {(keyword || skillFilter.size > 0 || labelFilter.size > 0) && (
          <button
            className="nb-btn"
            style={{ padding: '4px 10px', fontSize: 11 }}
            onClick={() => {
              setKeyword('');
              setSkillFilter(new Set());
              setLabelFilter(new Set());
            }}
            type="button"
            aria-label="Clear filters"
          >
            <X size={11} strokeWidth={3} />
            Clear
          </button>
        )}
        <span className="text-xs text-[var(--color-text-muted)] flex items-center gap-1 font-[family-name:var(--font-mono)]">
          <Filter size={12} />
          {filtered.length} / {cards.length}
        </span>
      </div>

      {cardsQ.isError && (
        <div className="nb-card bg-[var(--color-crashed-bg)]">
          <p className="font-semibold">Failed to load cards</p>
          <p className="text-sm mt-1 text-[var(--color-text-muted)]">
            {cardsQ.error instanceof Error ? cardsQ.error.message : String(cardsQ.error)}
          </p>
        </div>
      )}

      {!cardsQ.isError && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 auto-rows-fr gap-3 flex-1 min-h-0">
          {COLUMNS.map((col) => (
            <KanbanColumn
              key={col.state}
              label={col.label}
              bg={col.bg}
              cards={filtered.filter(columnFilter(col.state))}
              onCardClick={(card) => setDetailSeq(card.seq)}
              onDropCard={(seq) => moveCardMutation.mutate({ seq, state: col.state })}
            />
          ))}
        </div>
      )}

      {detailSeq !== null && (
        <CardDetailModal
          project={project}
          seq={detailSeq}
          onClose={() => setDetailSeq(null)}
          onChanged={refetchAll}
        />
      )}

      {newCardOpen && (
        <NewCardDialog
          project={project}
          isPending={createCardMutation.isPending}
          onCancel={() => setNewCardOpen(false)}
          onCreate={(input) => createCardMutation.mutate(input)}
        />
      )}

    </div>
  );
}

// v0.49.8：每列 1:1 对应一个 state。
//   QA 列也接受 Review（不同项目用不同命名）；Done 列也接受 Canceled（罕见状态折叠）
function columnFilter(state: string) {
  return (c: CardT): boolean => {
    if (state === 'QA') return c.state === 'QA' || c.state === 'Review';
    if (state === 'Done') return c.state === 'Done' || c.state === 'Canceled';
    return c.state === state;
  };
}

/**
 * Pastel Neubrutalism 风格的多选下拉。点按钮展开选项列表；勾选 toggle 一个项；
 * 点外面关；ESC 也关。
 */
function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('click', onClickOutside);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('click', onClickOutside);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = (val: string): void => {
    const next = new Set(selected);
    if (next.has(val)) next.delete(val);
    else next.add(val);
    onChange(next);
  };

  const disabled = options.length === 0;
  const count = selected.size;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        className="nb-btn"
        style={{ padding: '6px 12px', fontSize: 12 }}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Filter by ${label}`}
      >
        {label}
        {count > 0 && (
          <span
            className="ml-1 px-1.5 py-0.5 text-[10px] font-bold rounded-full bg-[var(--color-primary)] text-[var(--color-text)] border border-[var(--color-text)]"
          >
            {count}
          </span>
        )}
        <ChevronDown
          size={11}
          strokeWidth={3}
          className={['transition-transform', open ? 'rotate-180' : ''].join(' ')}
        />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full mt-2 z-20 min-w-[200px] max-h-64 overflow-auto nb-card p-2"
          style={{ padding: 8 }}
        >
          {options.map((opt) => {
            const checked = selected.has(opt);
            return (
              <label
                key={opt}
                className={[
                  'flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer text-sm font-[family-name:var(--font-mono)]',
                  checked ? 'bg-[var(--color-accent-mint)]' : 'hover:bg-[var(--color-bg-cream)]',
                ].join(' ')}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(opt)}
                  className="flex-shrink-0"
                />
                <span className="truncate">{opt}</span>
              </label>
            );
          })}
          {count > 0 && (
            <button
              type="button"
              className="w-full mt-2 pt-2 border-t-2 border-dashed border-[var(--color-text)] text-xs font-bold text-[var(--color-crashed)] text-center"
              onClick={() => onChange(new Set())}
            >
              Clear selection
            </button>
          )}
        </div>
      )}
    </div>
  );
}
