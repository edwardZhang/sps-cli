import { useState, useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, RefreshCw } from 'lucide-react';
import {
  listSkills,
  syncSkills,
  type SkillCategory,
  type SkillSummary,
} from '../../shared/api/skills';
import { listProjects } from '../../shared/api/projects';
import { SkillDetailModal } from './SkillDetailModal';

const CATEGORIES: Array<{ value: SkillCategory | 'all'; label: string }> = [
  { value: 'all',      label: '全部' },
  { value: 'language', label: 'language' },
  { value: 'end',      label: 'end' },
  { value: 'persona',  label: 'persona' },
  { value: 'workflow', label: 'workflow' },
  { value: 'other',    label: 'other' },
];

const CAT_COLORS: Record<SkillCategory, string> = {
  language: 'var(--color-accent-purple)',
  end:      'var(--color-secondary)',
  persona:  'var(--color-primary)',
  workflow: 'var(--color-accent-mint)',
  other:    'var(--color-bg-cream)',
};

export function SkillsPage() {
  const [cat, setCat] = useState<SkillCategory | 'all'>('all');
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['skills'],
    queryFn: () => listSkills(),
  });
  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: listProjects });

  const filtered = useMemo(() => {
    const list = data?.data ?? [];
    return list.filter((s) => {
      if (cat !== 'all' && s.category !== cat) return false;
      if (keyword && !s.name.toLowerCase().includes(keyword.toLowerCase())) return false;
      return true;
    });
  }, [data, cat, keyword]);

  const counts = useMemo(() => {
    const list = data?.data ?? [];
    const by: Record<string, number> = { all: list.length };
    for (const s of list) by[s.category] = (by[s.category] ?? 0) + 1;
    return by;
  }, [data]);

  return (
    <div className="flex flex-col gap-4 max-w-full">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold">Skills 🎯</h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            {isLoading ? '加载中…' : `${data?.data.length ?? 0} 个 user-level skill`}
          </p>
        </div>
        <div className="flex gap-3 items-center">
          <button
            className="nb-btn nb-btn-mint"
            onClick={async () => {
              await syncSkills();
              qc.invalidateQueries({ queryKey: ['skills'] });
            }}
            type="button"
          >
            <RefreshCw size={14} strokeWidth={2.5} />
            Sync bundled
          </button>
        </div>
      </header>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-subtle)]" />
          <input
            className="nb-input pl-9 w-full"
            placeholder="搜索 skill…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label="搜索 skill"
          />
        </div>
        <div className="flex gap-1 p-1 bg-[var(--color-bg)] border-[2px] border-[var(--color-text)] rounded-full shadow-[2px_2px_0_var(--color-text)]">
          {CATEGORIES.map((c) => (
            <button
              key={c.value}
              type="button"
              onClick={() => setCat(c.value)}
              className={[
                'px-3 py-1 rounded-full text-xs font-bold font-[family-name:var(--font-body)]',
                cat === c.value
                  ? 'bg-[var(--color-text)] text-[var(--color-bg)]'
                  : 'text-[var(--color-text-muted)] hover:text-[var(--color-text)]',
              ].join(' ')}
            >
              {c.label} {counts[c.value]}
            </button>
          ))}
        </div>
      </div>

      {/* v0.49.11：auto-fill 按可用宽度放，每列最小 280px，超宽屏自动放更多列 */}
      <div className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(280px,1fr))]">
        {filtered.map((s) => (
          <SkillCard
            key={s.name}
            skill={s}
            projectCount={projectsQ.data?.data.length ?? 0}
            onOpen={() => setSelected(s.name)}
          />
        ))}
      </div>

      {selected && (
        <SkillDetailModal
          name={selected}
          projects={projectsQ.data?.data.map((p) => p.name) ?? []}
          onClose={() => setSelected(null)}
          onChange={() => qc.invalidateQueries({ queryKey: ['skills'] })}
        />
      )}
    </div>
  );
}

function SkillCard({
  skill,
  projectCount,
  onOpen,
}: {
  skill: SkillSummary;
  projectCount: number;
  onOpen: () => void;
}) {
  const bg = CAT_COLORS[skill.category];
  return (
    <article
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`Open ${skill.name}`}
      className="nb-card nb-card-interactive flex flex-col gap-3"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-[family-name:var(--font-heading)] font-bold text-lg">
          {skill.name}
        </h3>
        <span
          className="nb-badge text-[10px]"
          style={{ background: bg }}
        >
          {skill.category}
        </span>
      </div>
      <p className="text-sm text-[var(--color-text-muted)] leading-5 line-clamp-3">
        {skill.description || '(no description)'}
      </p>
      <div className="flex items-center justify-between text-xs font-[family-name:var(--font-mono)] pt-2 border-t-[1.5px] border-dashed border-[var(--color-border-light)]">
        <span className="font-bold">
          {skill.linkedProjects.length > 0
            ? `● linked in ${skill.linkedProjects.length}`
            : '○ not linked'}
        </span>
        <span className="text-[var(--color-text-subtle)]">{projectCount} projects</span>
      </div>
    </article>
  );
}
