/**
 * ACP File System Handlers — aligned with OpenClaw/acpx FileSystemHandlers
 *
 * Handles fs/read_text_file and fs/write_text_file ACP Client callbacks.
 * Enforces cwd sandbox and supports line-range slicing.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { PermissionMode } from './acp-permissions.js';

interface ReadTextFileRequest {
  path: string;
  line?: number;
  limit?: number;
}

interface WriteTextFileRequest {
  path: string;
  content: string;
}

export class FileSystemHandlers {
  private readonly rootDir: string;
  private readonly permissionMode: PermissionMode;

  constructor(opts: { cwd: string; permissionMode: PermissionMode }) {
    this.rootDir = path.resolve(opts.cwd);
    this.permissionMode = opts.permissionMode;
  }

  async readTextFile(params: ReadTextFileRequest): Promise<{ content: string }> {
    if (this.permissionMode === 'deny-all') {
      throw new Error('Permission denied for fs/read_text_file (deny-all)');
    }
    const filePath = this.resolvePathWithinRoot(params.path);
    const content = await readFile(filePath, 'utf-8');
    return { content: this.sliceContent(content, params.line, params.limit) };
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<Record<string, never>> {
    if (this.permissionMode === 'deny-all') {
      throw new Error('Permission denied for fs/write_text_file (deny-all)');
    }
    const filePath = this.resolvePathWithinRoot(params.path);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, params.content, 'utf-8');
    return {};
  }

  private resolvePathWithinRoot(rawPath: string): string {
    if (!path.isAbsolute(rawPath)) {
      throw new Error(`Path must be absolute: ${rawPath}`);
    }
    const resolved = path.resolve(rawPath);
    if (resolved !== this.rootDir && !resolved.startsWith(this.rootDir + path.sep)) {
      throw new Error(`Path outside allowed cwd subtree: ${resolved}`);
    }
    return resolved;
  }

  private sliceContent(content: string, line?: number, limit?: number): string {
    if (line == null && limit == null) return content;
    const lines = content.split('\n');
    const startIndex = Math.max(0, (line ?? 1) - 1);
    const endIndex = limit == null ? lines.length : Math.min(lines.length, startIndex + limit);
    return lines.slice(startIndex, endIndex).join('\n');
  }
}
