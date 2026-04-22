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

// ── v0.49.2 Pipeline 文件 CRUD ────────────────────────────────

/**
 * Parsed pipeline YAML（供结构化表单使用）。Backend 已经 YAML.parse 过。
 * 字段只覆盖常见的 project-mode 场景；冷门字段走原始 YAML 模式。
 */
export interface PipelineOnFail {
  action?: string;
  comment?: string;
  halt?: boolean;
}

export interface PipelineStage {
  name?: string;
  profile?: string;
  trigger?: string;
  card_state?: string;
  on_complete?: string;
  on_fail?: PipelineOnFail;
  timeout?: string;
  [key: string]: unknown; // 允许未知字段 passthrough
}

export interface ParsedPipeline {
  mode?: 'project' | 'steps';
  stages?: PipelineStage[];
  pm?: { card_states?: Record<string, string> };
  [key: string]: unknown;
}

export interface PipelineFileResponse {
  content: string;
  etag: string;
  parsed: ParsedPipeline | null;
  parseError: string | null;
  isActive: boolean;
}

export function getPipelineFile(projectName: string, file: string) {
  return apiGet<PipelineFileResponse>(
    `/api/projects/${encodeURIComponent(projectName)}/pipelines/${encodeURIComponent(file)}`,
  );
}

export async function updatePipelineFile(
  projectName: string,
  file: string,
  content: string,
  etag: string,
): Promise<{ etag: string }> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectName)}/pipelines/${encodeURIComponent(file)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, etag }),
    },
  );
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`${res.status}: ${text}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

export async function createPipelineFile(
  projectName: string,
  name: string,
  template: 'blank' | 'sample' | 'active' = 'blank',
): Promise<{ name: string; content: string; etag: string }> {
  const res = await fetch(`/api/projects/${encodeURIComponent(projectName)}/pipelines`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, template }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json();
}

export async function deletePipelineFile(projectName: string, file: string): Promise<void> {
  const res = await fetch(
    `/api/projects/${encodeURIComponent(projectName)}/pipelines/${encodeURIComponent(file)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text}`);
  }
}
