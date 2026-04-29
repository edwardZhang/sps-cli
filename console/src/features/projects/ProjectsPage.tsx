import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, Plus, Users } from 'lucide-react';
import { listProjects, type ProjectSummary } from '../../shared/api/projects';

export function ProjectsPage() {
  const nav = useNavigate();
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
  });

  return (
    <div className="flex flex-col gap-6 max-w-6xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold tracking-tight">
            Projects 🎯
          </h1>
          <p className="text-[var(--color-text-muted)] text-sm mt-1">
            {data
              ? `${data.data.length} local projects`
              : isLoading
                ? 'Loading…'
                : 'Click refresh to retry'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button className="nb-btn nb-btn-yellow" onClick={() => refetch()} type="button">
            <Activity size={16} strokeWidth={2.5} />
            Refresh
          </button>
          <button
            className="nb-btn nb-btn-primary"
            type="button"
            onClick={() => nav('/projects/new')}
            aria-label="New project"
          >
            <Plus size={16} strokeWidth={3} />
            New project
          </button>
        </div>
      </header>

      {isLoading && <Skeleton />}

      {isError && (
        <div className="nb-card bg-[var(--color-crashed-bg)]">
          <h2 className="font-[family-name:var(--font-heading)] text-xl font-bold mb-2">
            Load failed
          </h2>
          <p className="text-sm text-[var(--color-text)]">
            {error instanceof Error ? error.message : String(error)}
          </p>
          <button
            className="nb-btn mt-4"
            onClick={() => refetch()}
            type="button"
          >
            Retry
          </button>
        </div>
      )}

      {data && data.data.length === 0 && <EmptyState />}

      {data && data.data.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {data.data.map((p) => (
            <ProjectCard key={p.name} project={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const isRunning = project.pipelineStatus === 'running';

  return (
    <Link
      to={`/projects/${encodeURIComponent(project.name)}`}
      className="nb-card nb-card-interactive block no-underline text-[var(--color-text)]"
    >
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-[family-name:var(--font-heading)] font-bold text-xl truncate">
          {project.name}
        </h3>
        <StatusPill status={project.pipelineStatus} />
      </div>

      {project.repoDir && (
        <p className="text-xs font-[family-name:var(--font-mono)] text-[var(--color-text-muted)] truncate mb-3">
          {project.repoDir}
        </p>
      )}

      <div className="grid grid-cols-3 gap-2 text-sm mt-4 pt-3 border-t-[1.5px] border-dashed border-[var(--color-border-light)]">
        <Stat label="cards" value={project.cards.total} accent="purple" />
        <Stat
          label="inprogress"
          value={project.cards.inprogress}
          accent={project.cards.inprogress > 0 ? 'yellow' : 'idle'}
        />
        <Stat
          label="workers"
          value={`${project.workers.active}/${project.workers.total}`}
          accent={isRunning ? 'mint' : 'idle'}
        />
      </div>
    </Link>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string;
  accent: 'purple' | 'yellow' | 'mint' | 'idle';
}) {
  const bg: Record<typeof accent, string> = {
    purple: 'var(--color-accent-purple)',
    yellow: 'var(--color-accent-yellow)',
    mint: 'var(--color-accent-mint)',
    idle: 'var(--color-bg-cream)',
  };
  return (
    <div
      className="flex flex-col items-center justify-center py-2 rounded-lg border-2 border-[var(--color-text)]"
      style={{ background: bg[accent] }}
    >
      <span className="font-[family-name:var(--font-mono)] font-bold text-lg">
        {value}
      </span>
      <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-semibold">
        {label}
      </span>
    </div>
  );
}

function StatusPill({ status }: { status: ProjectSummary['pipelineStatus'] }) {
  const config: Record<
    ProjectSummary['pipelineStatus'],
    { bg: string; label: string }
  > = {
    running: { bg: 'var(--color-running-bg)', label: 'running' },
    idle: { bg: 'var(--color-idle-bg)', label: 'idle' },
    stopping: { bg: 'var(--color-stuck-bg)', label: 'stopping' },
    error: { bg: 'var(--color-crashed-bg)', label: 'error' },
  };
  const { bg, label } = config[status];
  const color =
    status === 'running'
      ? 'var(--color-running)'
      : status === 'error'
        ? 'var(--color-crashed)'
        : status === 'stopping'
          ? 'var(--color-stuck)'
          : 'var(--color-idle)';

  return (
    <span className="nb-status" style={{ background: bg, color }}>
      {label}
    </span>
  );
}

function Skeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {[0, 1, 2].map((i) => (
        <div key={i} className="nb-card opacity-60 animate-pulse">
          <div className="h-6 w-32 bg-[var(--color-border-light)] rounded-md mb-3" />
          <div className="h-3 w-full bg-[var(--color-border-light)] rounded-md mb-2" />
          <div className="h-3 w-2/3 bg-[var(--color-border-light)] rounded-md" />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="nb-card bg-[var(--color-accent-yellow)] flex items-center gap-6 p-8">
      <div className="w-20 h-20 rounded-2xl bg-[var(--color-accent-mint)] border-[3px] border-[var(--color-text)] shadow-[3px_3px_0_var(--color-text)] flex items-center justify-center">
        <Users size={32} strokeWidth={2.5} />
      </div>
      <div className="flex-1">
        <h2 className="font-[family-name:var(--font-heading)] text-2xl font-bold mb-2">
          No projects yet ✨
        </h2>
        <p className="text-sm text-[var(--color-text)] mb-4">
          Run <code className="bg-[var(--color-bg)] border-2 border-[var(--color-text)] px-2 py-0.5 rounded-md font-[family-name:var(--font-mono)]">sps project init &lt;name&gt;</code> to create your first project.
        </p>
        <button className="nb-btn nb-btn-primary" type="button">
          <Plus size={16} strokeWidth={3} />
          New project
        </button>
      </div>
    </div>
  );
}
