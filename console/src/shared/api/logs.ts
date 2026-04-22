import { apiGet } from './client';

export interface LogLine {
  ts: string | null;
  worker: number | null;
  level: 'debug' | 'info' | 'warn' | 'error' | 'trace';
  msg: string;
  raw: string;
}

export function fetchLogs(opts: {
  project: string;
  worker?: string;
  limit?: number;
  since?: string;
}) {
  const params = new URLSearchParams({ project: opts.project });
  if (opts.worker) params.set('worker', opts.worker);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.since) params.set('since', opts.since);
  return apiGet<{ data: LogLine[]; file?: string; files?: string[] }>(`/api/logs?${params}`);
}

export function logStreamUrl(opts: { project: string; worker?: string }): string {
  const params = new URLSearchParams({ project: opts.project });
  if (opts.worker) params.set('worker', opts.worker);
  return `/stream/logs?${params}`;
}
