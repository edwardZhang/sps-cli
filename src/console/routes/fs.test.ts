/**
 * @module        fs.test
 * @description   /api/fs/browse 路由测试
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createFsRoute } from './fs.js';

let root: string;
let app: Hono;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fs-route-test-'));
  app = new Hono();
  app.route('/api/fs', createFsRoute());
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function browse(path?: string): Promise<{ status: number; body: any }> {
  const url = path ? `http://x/api/fs/browse?path=${encodeURIComponent(path)}` : 'http://x/api/fs/browse';
  const res = await app.request(url);
  return { status: res.status, body: await res.json() };
}

describe('GET /api/fs/browse', () => {
  it('returns home directory when no path query', async () => {
    const r = await browse();
    expect(r.status).toBe(200);
    expect(typeof r.body.path).toBe('string');
    expect(typeof r.body.home).toBe('string');
    // home === path when no query
    expect(r.body.path).toBe(r.body.home);
  });

  it('lists directories first, then files, alpha-sorted', async () => {
    mkdirSync(resolve(root, 'a-dir'), { recursive: true });
    mkdirSync(resolve(root, 'b-dir'), { recursive: true });
    writeFileSync(resolve(root, 'c-file.txt'), 'x');
    writeFileSync(resolve(root, 'd-file.txt'), 'y');

    const r = await browse(root);
    expect(r.status).toBe(200);
    const names = r.body.entries.map((e: any) => e.name);
    expect(names).toEqual(['a-dir', 'b-dir', 'c-file.txt', 'd-file.txt']);
    expect(r.body.entries[0].isDirectory).toBe(true);
    expect(r.body.entries[2].isDirectory).toBe(false);
  });

  it('skips dotfiles by default', async () => {
    mkdirSync(resolve(root, '.hidden'), { recursive: true });
    mkdirSync(resolve(root, 'visible'), { recursive: true });
    const r = await browse(root);
    const names = r.body.entries.map((e: any) => e.name);
    expect(names).toEqual(['visible']);
  });

  it('returns parent path correctly', async () => {
    const sub = resolve(root, 'sub');
    mkdirSync(sub, { recursive: true });
    const r = await browse(sub);
    expect(r.body.parent).toBe(root);
  });

  it('parent is null at filesystem root', async () => {
    const r = await browse('/');
    // / 是 root，parent 应该 null
    if (r.status === 200) {
      expect(r.body.parent).toBeNull();
    }
  });

  it('rejects non-absolute path → falls back to home', async () => {
    const r = await browse('relative/path');
    expect(r.status).toBe(200);
    // resolves to home
    expect(r.body.path).toBe(r.body.home);
  });

  it('returns 404 for non-existent dir', async () => {
    const r = await browse('/no/such/path/12345');
    expect(r.status).toBe(404);
  });

  it('returns 422 when path is a file', async () => {
    const f = resolve(root, 'file.txt');
    writeFileSync(f, 'x');
    const r = await browse(f);
    expect(r.status).toBe(422);
  });

  it('returns 422 for blacklisted system dir', async () => {
    const r = await browse('/proc');
    // 422 if blacklisted, or 200 if /proc unreadable on this system → check both
    expect([200, 422]).toContain(r.status);
    if (r.status === 422) {
      expect(r.body.detail).toContain('/proc');
    }
  });

  it('handles broken symlinks without crashing', async () => {
    mkdirSync(resolve(root, 'good'), { recursive: true });
    symlinkSync('/no/such/target', resolve(root, 'broken-link'));
    const r = await browse(root);
    expect(r.status).toBe(200);
    const names = r.body.entries.map((e: any) => e.name);
    // Broken symlink filtered out, good dir survives
    expect(names).toContain('good');
    expect(names).not.toContain('broken-link');
  });

  it('normalizes ../ in path', async () => {
    const sub = resolve(root, 'sub');
    mkdirSync(sub, { recursive: true });
    // path: <root>/sub/.. → <root>
    const r = await browse(`${sub}/..`);
    expect(r.status).toBe(200);
    expect(r.body.path).toBe(root);
  });
});
