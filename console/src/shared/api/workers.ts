import { apiGet } from './client';

export type WorkerState = 'idle' | 'starting' | 'running' | 'stuck' | 'crashed';

export interface Worker {
  slot: number;
  pid: number | null;
  state: WorkerState;
  card: { seq: number; title: string } | null;
  stage: string | null;
  startedAt: string | null;
  runtimeMs: number | null;
  markerUpdatedAt: string | null;
}

export interface AggregateWorker extends Worker {
  project: string;
  lastLogLine: { ts: string | null; msg: string } | null;
}

export interface ProjectCapacity {
  project: string;
  total: number;
  running: number;
  starting: number;
  stuck: number;
  crashed: number;
  idle: number;
}

export interface WorkersAggregate {
  alerts: AggregateWorker[];
  active: AggregateWorker[];
  capacity: ProjectCapacity[];
}

export function getWorkersAggregate() {
  return apiGet<WorkersAggregate>('/api/workers/all');
}

export interface WorkerLogLine {
  ts: string | null;
  level: string;
  msg: string;
}

// v0.50.10: ACP session log 行 —— Claude 真实输出
export interface AcpSessionLine {
  ts: string | null;
  kind: string; // assistant | tool:<kind> | tool_update | usage | raw
  text: string;
}

export interface WorkerDetail extends Worker {
  markerPath: string;
  markerData: Record<string, unknown> | null;
  recentLogs: WorkerLogLine[];
  recentOutput: AcpSessionLine[];
}

export function listWorkers(project: string) {
  return apiGet<{ data: Worker[] }>(
    `/api/projects/${encodeURIComponent(project)}/workers`,
  );
}

export function getWorkerDetail(project: string, slot: number) {
  return apiGet<WorkerDetail>(
    `/api/projects/${encodeURIComponent(project)}/workers/${slot}`,
  );
}

async function postJson(path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(path, {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
  return res.json().catch(() => ({}));
}

export function killWorker(project: string, slot: number) {
  return postJson(
    `/api/projects/${encodeURIComponent(project)}/workers/${slot}/kill`,
  );
}

export function launchWorker(project: string, slot: number, seq?: number) {
  return postJson(
    `/api/projects/${encodeURIComponent(project)}/workers/${slot}/launch`,
    seq ? { seq } : undefined,
  );
}
