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

export function listProjects() {
  return apiGet<{ data: ProjectSummary[] }>('/api/projects');
}

export function getProject(name: string) {
  return apiGet<ProjectSummary>(`/api/projects/${encodeURIComponent(name)}`);
}
