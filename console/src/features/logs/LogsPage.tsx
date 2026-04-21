import { useSearchParams } from 'react-router-dom';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pause, Play, Search, Download } from 'lucide-react';
import { fetchLogs, logStreamUrl, type LogLine } from '../../shared/api/logs';
import { ProjectPicker } from '../../shared/components/ProjectPicker';

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
  const streamRef = useRef<HTMLDivElement>(null);

  // 初始历史
  const { data: initial } = useQuery({
    queryKey: ['logs', project, worker],
    queryFn: () =>
      fetchLogs({ project: project ?? '', worker: worker || undefined, limit: 500 }),
    enabled: !!project,
  });

  useEffect(() => {
    if (initial?.data) setLines(initial.data);
  }, [initial]);

  // SSE tail
  useEffect(() => {
    if (!project) return;
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
  }, [project, worker, paused]);

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

  if (!project) {
    return (
      <div className="nb-card max-w-2xl bg-[var(--color-accent-yellow)]">
        <h1 className="font-[family-name:var(--font-heading)] text-2xl font-bold mb-2">Logs 📜</h1>
        <p className="text-sm">需要 <code>?project=xx</code>。</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 max-w-full">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="font-[family-name:var(--font-heading)] text-4xl font-bold tracking-tight">
            Logs 📜
          </h1>
          <p className="text-sm text-[var(--color-text-muted)] mt-1">
            {project}
            {worker && ` · worker-${worker}`} · tail -f · {lines.length} lines
            {paused && <span className="text-[var(--color-stuck)] ml-2 font-bold">⏸ PAUSED</span>}
          </p>
        </div>
        <div className="flex gap-3 items-center">
          <ProjectPicker current={project} onChange={(n) => setParams({ project: n })} />
        </div>
      </header>

      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-subtle)]" />
          <input
            className="nb-input pl-9 w-full"
            placeholder="过滤关键字…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            aria-label="过滤日志"
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
          <span className="nb-status" style={{ background: 'var(--color-running-bg)', color: 'var(--color-running)' }}>
            live
          </span>
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
              没有匹配的日志
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
  return (
    <div
      className="grid grid-cols-[100px_60px_1fr] gap-2 px-2 py-0.5 rounded hover:bg-[var(--color-bg-cream)]"
    >
      <span className="text-[var(--color-text-subtle)] whitespace-nowrap">
        {line.ts ? line.ts.split('T')[1]?.replace('Z', '') ?? line.ts : '--'}
      </span>
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
