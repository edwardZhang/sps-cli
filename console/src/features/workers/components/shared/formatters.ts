/**
 * Shared time / state formatters for worker pages.
 *
 * `formatRelative` reads from the active i18n instance directly so the
 * "5s ago" / "5s 前" suffix follows the current locale even though the
 * helper isn't a React component.
 */
import i18n from '../../../../i18n';

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
  if (diff < 60_000) return i18n.t('workers:format.secondsAgo', { value: Math.floor(diff / 1000) });
  if (diff < 3_600_000) return i18n.t('workers:format.minutesAgo', { value: Math.floor(diff / 60_000) });
  return i18n.t('workers:format.hoursAgo', { value: Math.floor(diff / 3_600_000) });
}
