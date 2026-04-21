import { apiGet } from './client';

export interface SystemInfo {
  version: string;
  nodeVersion: string;
  startedAt: string;
  uptimeMs: number;
  platform: string;
}

export function getSystemInfo() {
  return apiGet<SystemInfo>('/api/system/info');
}
