/**
 * @module        infra/filesystem
 * @description   FileSystem port —— 文件系统抽象 + 真/内存实现
 *
 * @layer         infra
 *
 * Service 层不直接 import fs；通过这个端口操作。
 * 目的：
 *   1. 可单测（InMemoryFileSystem 零 IO）
 *   2. 原子写 / 目录扫描等操作有统一 API，不再各处写 writeFileSync + rename
 *   3. 未来想换成云端 KV 或远程存储，port 抽象让上层无感
 */
import {
  type Dirent,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

export interface FileStat {
  size: number;
  mtimeMs: number;
  isDirectory: boolean;
  isFile: boolean;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

export interface FileSystem {
  exists(path: string): boolean;
  stat(path: string): FileStat | null;
  readFile(path: string): string;
  /** 原子写 —— 先写 .tmp 再 rename，避免 reader 看到半截内容 */
  writeFileAtomic(path: string, content: string): void;
  /** 非原子写，少数场景用（如 append log） */
  writeFile(path: string, content: string): void;
  readDir(path: string): DirEntry[];
  mkdir(path: string, opts?: { recursive?: boolean }): void;
  unlink(path: string): void;
  /** 递归删除目录或文件 */
  rm(path: string, opts?: { recursive?: boolean; force?: boolean }): void;
  rename(from: string, to: string): void;
}

// ─── 真文件系统 ────────────────────────────────────────────────────

export class NodeFileSystem implements FileSystem {
  exists(path: string): boolean {
    return existsSync(path);
  }

  stat(path: string): FileStat | null {
    try {
      const s = statSync(path);
      return {
        size: s.size,
        mtimeMs: s.mtimeMs,
        isDirectory: s.isDirectory(),
        isFile: s.isFile(),
      };
    } catch {
      return null;
    }
  }

  readFile(path: string): string {
    return readFileSync(path, 'utf-8');
  }

  writeFileAtomic(path: string, content: string): void {
    const tmp = `${path}.tmp`;
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  }

  writeFile(path: string, content: string): void {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, content);
  }

  readDir(path: string): DirEntry[] {
    const entries = readdirSync(path, { withFileTypes: true });
    return entries.map((e: Dirent) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    }));
  }

  mkdir(path: string, opts: { recursive?: boolean } = {}): void {
    mkdirSync(path, { recursive: opts.recursive ?? false });
  }

  unlink(path: string): void {
    unlinkSync(path);
  }

  rm(path: string, opts: { recursive?: boolean; force?: boolean } = {}): void {
    rmSync(path, { recursive: opts.recursive ?? false, force: opts.force ?? false });
  }

  rename(from: string, to: string): void {
    renameSync(from, to);
  }
}

// ─── 内存文件系统（测试用） ────────────────────────────────────────

interface MemoryEntry {
  kind: 'file' | 'dir';
  content?: string;
  mtimeMs: number;
  children?: Map<string, MemoryEntry>; // only dir
}

/**
 * 简版内存 FS —— 支持 absolute path 的读写/扫描/删除。
 * 用于 Service 层单测：构造场景快、清理干净、不依赖 tmp 目录。
 * 不追求和 POSIX 100% 语义一致，够测试用即可。
 */
export class InMemoryFileSystem implements FileSystem {
  private root: MemoryEntry;
  private counter = 0;
  private readonly nowFn: () => number;

  /**
   * @param opts.nowFn 自定义"写入时的 mtime 生成器"。默认用 Date.now()（和 Node FS 语义一致）。
   *                   测试想要精确控制 mtime 可以传 FakeClock 的 now 方法。
   */
  constructor(opts: { nowFn?: () => number } = {}) {
    this.nowFn = opts.nowFn ?? (() => Date.now());
    this.root = { kind: 'dir', mtimeMs: this.nowFn(), children: new Map() };
  }

  private tick(): number {
    // 递增计数避免同毫秒下两次 write 得到相同 mtimeMs（测试偶有）
    this.counter += 1;
    return this.nowFn() + (this.counter % 1000) * 0.001;
  }

  private walk(path: string, createDirs: boolean): MemoryEntry | null {
    const parts = path.split('/').filter(Boolean);
    let node: MemoryEntry = this.root;
    for (let i = 0; i < parts.length; i++) {
      if (node.kind !== 'dir' || !node.children) return null;
      const name = parts[i]!;
      let child = node.children.get(name);
      if (!child) {
        if (!createDirs) return null;
        if (i === parts.length - 1) return null;
        child = { kind: 'dir', mtimeMs: this.tick(), children: new Map() };
        node.children.set(name, child);
      }
      node = child;
    }
    return node;
  }

