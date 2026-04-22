import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Square, RotateCcw, Plus, Search, Filter, X, ChevronDown } from 'lucide-react';
import { listProjects } from '../../shared/api/projects';
import {
  listCards,
  startPipeline,
  stopPipeline,
  resetPipeline,
  createCard,
  type Card as CardT,
} from '../../shared/api/cards';
import { useProjectStream } from '../../shared/hooks/useProjectStream';
import { KanbanColumn } from './KanbanColumn';
import { CardDetailModal } from './CardDetailModal';
import { ProjectPicker } from '../../shared/components/ProjectPicker';
import { useDialog } from '../../shared/components/DialogProvider';

const COLUMNS: Array<{ state: string; label: string; bg: string }> = [
  { state: 'Backlog',     label: 'Backlog',     bg: 'var(--color-accent-purple)' },
  { state: 'Inprogress',  label: 'Inprogress',  bg: 'var(--color-accent-yellow)' },
  { state: 'Review',      label: 'Review',      bg: 'var(--color-accent-pink)' },
  { state: 'Done',        label: 'Done',        bg: 'var(--color-accent-mint)' },
];

export function BoardPage() {
  const [params, setParams] = useSearchParams();
  const project = params.get('project');
  const [detailSeq, setDetailSeq] = useState<number | null>(null);
  const [keyword, setKeyword] = useState('');
  const [skillFilter, setSkillFilter] = useState<Set<string>>(() => new Set());
  const [labelFilter, setLabelFilter] = useState<Set<string>>(() => new Set());
  const { confirm, prompt } = useDialog();

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

  if (!project) {
    return (
      <div className="flex flex-col gap-6 max-w-4xl">
        <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold">看板</h1>
        <div className="nb-card bg-[var(--color-accent-yellow)] max-w-2xl">
          <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold mb-3">
            选择一个项目 🎯
          </h2>
          <p className="text-sm mb-4 text-[var(--color-text-muted)]">
            看板按项目分。挑一个开始：
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

  const cards = cardsQ.data?.data ?? [];

  // v0.48.1 聚合出项目所有用到的 skill / label，供筛选下拉
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
    <div className="flex flex-col gap-4 max-w-full">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold tracking-tight">
            看板 ✨
          </h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">
            {projectSummary
              ? `${projectSummary.name} · ${projectSummary.cards.total} cards · ${projectSummary.workers.active} workers 活跃`
              : '加载中…'}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <ProjectPicker current={project} onChange={setProject} />
          {running ? (
            <button className="nb-btn nb-btn-danger" onClick={async () => {
              await stopPipeline(project);
              refetchAll();
            }} type="button">
              <Square size={14} strokeWidth={3} /> 停止
            </button>
          ) : (
            <button className="nb-btn nb-btn-primary" onClick={async () => {
              await startPipeline(project);
              refetchAll();
            }} type="button">
              <Play size={14} strokeWidth={3} /> 启动 pipeline
            </button>
          )}
          <button
            className="nb-btn nb-btn-yellow"
            type="button"
            onClick={async () => {
              const ok = await confirm({
                title: '重置整个流水线',
                body: '这会清空所有卡片的运行状态、worker marker、分支。不可撤销。',
                confirm: '重置全部',
                danger: true,
              });
              if (!ok) return;
              await resetPipeline(project, { all: true });
              refetchAll();
            }}
          >
            <RotateCcw size={14} strokeWidth={2.5} /> 重置
          </button>
          <button
            className="nb-btn nb-btn-mint"
            type="button"
            onClick={async () => {
              const title = await prompt({
                title: '新建卡片',
                body: '输入卡片标题，会作为 markdown 文件的 title。',
                placeholder: '例如：接入 GitHub OAuth',
              });
              if (!title) return;
              await createCard(project, title);
              refetchAll();
            }}
          >
            <Plus size={14} strokeWidth={3} /> 新卡片
          </button>
        </div>
      </header>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-subtle)]" />
          <input
            className="nb-input pl-9 w-full"
            placeholder="搜索标题 / skill / label…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label="搜索卡片"
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
            aria-label="清空筛选"
          >
            <X size={11} strokeWidth={3} />
            清空
          </button>
        )}
        <span className="text-xs text-[var(--color-text-muted)] flex items-center gap-1 font-[family-name:var(--font-mono)]">
          <Filter size={12} />
          {filtered.length} / {cards.length}
        </span>
      </div>

      {cardsQ.isError && (
        <div className="nb-card bg-[var(--color-crashed-bg)]">
          <p className="font-semibold">加载卡片失败</p>
          <p className="text-sm mt-1 text-[var(--color-text-muted)]">
            {cardsQ.error instanceof Error ? cardsQ.error.message : String(cardsQ.error)}
          </p>
        </div>
      )}

      {!cardsQ.isError && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          {COLUMNS.map((col) => (
            <KanbanColumn
              key={col.state}
              label={col.label}
              bg={col.bg}
              cards={filtered.filter(columnFilter(col.state))}
              onCardClick={(card) => setDetailSeq(card.seq)}
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

    </div>
  );
}

function columnFilter(state: string) {
  return (c: CardT): boolean => {
    if (state === 'Backlog') return c.state === 'Backlog' || c.state === 'Planning';
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
        aria-label={`按 ${label} 筛选`}
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
              清空选择
            </button>
          )}
        </div>
      )}
    </div>
  );
}
