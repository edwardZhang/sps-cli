import { useQuery } from '@tanstack/react-query';
import { getSystemInfo } from '../api/system';

export function StatusBar() {
  const { data, isError } = useQuery({
    queryKey: ['system-info'],
    queryFn: getSystemInfo,
    refetchInterval: 30_000,
  });

  return (
    <div className="h-10 flex items-center gap-4 px-6 font-[family-name:var(--font-mono)] text-[11px] text-[var(--color-text-muted)]">
      <span className="nb-status" style={{ background: isError ? 'var(--color-crashed-bg)' : 'var(--color-running-bg)', color: isError ? 'var(--color-crashed)' : 'var(--color-running)', padding: '2px 8px 2px 7px' }}>
        {isError ? 'disconnected' : 'server'}
      </span>
      <span>localhost:{window.location.port}</span>
      {data && (
        <>
          <span className="text-[var(--color-text-subtle)]">·</span>
          <span>v{data.version}</span>
          <span className="text-[var(--color-text-subtle)]">·</span>
          <span>node {data.nodeVersion}</span>
        </>
      )}
      <span className="ml-auto text-[var(--color-text-subtle)]">Cmd+K</span>
    </div>
  );
}
