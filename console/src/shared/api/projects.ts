import { apiGet } from './client';

export interface ProjectSummary {
  name: string;
  repoDir: string | null;
  pmBackend: string;
  agentProvider: string;
  cards: { total: number; inprogress: number; done: number };
  workers: { total: number; active: number };
  pipelineStatus: 'idle' | 'running' | 'stopping' | 'error';
  lastActivityAt: string | null;
}

export interface CreateProjectInput {
  name: string;
  projectDir: string;
  mergeBranch?: string;
  maxWorkers?: string;
  gitlabProject?: string;
  gitlabProjectId?: string;
  matrixRoomId?: string;
}

export interface ConfResponse {
  content: string;
  etag: string;
}

export interface PipelineListResponse {
  active: string | null;
  available: Array<{ name: string; isActive: boolean }>;
}

export function listProjects() {
  return apiGet<{ data: ProjectSummary[] }>('/api/projects');
}

export function getProject(name: string) {
  return apiGet<ProjectSummary>(`/api/projects/${encodeURIComponent(name)}`);
}

export async function createProject(input: CreateProjectInput): Promise<ProjectSummary> {
  const res = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export function getProjectConf(name: string): Promise<ConfResponse> {
  return apiGet<ConfResponse>(`/api/projects/${encodeURIComponent(name)}/conf`);
}

export async function updateProjectConf(
  name: string,
  content: string,
  etag: string,
): Promise<{ etag: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(name)}/conf`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, etag }),
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`${res.status}: ${text}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function deleteProject(
  name: string,
  opts: { includeClaudeDir?: boolean } = {},
): Promise<{ name: string; claudeRemoved: Array<{ path: string; ok: boolean; error?: string }> }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export function listPipelines(name: string): Promise<PipelineListResponse> {
  return apiGet<PipelineListResponse>(`/api/projects/${encodeURIComponent(name)}/pipelines`);
}

export async function switchPipeline(name: string, pipeline: string): Promise<{ activePipeline: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(name)}/pipeline`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pipeline }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}
