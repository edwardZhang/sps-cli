/**
 * @module        features/workers/components/shared/formatters
 * @description   Worker 页面共享的时间/状态格式化 helpers
 *
 * v0.50.18：从 WorkersAggregatePage.tsx 抽出。
 */

export function formatRuntime(ms: number | null): string {
  if (ms == null || ms <= 0) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

export function runtimeColor(ms: number | null): string {
  if (ms == null || ms <= 0) return 'text-[var(--color-text-muted)]';
  const minutes = ms / 60000;
  if (minutes < 10) return 'text-[var(--color-running)]';
  if (minutes < 60) return 'text-[var(--color-stuck)]';
  return 'text-[var(--color-crashed)]';
}

export function formatRelative(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}
