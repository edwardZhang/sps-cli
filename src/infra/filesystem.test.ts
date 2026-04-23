import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type FileSystem, InMemoryFileSystem, NodeFileSystem } from './filesystem.js';

function suite(name: string, factory: () => { fs: FileSystem; root: string; cleanup?: () => void }) {
  describe(name, () => {
    let tc: { fs: FileSystem; root: string; cleanup?: () => void };

    beforeEach(() => {
      tc = factory();
    });
    afterEach(() => {
      tc.cleanup?.();
    });

    it('write + read roundtrip', () => {
      const path = `${tc.root}/a.txt`;
      tc.fs.writeFile(path, 'hello');
      expect(tc.fs.exists(path)).toBe(true);
      expect(tc.fs.readFile(path)).toBe('hello');
    });

    it('writeFileAtomic 写入同样的内容', () => {
      const path = `${tc.root}/b.txt`;
      tc.fs.writeFileAtomic(path, 'atomic');
      expect(tc.fs.readFile(path)).toBe('atomic');
    });

    it('readFile 不存在抛', () => {
      expect(() => tc.fs.readFile(`${tc.root}/nope.txt`)).toThrow();
    });

    it('mkdir recursive 创建嵌套目录', () => {
      tc.fs.mkdir(`${tc.root}/a/b/c`, { recursive: true });
      expect(tc.fs.exists(`${tc.root}/a/b/c`)).toBe(true);
    });

    it('readDir 列出条目，标记 file/dir', () => {
      tc.fs.mkdir(`${tc.root}/x`, { recursive: true });
      tc.fs.writeFile(`${tc.root}/x/f.txt`, 'hi');
      tc.fs.mkdir(`${tc.root}/x/sub`, { recursive: true });
      const entries = tc.fs.readDir(`${tc.root}/x`);
      const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
      expect(byName['f.txt']?.isFile).toBe(true);
      expect(byName['sub']?.isDirectory).toBe(true);
    });

    it('stat 返回大小 / type', () => {
      tc.fs.writeFile(`${tc.root}/s.txt`, '12345');
      const st = tc.fs.stat(`${tc.root}/s.txt`);
      expect(st?.size).toBe(5);
      expect(st?.isFile).toBe(true);
      expect(st?.isDirectory).toBe(false);
    });

    it('stat 不存在返 null', () => {
      expect(tc.fs.stat(`${tc.root}/nope`)).toBeNull();
    });

    it('unlink 删文件', () => {
      tc.fs.writeFile(`${tc.root}/d.txt`, 'x');
      tc.fs.unlink(`${tc.root}/d.txt`);
      expect(tc.fs.exists(`${tc.root}/d.txt`)).toBe(false);
    });

    it('rm recursive 删目录', () => {
      tc.fs.mkdir(`${tc.root}/tree`, { recursive: true });
      tc.fs.writeFile(`${tc.root}/tree/a.txt`, 'x');
      tc.fs.rm(`${tc.root}/tree`, { recursive: true, force: true });
      expect(tc.fs.exists(`${tc.root}/tree`)).toBe(false);
    });

    it('rename 改位置', () => {
      tc.fs.writeFile(`${tc.root}/r1.txt`, 'moved');
      tc.fs.rename(`${tc.root}/r1.txt`, `${tc.root}/r2.txt`);
      expect(tc.fs.exists(`${tc.root}/r1.txt`)).toBe(false);
      expect(tc.fs.readFile(`${tc.root}/r2.txt`)).toBe('moved');
    });
  });
}

suite('NodeFileSystem', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'nfs-'));
  return {
    fs: new NodeFileSystem(),
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
});

suite('InMemoryFileSystem', () => {
  return {
    fs: new InMemoryFileSystem(),
    root: '/root',
  };
});
