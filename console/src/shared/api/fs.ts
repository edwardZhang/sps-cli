import { apiGet } from './client';

export interface FsEntry {
  name: string;
  isDirectory: boolean;
}

export interface FsBrowseResponse {
  /** Absolute path of the directory being listed */
  path: string;
  /** Parent directory absolute path; null at filesystem root */
  parent: string | null;
  entries: FsEntry[];
  /** User's home directory (UI shows "回到 home" shortcut) */
  home: string;
}

/**
 * Browse a directory on the local filesystem (read-only listing).
 * No `path` arg → returns user's home directory contents.
 */
export function browseDirectory(path?: string): Promise<FsBrowseResponse> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  return apiGet<FsBrowseResponse>(`/api/fs/browse${qs}`);
}
