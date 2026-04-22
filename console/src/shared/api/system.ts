import { apiGet } from './client';

export interface SystemInfo {
  version: string;
  nodeVersion: string;
  startedAt: string;
  uptimeMs: number;
  platform: string;
  pid?: number;
}

export interface EnvEntry {
  key: string;
  value: string;
  masked: boolean;
}

export interface DoctorReport {
  project: string;
  issues: string[];
  ok: boolean;
}

export function getSystemInfo() {
  return apiGet<SystemInfo>('/api/system/info');
}

export function getEnv() {
  return apiGet<{ path: string; exists: boolean; entries: EnvEntry[] }>('/api/system/env');
}

export function runDoctor() {
  return apiGet<{ data: DoctorReport[] }>('/api/system/doctor/all');
}

export interface EnvRaw {
  path: string;
  exists: boolean;
  content: string;
  etag: string;
}

export function getEnvRaw() {
  return apiGet<EnvRaw>('/api/system/env/raw');
}

export async function updateEnv(content: string, etag: string): Promise<{ etag: string }> {
  const res = await fetch('/api/system/env', {
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

export function getLatestVersion() {
  return apiGet<{ current: string; latest: string; upToDate: boolean }>('/api/system/latest-version');
}

export async function upgradeSps(): Promise<{ ok: boolean; output: string }> {
  const res = await fetch('/api/system/upgrade', { method: 'POST' });
  if (!res.ok && res.status !== 409) {
    throw new Error(`${res.status}: ${await res.text()}`);
  }
  return res.json();
}
