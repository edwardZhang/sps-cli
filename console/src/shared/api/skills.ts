import { apiGet } from './client';

export type SkillCategory = 'language' | 'end' | 'persona' | 'workflow' | 'other';
export type SkillState = 'absent' | 'linked' | 'frozen';

export interface SkillSummary {
  name: string;
  category: SkillCategory;
  description: string;
  origin: string;
  linkedProjects: string[];
  stateInProject?: SkillState;
}

export interface SkillDetail {
  name: string;
  category: SkillCategory;
  description: string;
  origin: string;
  body: string;
  references: Array<{ name: string; lines: number }>;
  linkedProjects: Array<{ project: string; state: 'linked' | 'frozen' }>;
}

export function listSkills(project?: string) {
  const qs = project ? `?project=${encodeURIComponent(project)}` : '';
  return apiGet<{ data: SkillSummary[] }>(`/api/skills${qs}`);
}

export function getSkill(name: string) {
  return apiGet<SkillDetail>(`/api/skills/${encodeURIComponent(name)}`);
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

export function linkSkill(name: string, project: string) {
  return postJson(`/api/skills/${encodeURIComponent(name)}/link`, { project });
}
export function unlinkSkill(name: string, project: string) {
  return fetch(
    `/api/skills/${encodeURIComponent(name)}/link?project=${encodeURIComponent(project)}`,
    { method: 'DELETE' },
  ).then((r) => {
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  });
}
export function freezeSkill(name: string, project: string) {
  return postJson(`/api/skills/${encodeURIComponent(name)}/freeze`, { project });
}
export function unfreezeSkill(name: string, project: string) {
  return postJson(`/api/skills/${encodeURIComponent(name)}/unfreeze`, { project });
}
export function syncSkills() {
  return postJson('/api/skills/sync');
}
