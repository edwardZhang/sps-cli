import { useSearchParams } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pause, Play, Search, Download, History, Radio, ChevronDown, Folder } from 'lucide-react';
import { fetchLogs, logStreamUrl, type LogLine } from '../../shared/api/logs';
import { listProjects } from '../../shared/api/projects';

const LEVELS: LogLine['level'][] = ['error', 'warn', 'info', 'debug'];
const DEFAULT_ENABLED: LogLine['level'][] = ['error', 'warn', 'info'];

export function LogsPage() {
  const [params, setParams] = useSearchParams();
  const project = params.get('project');
  const worker = params.get('worker') ?? '';

  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [enabledLevels, setEnabledLevels] = useState<Set<LogLine['level']>>(
    () => new Set(DEFAULT_ENABLED),
  );
  const [keyword, setKeyword] = useState('');
  const [mode, setMode] = useState<'live' | 'history'>('live');
  // v0.48.0 历史查询 since 时间，默认 1 小时前（datetime-local 需要 yyyy-MM-ddTHH:mm 格式）
  const [since, setSince] = useState<string>(() => {
    const d = new Date(Date.now() - 60 * 60 * 1000);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const streamRef = useRef<HTMLDivElement>(null);

  // v0.49.10：无 project 时走聚合视图（后端返带 project 字段的行）
  const isAggregate = !project;

  // 项目列表（下拉选择）
  const projectsQ = useQuery({ queryKey: ['projects'], queryFn: listProjects });

  // 初始历史：live 模式拉 tail，history 模式按 since 过滤；聚合模式走 5s refetch（SSE 无法单连接覆盖多项目）
  const { data: initial, refetch: refetchHistory } = useQuery({
    queryKey: ['logs', project ?? 'agg', worker, mode, mode === 'history' ? since : 'live'],
    queryFn: () =>
      fetchLogs({
        project: project || undefined,
        worker: worker || undefined,
        limit: mode === 'history' ? 2000 : 500,
        since: mode === 'history' ? new Date(since).toISOString() : undefined,
      }),
    // 聚合 live 模式 5s 兜底（没 SSE 时靠轮询）；单项目 live 有 SSE 不需要轮询
    refetchInterval: isAggregate && mode === 'live' ? 5000 : false,
  });

  useEffect(() => {
    if (initial?.data) setLines(initial.data);
  }, [initial]);

  // SSE tail 仅 live 模式下激活
  useEffect(() => {
    if (!project || mode !== 'live') return;
    const url = logStreamUrl({ project, worker: worker || undefined });
    const es = new EventSource(url);
    es.addEventListener('log.line', (ev) => {
      if (paused) return;
      try {
        const line = JSON.parse((ev as MessageEvent).data) as LogLine;
        setLines((prev) => {
          const next = [...prev, line];
          if (next.length > 5000) next.splice(0, next.length - 5000);
          return next;
        });
      } catch {
        /* ignore */
      }
    });
    return () => es.close();
  }, [project, worker, paused, mode]);

  // Auto scroll
  useEffect(() => {
    if (!autoScroll) return;
    const el = streamRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, autoScroll]);

  const filtered = useMemo(() => {
    const kw = keyword.toLowerCase();
    return lines.filter((l) => {
      if (!enabledLevels.has(l.level)) return false;
      if (kw && !l.msg.toLowerCase().includes(kw)) return false;
      return true;
    });
  }, [lines, enabledLevels, keyword]);

  return (
    <div className="flex flex-col gap-4 max-w-full">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold tracking-tight">
            Logs 📜
          </h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            {isAggregate ? `All projects (${projectsQ.data?.data.length ?? 0})` : project}
            {worker && ` · worker-${worker}`} · {isAggregate && mode === 'live' ? '5s polling' : 'tail -f'} · {lines.length} lines
            {paused && <span className="text-[var(--color-stuck)] ml-2 font-bold">⏸ PAUSED</span>}
          </p>
        </div>
      </header>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex gap-1 p-1 bg-[var(--color-bg)] border-[2px] border-[var(--color-text)] rounded-full shadow-[2px_2px_0_var(--color-text)]">
          <button
            type="button"
            onClick={() => setMode('live')}
            aria-pressed={mode === 'live'}
            className={[
              'px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1.5',
              mode === 'live'
                ? 'bg-[var(--color-primary)] text-[var(--color-text)] shadow-[1px_1px_0_var(--color-text)]'
                : 'text-[var(--color-text-muted)]',
            ].join(' ')}
          >
            <Radio size={11} strokeWidth={2.5} />
            Live
          </button>
          <button
            type="button"
            onClick={() => setMode('history')}
            aria-pressed={mode === 'history'}
            className={[
              'px-3 py-1 rounded-full text-xs font-bold flex items-center gap-1.5',
              mode === 'history'
                ? 'bg-[var(--color-primary)] text-[var(--color-text)] shadow-[1px_1px_0_var(--color-text)]'
                : 'text-[var(--color-text-muted)]',
            ].join(' ')}
          >
            <History size={11} strokeWidth={2.5} />
            History
          </button>
        </div>
        {mode === 'history' && (
          <>
            <input
              type="datetime-local"
              className="nb-input"
              style={{ padding: '4px 8px', fontSize: 12 }}
              value={since}
              onChange={(e) => setSince(e.target.value)}
              aria-label="Query start time"
            />
            <button
              className="nb-btn nb-btn-primary"
              style={{ padding: '6px 12px', fontSize: 12 }}
              onClick={() => refetchHistory()}
              type="button"
              aria-label="Query"
            >
              <Search size={11} strokeWidth={3} />
              Query
            </button>
          </>
        )}
        {/* v0.49.12：项目筛选下拉（Neubrutalism 风格），放在关键字左侧 */}
        <div className="relative">
          <Folder
            size={14}
            strokeWidth={2.5}
            className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--color-text)]"
          />
          <select
            className="nb-input appearance-none pl-9 pr-9 font-[family-name:var(--font-mono)] cursor-pointer"
            style={{ padding: '10px 36px 10px 36px', fontSize: 13, minWidth: 180 }}
            value={project ?? ''}
            onChange={(e) => {
              const v = e.target.value;
              if (!v) setParams({});
              else setParams({ project: v });
            }}
            aria-label="Filter project"
          >
            <option value="">All projects</option>
            {projectsQ.data?.data.map((p) => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
          <ChevronDown
            size={14}
            strokeWidth={3}
            className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--color-text)]"
          />
        </div>

        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-subtle)]" />
          <input
            className="nb-input pl-9 w-full"
            placeholder="Filter keyword…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label="Filter logs"
          />
        </div>
        <div className="flex items-center gap-1 p-1 bg-[var(--color-bg)] border-[2px] border-[var(--color-text)] rounded-full shadow-[2px_2px_0_var(--color-text)]">
          {LEVELS.map((lvl) => (
            <LevelChip
              key={lvl}
              level={lvl}
              enabled={enabledLevels.has(lvl)}
              onToggle={() => {
                setEnabledLevels((prev) => {
                  const next = new Set(prev);
                  if (next.has(lvl)) next.delete(lvl);
                  else next.add(lvl);
                  return next;
                });
              }}
            />
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          {mode === 'live' && (
            <>
              <button
                className="nb-btn"
                style={{ padding: '6px 12px', fontSize: 12 }}
                onClick={() => setAutoScroll((v) => !v)}
                type="button"
              >
                {autoScroll ? '✓ Auto-scroll' : 'Auto-scroll'}
              </button>
              <button
                className="nb-btn"
                style={{ padding: '6px 12px', fontSize: 12 }}
                onClick={() => setPaused((v) => !v)}
                type="button"
              >
                {paused ? <><Play size={12} strokeWidth={3} /> Resume</> : <><Pause size={12} strokeWidth={3} /> Pause</>}
              </button>
            </>
          )}
          <button
            className="nb-btn"
            style={{ padding: '6px 12px', fontSize: 12 }}
            onClick={() => {
              const blob = new Blob([filtered.map((l) => l.raw).join('\n')], { type: 'text/plain' });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = `${project}-log-${Date.now()}.log`;
              a.click();
              URL.revokeObjectURL(url);
            }}
            type="button"
          >
            <Download size={12} strokeWidth={2.5} /> Export
          </button>
        </div>
      </div>

      <div className="nb-card p-0 overflow-hidden">
        <div className="px-4 py-2 bg-[var(--color-bg-cream)] border-b-2 border-[var(--color-text)] flex items-center justify-between font-[family-name:var(--font-mono)] text-xs">
          <span className="text-[var(--color-text-muted)]">
            {initial?.file ?? '~/.coral/projects/.../logs/*.log'}
          </span>
          {mode === 'live' ? (
            <span className="nb-status" style={{ background: 'var(--color-running-bg)', color: 'var(--color-running)' }}>
              live
            </span>
          ) : (
            <span className="nb-status" style={{ background: 'var(--color-accent-purple)', color: 'var(--color-text)' }}>
              history
            </span>
          )}
        </div>
        <div
          ref={streamRef}
          className="overflow-auto font-[family-name:var(--font-mono)] text-[12px] leading-[22px] max-h-[70vh] bg-[var(--color-bg)] p-2"
          onScroll={(e) => {
            const el = e.currentTarget;
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
            if (!atBottom && autoScroll) setAutoScroll(false);
          }}
        >
          {filtered.map((line, i) => (
            <LogLineItem key={i} line={line} />
          ))}
          {filtered.length === 0 && (
            <div className="text-center py-12 text-[var(--color-text-subtle)]">
              No matching logs
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LevelChip({
  level,
  enabled,
  onToggle,
}: {
  level: LogLine['level'];
  enabled: boolean;
  onToggle: () => void;
}) {
  const bg: Record<string, string> = {
    error: 'var(--color-crashed-bg)',
    warn:  'var(--color-stuck-bg)',
    info:  'var(--color-secondary)',
    debug: 'var(--color-accent-purple)',
  };
  const color: Record<string, string> = {
    error: 'var(--color-crashed)',
    warn:  'var(--color-stuck)',
    info:  'var(--color-text)',
    debug: 'var(--color-text)',
  };
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={enabled}
      className={[
        'px-3 py-0.5 rounded-full font-[family-name:var(--font-mono)] text-[10px] font-bold tracking-widest cursor-pointer',
        enabled ? 'border-[1.5px] border-[var(--color-text)]' : 'text-[var(--color-text-subtle)]',
      ].join(' ')}
      style={enabled ? { background: bg[level], color: color[level] } : {}}
    >
      {level.toUpperCase()}
    </button>
  );
}

function LogLineItem({ line }: { line: LogLine }) {
  const levelColor: Record<string, string> = {
    error: 'bg-[var(--color-crashed)] text-[var(--color-text)]',
    warn:  'bg-[var(--color-stuck)] text-[var(--color-text)]',
    info:  'bg-[var(--color-secondary)] text-[var(--color-text)]',
    debug: '',
    trace: '',
  };
  // v0.49.10：聚合模式下每行带 project 字段，加一列 project 标签
  const hasProject = !!line.project;
  return (
    <div
      className={[
        'grid gap-2 px-2 py-0.5 rounded hover:bg-[var(--color-bg-cream)]',
        hasProject ? 'grid-cols-[100px_90px_60px_1fr]' : 'grid-cols-[100px_60px_1fr]',
      ].join(' ')}
    >
      <span className="text-[var(--color-text-subtle)] whitespace-nowrap">
        {line.ts ? line.ts.split('T')[1]?.replace('Z', '') ?? line.ts : '--'}
      </span>
      {hasProject && (
        <span className="truncate text-[var(--color-text-muted)] font-bold" title={line.project}>
          {line.project}
        </span>
      )}
      <span
        className={`text-center font-bold ${levelColor[line.level] ?? ''}`}
        style={{
          borderRadius: 4,
          padding: '0 6px',
        }}
      >
        {line.level.toUpperCase()}
      </span>
      <span className="truncate text-[var(--color-text)]">{line.msg}</span>
    </div>
  );
}
