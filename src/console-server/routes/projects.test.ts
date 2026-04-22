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

  // ── v0.49.3 Pipeline 文件 CRUD tests ──────────────────────────────

  it('GET /:name/pipelines/:file returns content + parsed + etag', async () => {
    const pipelinesDir = resolve(tmpHome, '.coral', 'projects', 'myproj', 'pipelines');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(
      resolve(pipelinesDir, 'project.yaml'),
      'mode: project\nstages:\n  - name: develop\n    on_complete: "move_card Done"\n',
    );
    const app = await buildApp();
    const res = await app.request('/api/projects/myproj/pipelines/project.yaml');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: string;
      etag: string;
      parsed: { mode: string; stages: Array<{ name: string }> } | null;
      parseError: string | null;
      isActive: boolean;
    };
    expect(body.isActive).toBe(true);
    expect(body.parseError).toBeNull();
    expect(body.parsed?.mode).toBe('project');
    expect(body.parsed?.stages?.[0]?.name).toBe('develop');
    expect(body.etag).toHaveLength(16);
  });

  it('GET /:name/pipelines/:file returns parseError when YAML malformed', async () => {
    const pipelinesDir = resolve(tmpHome, '.coral', 'projects', 'myproj', 'pipelines');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(resolve(pipelinesDir, 'broken.yaml'), 'stages:\n  - name: [unclosed\n');
    const app = await buildApp();
    const res = await app.request('/api/projects/myproj/pipelines/broken.yaml');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { parsed: unknown; parseError: string | null };
    expect(body.parsed).toBeNull();
    expect(body.parseError).toBeTruthy();
  });

  it('GET /:name/pipelines/:file rejects path traversal', async () => {
    const app = await buildApp();
    const res = await app.request('/api/projects/myproj/pipelines/..%2Fetc%2Fpasswd');
    expect(res.status).toBe(422);
  });

  it('PATCH /:name/pipelines/:file enforces etag + yaml validation', async () => {
    const pipelinesDir = resolve(tmpHome, '.coral', 'projects', 'myproj', 'pipelines');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(resolve(pipelinesDir, 'foo.yaml'), 'stages: []\n');
    const app = await buildApp();

    const getRes = await app.request('/api/projects/myproj/pipelines/foo.yaml');
    const { etag } = (await getRes.json()) as { etag: string };

    // Wrong etag → 409
    const wrong = await app.request('/api/projects/myproj/pipelines/foo.yaml', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'stages: [new]\n', etag: 'bogus' }),
    });
    expect(wrong.status).toBe(409);

    // Invalid YAML → 422
    const badYaml = await app.request('/api/projects/myproj/pipelines/foo.yaml', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'stages:\n  - [\n', etag }),
    });
    expect(badYaml.status).toBe(422);

    // Valid save → 200
    const ok = await app.request('/api/projects/myproj/pipelines/foo.yaml', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'mode: project\nstages:\n  - name: x\n    on_complete: "move_card Done"\n',
        etag,
      }),
    });
    expect(ok.status).toBe(200);
    const saved = readFileSync(resolve(pipelinesDir, 'foo.yaml'), 'utf-8');
    expect(saved).toContain('name: x');
  });

  it('POST /:name/pipelines creates with blank template by default', async () => {
    mkdirSync(resolve(tmpHome, '.coral', 'projects', 'myproj', 'pipelines'), { recursive: true });
    const app = await buildApp();
    const res = await app.request('/api/projects/myproj/pipelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'ci.yaml' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; content: string };
    expect(body.name).toBe('ci.yaml');
    expect(body.content).toContain('mode: project');
    expect(body.content).toContain('develop');
  });

  it('POST /:name/pipelines 409 when file exists', async () => {
    const pipelinesDir = resolve(tmpHome, '.coral', 'projects', 'myproj', 'pipelines');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(resolve(pipelinesDir, 'dup.yaml'), 'stages: []\n');

    const app = await buildApp();
    const res = await app.request('/api/projects/myproj/pipelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'dup.yaml' }),
    });
    expect(res.status).toBe(409);
  });

  it('POST /:name/pipelines with active template copies project.yaml', async () => {
    const pipelinesDir = resolve(tmpHome, '.coral', 'projects', 'myproj', 'pipelines');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(resolve(pipelinesDir, 'project.yaml'), 'mode: project\n# my active\n');

    const app = await buildApp();
    const res = await app.request('/api/projects/myproj/pipelines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'clone.yaml', template: 'active' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { content: string };
    expect(body.content).toContain('# my active');
  });

  it('DELETE /:name/pipelines/:file refuses project.yaml and sample', async () => {
    const pipelinesDir = resolve(tmpHome, '.coral', 'projects', 'myproj', 'pipelines');
    mkdirSync(pipelinesDir, { recursive: true });
    writeFileSync(resolve(pipelinesDir, 'project.yaml'), 'x\n');
    writeFileSync(resolve(pipelinesDir, 'sample.yaml.example'), 'y\n');

    const app = await buildApp();

    const r1 = await app.request('/api/projects/myproj/pipelines/project.yaml', {
      method: 'DELETE',
    });
    expect(r1.status).toBe(409);

    const r2 = await app.request('/api/projects/myproj/pipelines/sample.yaml.example', {
      method: 'DELETE',
    });
    expect(r2.status).toBe(409);
  });

  it('DELETE /:name/pipelines/:file removes non-active yaml', async () => {
    const pipelinesDir = resolve(tmpHome, '.coral', 'projects', 'myproj', 'pipelines');
    mkdirSync(pipelinesDir, { recursive: true });
    const f = resolve(pipelinesDir, 'scratch.yaml');
    writeFileSync(f, 'stages: []\n');

    const app = await buildApp();
    const res = await app.request('/api/projects/myproj/pipelines/scratch.yaml', {
      method: 'DELETE',
    });
    expect(res.status).toBe(204);
    expect(existsSync(f)).toBe(false);
  });

  it('GET /:name/pipelines returns available sorted alphabetically', async () => {
    const pipelinesDir = resolve(tmpHome, '.coral', 'projects', 'myproj', 'pipelines');
    mkdirSync(pipelinesDir, { recursive: true });
    // Write out of order
    writeFileSync(resolve(pipelinesDir, 'zulu.yaml'), 'x\n');
    writeFileSync(resolve(pipelinesDir, 'alpha.yaml'), 'x\n');
    writeFileSync(resolve(pipelinesDir, 'middle.yaml'), 'x\n');

    const app = await buildApp();
    const res = await app.request('/api/projects/myproj/pipelines');
    const body = (await res.json()) as { available: Array<{ name: string }> };
    expect(body.available.map((p) => p.name)).toEqual(['alpha.yaml', 'middle.yaml', 'zulu.yaml']);
  });
});