  /**
   * 找到 path 的父目录节点 + basename；父不存在时按 createDirs 决定是否补齐。
   * 返回 null 仅当 path 为空。
   */
  private walkParent(
    path: string,
    createDirs = false,
  ): { parent: MemoryEntry; name: string } | null {
    const parts = path.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    const name = parts[parts.length - 1]!;
    const parentParts = parts.slice(0, -1);
    let node: MemoryEntry = this.root;
    for (const p of parentParts) {
      if (!node.children) node.children = new Map();
      let next = node.children.get(p);
      if (!next) {
        if (!createDirs) return null;
        next = { kind: 'dir', mtimeMs: this.tick(), children: new Map() };
        node.children.set(p, next);
      }
      if (next.kind !== 'dir') return null;
      node = next;
    }
    return { parent: node, name };
  }

  exists(path: string): boolean {
    return this.walk(path, false) !== null;
  }

  stat(path: string): FileStat | null {
    const n = this.walk(path, false);
    if (!n) return null;
    return {
      size: n.kind === 'file' ? (n.content?.length ?? 0) : 0,
      mtimeMs: n.mtimeMs,
      isDirectory: n.kind === 'dir',
      isFile: n.kind === 'file',
    };
  }

  readFile(path: string): string {
    const n = this.walk(path, false);
    if (!n || n.kind !== 'file' || n.content === undefined) {
      throw new Error(`ENOENT: no such file, ${path}`);
    }
    return n.content;
  }

  writeFileAtomic(path: string, content: string): void {
    this.writeFile(path, content);
  }

  writeFile(path: string, content: string): void {
    const info = this.walkParent(path, true);
    if (!info) throw new Error(`invalid path: ${path}`);
    if (!info.parent.children) info.parent.children = new Map();
    info.parent.children.set(info.name, { kind: 'file', content, mtimeMs: this.tick() });
  }

  readDir(path: string): DirEntry[] {
    const n = this.walk(path, false);
    if (!n || n.kind !== 'dir' || !n.children) {
      throw new Error(`ENOENT: not a directory, ${path}`);
    }
    return [...n.children.entries()].map(([name, e]) => ({
      name,
      isDirectory: e.kind === 'dir',
      isFile: e.kind === 'file',
    }));
  }

  mkdir(path: string, opts: { recursive?: boolean } = {}): void {
    const parts = path.split('/').filter(Boolean);
    let node = this.root;
    for (let i = 0; i < parts.length; i++) {
      if (!node.children) node.children = new Map();
      const name = parts[i]!;
      const child = node.children.get(name);
      if (child) {
        if (child.kind !== 'dir') throw new Error(`exists but not a dir: ${name}`);
        node = child;
        continue;
      }
      if (!opts.recursive && i !== parts.length - 1) {
        throw new Error(`ENOENT: parent does not exist: ${parts.slice(0, i).join('/')}`);
      }
      const fresh: MemoryEntry = { kind: 'dir', mtimeMs: this.tick(), children: new Map() };
      node.children.set(name, fresh);
      node = fresh;
    }
  }

  unlink(path: string): void {
    const info = this.walkParent(path);
    if (!info || !info.parent.children || !info.parent.children.has(info.name)) {
      throw new Error(`ENOENT: no such file, ${path}`);
    }
    const e = info.parent.children.get(info.name)!;
    if (e.kind !== 'file') throw new Error(`is a directory: ${path}`);
    info.parent.children.delete(info.name);
  }

  rm(path: string, opts: { recursive?: boolean; force?: boolean } = {}): void {
    const info = this.walkParent(path);
    if (!info || !info.parent.children || !info.parent.children.has(info.name)) {
      if (opts.force) return;
      throw new Error(`ENOENT: no such entry, ${path}`);
    }
    const e = info.parent.children.get(info.name)!;
    if (e.kind === 'dir' && !opts.recursive) {
      throw new Error(`EISDIR: directory not empty, ${path}`);
    }
    info.parent.children.delete(info.name);
  }

  rename(from: string, to: string): void {
    const src = this.walkParent(from);
    if (!src || !src.parent.children || !src.parent.children.has(src.name)) {
      throw new Error(`ENOENT: source not found, ${from}`);
    }
    const e = src.parent.children.get(src.name)!;
    src.parent.children.delete(src.name);
    this.writeEntryAt(to, e);
  }

  private writeEntryAt(path: string, entry: MemoryEntry): void {
    const info = this.walkParent(path, true);
    if (!info) throw new Error(`invalid path: ${path}`);
    if (!info.parent.children) info.parent.children = new Map();
    info.parent.children.set(info.name, entry);
  }
}
