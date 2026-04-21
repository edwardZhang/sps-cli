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
