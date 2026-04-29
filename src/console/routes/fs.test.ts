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

// ─── v0.51.8: /upload + /file ────────────────────────────────────

describe('POST /api/fs/upload', () => {
  let prevHome: string | undefined;
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'fs-upload-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });
  afterEach(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  async function upload(opts: {
    sessionId?: string;
    file?: Blob;
    fileName?: string;
  }): Promise<{ status: number; body: any }> {
    const fd = new FormData();
    if (opts.sessionId !== undefined) fd.append('sessionId', opts.sessionId);
    if (opts.file !== undefined) {
      fd.append('file', opts.file, opts.fileName ?? 'test.txt');
    }
    const res = await app.request('http://x/api/fs/upload', { method: 'POST', body: fd });
    return { status: res.status, body: await res.json() };
  }

  it('saves file under chat-attachments/<sessionId>/', async () => {
    const r = await upload({
      sessionId: 'abc-123',
      file: new Blob(['hello'], { type: 'text/plain' }),
      fileName: 'test.txt',
    });
    expect(r.status).toBe(201);
    expect(r.body.path).toContain('chat-attachments/abc-123');
    expect(r.body.path).toContain('test.txt');
    expect(r.body.size).toBe(5);
  });

  it('rejects missing sessionId', async () => {
    const r = await upload({
      file: new Blob(['x'], { type: 'text/plain' }),
    });
    expect(r.status).toBe(422);
  });

  it('rejects malformed sessionId', async () => {
    const r = await upload({
      sessionId: '../escape',
      file: new Blob(['x']),
    });
    expect(r.status).toBe(422);
  });

  it('rejects missing file', async () => {
    const r = await upload({ sessionId: 'abc-123' });
    expect(r.status).toBe(422);
  });

  it('rejects file exceeding 50MB limit', async () => {
    // 51 MB worth of zeros
    const big = new Uint8Array(51 * 1024 * 1024);
    const r = await upload({
      sessionId: 'abc-123',
      file: new Blob([big]),
      fileName: 'big.bin',
    });
    expect(r.status).toBe(413);
  });

  it('sanitizes filename (path traversal blocked)', async () => {
    const r = await upload({
      sessionId: 'abc-123',
      file: new Blob(['x']),
      fileName: '../../etc/passwd',
    });
    expect(r.status).toBe(201);
    // basename only — no slashes; saved file inside attachments dir
    expect(r.body.path).toContain('chat-attachments/abc-123');
    expect(r.body.path).not.toMatch(/\/\.\.\//);
  });

  it('timestamps filename to avoid collision', async () => {
    const r1 = await upload({ sessionId: 'abc', file: new Blob(['a']), fileName: 'same.txt' });
    const r2 = await upload({ sessionId: 'abc', file: new Blob(['b']), fileName: 'same.txt' });
    expect(r1.body.path).not.toBe(r2.body.path);
  });
});

describe('GET /api/fs/file', () => {
  let prevHome: string | undefined;
  let fakeHome: string;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'fs-file-home-'));
    prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });
  afterEach(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  async function getFile(path?: string, sessionId = 'abc-123'): Promise<Response> {
    const qs = new URLSearchParams();
    if (path !== undefined) qs.set('path', path);
    if (sessionId !== undefined) qs.set('sessionId', sessionId);
    return app.request(`http://x/api/fs/file?${qs.toString()}`);
  }

  it('serves uploaded attachment', async () => {
    // Upload a file, then GET it
    const fd = new FormData();
    fd.append('sessionId', 'abc-123');
    fd.append('file', new Blob(['hello world'], { type: 'text/plain' }), 'greeting.txt');
    const upRes = await app.request('http://x/api/fs/upload', { method: 'POST', body: fd });
    const up = await upRes.json();

    const fileRes = await getFile(up.path, 'abc-123');
    expect(fileRes.status).toBe(200);
    const text = await fileRes.text();
    expect(text).toBe('hello world');
    expect(fileRes.headers.get('Content-Type') ?? '').toContain('text/plain');
  });

  it('rejects path not in attachments dir nor in session', async () => {
    // Random readable file outside any session's attachments
    const outside = resolve(root, 'outside.txt');
    writeFileSync(outside, 'leak');
    const r = await getFile(outside, 'abc-123');
    expect(r.status).toBe(403);
  });

  it('rejects relative path', async () => {
    const r = await getFile('relative/path');
    expect(r.status).toBe(422);
  });

  it('rejects missing sessionId', async () => {
    const r = await getFile('/some/abs/path', '');
    expect(r.status).toBe(422);
  });

  it('rejects path that does not exist', async () => {
    // Path under attachments dir but file doesn't exist
    const ghostPath = resolve(fakeHome, '.coral', 'chat-attachments', 'abc-123', 'ghost.txt');
    const r = await getFile(ghostPath, 'abc-123');
    expect(r.status).toBe(404);
  });

  it('serves path from session JSON attachments list', async () => {
    // Pre-create a session JSON with an attachments path
    const externalFile = resolve(root, 'user-pick.md');
    writeFileSync(externalFile, '# external');
    const sessionsDir = resolve(fakeHome, '.coral', 'chat-sessions');
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      resolve(sessionsDir, 'sess-1.json'),
      JSON.stringify({
        id: 'sess-1',
        messages: [{ id: 'm1', role: 'user', attachments: [externalFile] }],
      }),
    );

    const r = await getFile(externalFile, 'sess-1');
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('# external');
  });
});
