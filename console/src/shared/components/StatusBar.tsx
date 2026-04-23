import { useEffect, useState } from 'react';
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

/**
 * 轻量 heartbeat SSE 连接，监控连接健康度。
 *
 * v0.50.14：区分瞬时重连和终态关闭。
 *   - error 事件时看 readyState：CONNECTING 就是重连中（显示 connecting），
 *     CLOSED 才是终态（显示 closed）
 *   - EventSource 内置自动重连用 3s 间隔（浏览器默认）；它放弃时 readyState=CLOSED
 *   - CLOSED 后手动重建 EventSource（每 10s 重试一次），不然前端一直卡在 down
 */
function useHeartbeatSse(): 'connecting' | 'open' | 'closed' {
  const [state, setState] = useState<'connecting' | 'open' | 'closed'>('connecting');

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;

    const connect = (): void => {
      if (disposed) return;
      es = new EventSource('/stream/heartbeat');
      es.addEventListener('server.heartbeat', () => setState('open'));
      es.addEventListener('open', () => setState('open'));
      es.addEventListener('error', () => {
        // readyState：0 CONNECTING（auto-retry 中） / 1 OPEN / 2 CLOSED
        const rs = es?.readyState;
        if (rs === EventSource.CLOSED) {
          setState('closed');
          // 浏览器放弃重连——10s 后自己再拉起一次
          if (retryTimer == null) {
            retryTimer = setTimeout(() => {
              retryTimer = null;
              es?.close();
              connect();
            }, 10_000);
          }
        } else {
          setState('connecting');
        }
      });
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer != null) clearTimeout(retryTimer);
      es?.close();
    };
  }, []);

  return state;
}
