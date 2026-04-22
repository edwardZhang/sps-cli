import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Activity, Radio, AlertCircle } from 'lucide-react';
import { getSystemInfo } from '../api/system';
import { listProjects } from '../api/projects';

/**
 * 全局状态栏（v0.48.1）：
 *   - Server: query 命中与否
 *   - SSE: /stream/heartbeat 连不连得上
 *   - 活跃 pipeline 数 / 活跃 worker 数（跨全部项目聚合）
 *   - 版本 + node
 */
export function StatusBar() {
  const infoQ = useQuery({
    queryKey: ['system-info'],
    queryFn: getSystemInfo,
    refetchInterval: 30_000,
  });
  const projectsQ = useQuery({
    queryKey: ['projects'],
    queryFn: listProjects,
    refetchInterval: 10_000,
  });
  const sseState = useHeartbeatSse();

  const serverOk = !infoQ.isError;
  const projects = projectsQ.data?.data ?? [];
  const runningPipelines = projects.filter((p) => p.pipelineStatus === 'running').length;
  const activeWorkers = projects.reduce((sum, p) => sum + p.workers.active, 0);

  return (
    <div className="h-10 flex items-center gap-3 px-6 font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-text-muted)]">
      <span
        className="nb-status"
        style={{
          background: serverOk ? 'var(--color-running-bg)' : 'var(--color-crashed-bg)',
          color: serverOk ? 'var(--color-running)' : 'var(--color-crashed)',
          padding: '2px 8px 2px 7px',
        }}
      >
        {serverOk ? 'server' : 'offline'}
      </span>
      <SseBadge state={sseState} />
      <span className="text-[var(--color-text-subtle)]">·</span>
      <span className="flex items-center gap-1" title="活跃 pipeline 数">
        <Activity size={10} strokeWidth={2.5} />
        <span className="font-bold text-[var(--color-text)]">{runningPipelines}</span> pipeline
      </span>
      <span className="text-[var(--color-text-subtle)]">·</span>
      <span className="flex items-center gap-1" title="活跃 worker 数">
        <Radio size={10} strokeWidth={2.5} />
        <span className="font-bold text-[var(--color-text)]">{activeWorkers}</span> worker
      </span>
      <span className="text-[var(--color-text-subtle)]">·</span>
      <span>localhost:{window.location.port}</span>
      {infoQ.data && (
        <>
          <span className="text-[var(--color-text-subtle)]">·</span>
          <span>v{infoQ.data.version}</span>
          <span className="text-[var(--color-text-subtle)]">·</span>
          <span>node {infoQ.data.nodeVersion}</span>
        </>
      )}
    </div>
  );
}

function SseBadge({ state }: { state: 'connecting' | 'open' | 'closed' }) {
  if (state === 'open') {
    return (
      <span
        className="nb-status"
        style={{
          background: 'var(--color-running-bg)',
          color: 'var(--color-running)',
          padding: '2px 8px 2px 7px',
        }}
      >
        SSE
      </span>
    );
  }
  if (state === 'connecting') {
    return (
      <span
        className="nb-status"
        style={{
          background: 'var(--color-stuck-bg)',
          color: 'var(--color-stuck)',
          padding: '2px 8px 2px 7px',
        }}
      >
        SSE·connect
      </span>
    );
  }
  return (
    <span
      className="nb-status"
      style={{
        background: 'var(--color-crashed-bg)',
        color: 'var(--color-crashed)',
        padding: '2px 8px 2px 7px',
      }}
    >
      <AlertCircle size={9} strokeWidth={2.5} />
      SSE·down
    </span>
  );
}

/** 轻量 heartbeat SSE 连接，监控连接健康度。一次连上后保持常连。 */
function useHeartbeatSse(): 'connecting' | 'open' | 'closed' {
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting');
  const esRef = useRef<EventSource | null>(null);
  useEffect(() => {
    const es = new EventSource('/stream/heartbeat');
    esRef.current = es;
    es.addEventListener('server.heartbeat', () => setState('open'));
    es.addEventListener('error', () => setState('closed'));
    es.addEventListener('open', () => setState('open'));
    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);
  return state;
}
