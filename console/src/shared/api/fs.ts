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

// ─── v0.51.8: Chat attachments ────────────────────────────────────

export interface UploadAttachmentResponse {
  /** Absolute path on local filesystem (suitable for sending to chat / Claude Read) */
  path: string;
  /** Original filename (display only) */
  name: string;
  /** Bytes */
  size: number;
  /** MIME type (may be empty if browser couldn't sniff) */
  mime: string;
}

/** 50 MB — front-end pre-check; server enforces too. */
export const ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Upload a file as a chat attachment. Server saves to
 * ~/.coral/chat-attachments/<sessionId>/<stamped-name> and returns the absolute path.
 *
 * Throws if file > 50 MB (pre-checked) or the upload fails.
 */
export async function uploadAttachment(
  sessionId: string,
  file: File,
): Promise<UploadAttachmentResponse> {
  if (file.size > ATTACHMENT_MAX_BYTES) {
    throw new Error(
      `文件超过 50 MB 上限（当前 ${(file.size / 1024 / 1024).toFixed(2)} MB）`,
    );
  }
  const fd = new FormData();
  fd.append('sessionId', sessionId);
  fd.append('file', file, file.name);
  const res = await fetch('/api/fs/upload', { method: 'POST', body: fd });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status}: ${body}`);
  }
  return (await res.json()) as UploadAttachmentResponse;
}

/**
 * Build the URL for previewing an attachment via /api/fs/file.
 *
 * Returns a string that can be used as `<img src>` / fetch target.
 * Server validates path is authorized for sessionId before serving.
 */
export function attachmentUrl(sessionId: string, path: string): string {
  const qs = new URLSearchParams({ path, sessionId });
  return `/api/fs/file?${qs.toString()}`;
}
