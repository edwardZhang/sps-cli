import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileSystemHandlers } from './acp-fs-handlers.js';

const TEST_DIR = '/tmp/sps-acp-fs-test';

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  writeFileSync(join(TEST_DIR, 'hello.txt'), 'line1\nline2\nline3\nline4\nline5\n');
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('FileSystemHandlers', () => {
  describe('readTextFile', () => {
    it('reads entire file', async () => {
      const fs = new FileSystemHandlers({ cwd: TEST_DIR, permissionMode: 'approve-all' });
      const result = await fs.readTextFile({ path: join(TEST_DIR, 'hello.txt') });
      expect(result.content).toBe('line1\nline2\nline3\nline4\nline5\n');
    });

    it('slices by line and limit', async () => {
      const fs = new FileSystemHandlers({ cwd: TEST_DIR, permissionMode: 'approve-all' });
      const result = await fs.readTextFile({ path: join(TEST_DIR, 'hello.txt'), line: 2, limit: 2 });
      expect(result.content).toBe('line2\nline3');
    });

    it('slices from line without limit', async () => {
      const fs = new FileSystemHandlers({ cwd: TEST_DIR, permissionMode: 'approve-all' });
      const result = await fs.readTextFile({ path: join(TEST_DIR, 'hello.txt'), line: 4 });
      expect(result.content).toBe('line4\nline5\n');
    });

    it('rejects path outside cwd', async () => {
      const fs = new FileSystemHandlers({ cwd: TEST_DIR, permissionMode: 'approve-all' });
      await expect(fs.readTextFile({ path: '/etc/passwd' })).rejects.toThrow('outside');
    });

    it('rejects relative path', async () => {
      const fs = new FileSystemHandlers({ cwd: TEST_DIR, permissionMode: 'approve-all' });
      await expect(fs.readTextFile({ path: 'hello.txt' })).rejects.toThrow('absolute');
    });

    it('denies in deny-all mode', async () => {
      const fs = new FileSystemHandlers({ cwd: TEST_DIR, permissionMode: 'deny-all' });
      await expect(fs.readTextFile({ path: join(TEST_DIR, 'hello.txt') })).rejects.toThrow('denied');
    });
  });

  describe('writeTextFile', () => {
    it('writes file', async () => {
      const fs = new FileSystemHandlers({ cwd: TEST_DIR, permissionMode: 'approve-all' });
      await fs.writeTextFile({ path: join(TEST_DIR, 'out.txt'), content: 'hello' });
      expect(readFileSync(join(TEST_DIR, 'out.txt'), 'utf-8')).toBe('hello');
    });

    it('creates parent directories', async () => {
      const fs = new FileSystemHandlers({ cwd: TEST_DIR, permissionMode: 'approve-all' });
      const nested = join(TEST_DIR, 'sub', 'dir', 'file.txt');
      await fs.writeTextFile({ path: nested, content: 'nested' });
      expect(readFileSync(nested, 'utf-8')).toBe('nested');
    });

    it('rejects path outside cwd', async () => {
      const fs = new FileSystemHandlers({ cwd: TEST_DIR, permissionMode: 'approve-all' });
      await expect(fs.writeTextFile({ path: '/tmp/outside.txt', content: 'x' })).rejects.toThrow('outside');
    });

    it('denies in deny-all mode', async () => {
      const fs = new FileSystemHandlers({ cwd: TEST_DIR, permissionMode: 'deny-all' });
      await expect(fs.writeTextFile({ path: join(TEST_DIR, 'x.txt'), content: 'x' })).rejects.toThrow('denied');
    });
  });
});
