/**
 * projects route tests — uses Hono app.fetch() to simulate HTTP requests.
 * Writes into a temp HOME so ~/.coral/projects/ stays clean.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// We need to import routes AFTER setting HOME, since PROJECTS_DIR is
// computed at module load. Use dynamic import inside tests.

describe('projects route', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tmpHome = mkdtempSync(resolve(tmpdir(), 'sps-test-home-'));
    process.env.HOME = tmpHome;
    // Pre-create ~/.coral/projects so GET / works
    mkdirSync(resolve(tmpHome, '.coral', 'projects'), { recursive: true });
    // Reset ESM module cache so the route picks up new HOME
    vi.resetModules();
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  async function buildApp() {
    const { createProjectsRoute } = await import('./projects.js');
    const { Hono } = await import('hono');
    const app = new Hono();
    app.route('/api/projects', createProjectsRoute());
    return app;
  }

  it('GET / returns empty list when no projects', async () => {
    const app = await buildApp();
    const res = await app.request('/api/projects');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it('GET /:name returns 404 for nonexistent', async () => {
    const app = await buildApp();
    const res = await app.request('/api/projects/nonexistent');
    expect(res.status).toBe(404);
  });

  it('GET /:name/conf with etag works for a manually-prepared project', async () => {
    // Write a project fixture directly
    const dir = resolve(tmpHome, '.coral', 'projects', 'myproj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'conf'), 'export PROJECT_NAME="myproj"\nexport PM_TOOL="markdown"\n');

    const app = await buildApp();
    const res = await app.request('/api/projects/myproj/conf');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: string; etag: string };
    expect(body.content).toContain('myproj');
    expect(body.etag).toHaveLength(16);
  });

  it('PATCH /:name/conf requires etag and validates', async () => {
    const dir = resolve(tmpHome, '.coral', 'projects', 'myproj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'conf'), 'export FOO="1"\n');

    const app = await buildApp();

    // Missing etag → 422
    const r1 = await app.request('/api/projects/myproj/conf', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'new' }),
    });
    expect(r1.status).toBe(422);

    // Wrong etag → 409
    const r2 = await app.request('/api/projects/myproj/conf', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'new', etag: 'bogus' }),
    });
    expect(r2.status).toBe(409);
  });

  it('PATCH /:name/conf succeeds with valid etag', async () => {
    const dir = resolve(tmpHome, '.coral', 'projects', 'myproj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, 'conf'), 'export FOO="1"\n');

    const app = await buildApp();
    const getRes = await app.request('/api/projects/myproj/conf');
    const { etag } = (await getRes.json()) as { etag: string };

    const patchRes = await app.request('/api/projects/myproj/conf', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'export FOO="2"\n', etag }),
    });
    expect(patchRes.status).toBe(200);
    const updated = readFileSync(resolve(dir, 'conf'), 'utf-8');
    expect(updated).toContain('FOO="2"');
  });

  it('DELETE /:name refuses when pipeline running', async () => {
    const dir = resolve(tmpHome, '.coral', 'projects', 'myproj');
    mkdirSync(resolve(dir, 'runtime'), { recursive: true });
    writeFileSync(resolve(dir, 'conf'), 'export PROJECT_DIR="/tmp/fake"\n');
    // Write supervisor.pid with OUR pid (we're alive for sure)
    writeFileSync(resolve(dir, 'runtime', 'supervisor.pid'), String(process.pid));

    const app = await buildApp();
    const res = await app.request('/api/projects/myproj', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    // Project should still exist
    expect(existsSync(dir)).toBe(true);
  });

  it('DELETE /:name removes project tree', async () => {
    const dir = resolve(tmpHome, '.coral', 'projects', 'myproj');
    mkdirSync(resolve(dir, 'cards'), { recursive: true });
    writeFileSync(resolve(dir, 'conf'), 'export PROJECT_DIR="/tmp/fake"\n');

    const app = await buildApp();
    const res = await app.request('/api/projects/myproj', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ includeClaudeDir: false }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(dir)).toBe(false);
  });

  it('GET /:name/pipelines returns available list and detects active', async () => {
    const pipelinesDir = resolve(tmpHome, '.coral', 'projects', 'myproj', 'pipelines');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(resolve(pipelinesDir, 'foo.yaml'), 'stages: [{name: a}]\n');
    writeFileSync(resolve(pipelinesDir, 'bar.yaml'), 'stages: [{name: b}]\n');
    writeFileSync(resolve(pipelinesDir, 'project.yaml'), 'stages: [{name: a}]\n'); // same as foo

    const app = await buildApp();
    const res = await app.request('/api/projects/myproj/pipelines');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { active: string | null; available: Array<{ name: string; isActive: boolean }> };
    expect(body.active).toBe('project.yaml');
    const foo = body.available.find((p) => p.name === 'foo.yaml');
    const bar = body.available.find((p) => p.name === 'bar.yaml');
    expect(foo?.isActive).toBe(true);
    expect(bar?.isActive).toBe(false);
  });

  it('PUT /:name/pipeline rejects invalid filename', async () => {
    mkdirSync(resolve(tmpHome, '.coral', 'projects', 'myproj', 'pipelines'), { recursive: true });
    const app = await buildApp();
    const res = await app.request('/api/projects/myproj/pipeline', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pipeline: '../etc/passwd' }),
    });
    expect(res.status).toBe(422);
  });
});
