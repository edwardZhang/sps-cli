/**
 * system route tests — env get/patch + info.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('system route', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = mkdtempSync(resolve(tmpdir(), 'sps-test-home-'));
    process.env.HOME = tmpHome;
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  async function buildApp() {
    const { createSystemRoute } = await import('./system.js');
    const { Hono } = await import('hono');
    const app = new Hono();
    app.route('/api/system', createSystemRoute('0.49.0', new Date()));
    return app;
  }

  it('GET /info returns version + runtime', async () => {
    const app = await buildApp();
    const res = await app.request('/api/system/info');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { version: string; nodeVersion: string; platform: string };
    expect(body.version).toBe('0.49.0');
    expect(body.nodeVersion).toMatch(/^v\d+/);
    expect(body.platform).toBe(process.platform);
  });

  it('GET /env reports exists:false when env missing', async () => {
    const app = await buildApp();
    const res = await app.request('/api/system/env');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { exists: boolean; entries: unknown[] };
    expect(body.exists).toBe(false);
    expect(body.entries).toEqual([]);
  });

  it('GET /env masks secret keys', async () => {
    mkdirSync(resolve(tmpHome, '.coral'), { recursive: true });
    writeFileSync(
      resolve(tmpHome, '.coral', 'env'),
      'export GITLAB_URL="https://example.com"\nexport GITLAB_TOKEN="glpat-1234567890"\n',
    );
    const app = await buildApp();
    const res = await app.request('/api/system/env');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ key: string; value: string; masked: boolean }>;
    };
    const url = body.entries.find((e) => e.key === 'GITLAB_URL');
    const token = body.entries.find((e) => e.key === 'GITLAB_TOKEN');
    expect(url?.masked).toBe(false);
    expect(url?.value).toBe('https://example.com');
    expect(token?.masked).toBe(true);
    expect(token?.value).not.toContain('1234567890');
  });

  it('PATCH /env creates file with 0600 on first save', async () => {
    const app = await buildApp();
    const res = await app.request('/api/system/env', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'export FOO="bar"\n' }),
    });
    expect(res.status).toBe(200);
    const envPath = resolve(tmpHome, '.coral', 'env');
    expect(existsSync(envPath)).toBe(true);
    const mode = statSync(envPath).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(envPath, 'utf-8')).toContain('FOO="bar"');
  });

  it('PATCH /env rejects without etag when file exists', async () => {
    mkdirSync(resolve(tmpHome, '.coral'), { recursive: true });
    writeFileSync(resolve(tmpHome, '.coral', 'env'), 'existing\n');

    const app = await buildApp();
    const res = await app.request('/api/system/env', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'new' }),
    });
    expect(res.status).toBe(422);
  });

  it('PATCH /env 409 on etag mismatch, 200 on correct etag', async () => {
    mkdirSync(resolve(tmpHome, '.coral'), { recursive: true });
    writeFileSync(resolve(tmpHome, '.coral', 'env'), 'existing\n');
    const app = await buildApp();

    // Read current etag via /env/raw
    const rawRes = await app.request('/api/system/env/raw');
    const { etag } = (await rawRes.json()) as { etag: string };

    // Wrong etag → 409
    const bad = await app.request('/api/system/env', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'new', etag: 'bogus' }),
    });
    expect(bad.status).toBe(409);

    // Correct etag → 200
    const ok = await app.request('/api/system/env', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'updated\n', etag }),
    });
    expect(ok.status).toBe(200);
  });
});
