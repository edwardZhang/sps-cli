import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Square, RotateCcw, Plus, Search, Filter } from 'lucide-react';
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
  const filtered = keyword
    ? cards.filter((c) =>
        c.title.toLowerCase().includes(keyword.toLowerCase()) ||
        c.skills.some((s) => s.includes(keyword)) ||
        c.labels.some((l) => l.includes(keyword)),
      )
    : cards;
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
