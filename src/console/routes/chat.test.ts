/**
 * chat route tests — session CRUD + validation.
 * Streaming paths (daemon integration) covered by e2e, not here.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '../../core/logger.js';

describe('chat route', () => {
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
    const { createChatRoute } = await import('./chat.js');
    const { createContainer } = await import('../../services/container.js');
    const { Hono } = await import('hono');
    const app = new Hono();
    const log = new Logger('test', 'chat-test');
    const services = createContainer();
    app.route('/api/chat', createChatRoute(log, services.chat));
    return app;
  }

  it('GET /sessions empty when none', async () => {
    const app = await buildApp();
    const res = await app.request('/api/chat/sessions');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it('POST /sessions creates a session with default title', async () => {
    const app = await buildApp();
    const res = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; title: string; messageCount: number };
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.title).toBe('新对话');
    expect(body.messageCount).toBe(0);
  });

  it('POST /sessions honors custom title + project', async () => {
    const app = await buildApp();
    const res = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'debug session', project: 'acme' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { title: string; project: string };
    expect(body.title).toBe('debug session');
    expect(body.project).toBe('acme');
  });

  it('GET /sessions/:id returns 404 for missing', async () => {
    const app = await buildApp();
    const res = await app.request('/api/chat/sessions/nonexistent-id');
    expect(res.status).toBe(404);
  });

  it('GET /sessions/:id/messages filters by since', async () => {
    const app = await buildApp();
    // Create a session and write messages directly to its JSON to isolate from daemon
    const createRes = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'test' }),
    });
    const { id } = (await createRes.json()) as { id: string };

    // Manually inject messages
    const { existsSync, writeFileSync, readFileSync } = await import('node:fs');
    const sessionPath = resolve(tmpHome, '.coral', 'chat-sessions', `${id}.json`);
    expect(existsSync(sessionPath)).toBe(true);
    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    session.messages = [
      { id: 'm1', role: 'user', content: 'old', ts: '2020-01-01T00:00:00Z', status: 'complete' },
      { id: 'm2', role: 'assistant', content: 'mid', ts: '2025-01-01T00:00:00Z', status: 'complete' },
      { id: 'm3', role: 'user', content: 'new', ts: '2026-01-01T00:00:00Z', status: 'complete' },
    ];
    session.messageCount = 3;
    writeFileSync(sessionPath, JSON.stringify(session));

    // Fetch all
    const all = await app.request(`/api/chat/sessions/${id}/messages`);
    const allBody = (await all.json()) as { data: Array<{ id: string }>; total: number };
    expect(allBody.total).toBe(3);
    expect(allBody.data).toHaveLength(3);

    // Fetch since mid
    const since = await app.request(
      `/api/chat/sessions/${id}/messages?since=${encodeURIComponent('2025-06-01T00:00:00Z')}`,
    );
    const sinceBody = (await since.json()) as { data: Array<{ id: string }> };
    expect(sinceBody.data).toHaveLength(1);
    expect(sinceBody.data[0]?.id).toBe('m3');
  });

  it('DELETE /sessions/:id removes file', async () => {
    const app = await buildApp();
    const createRes = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { id } = (await createRes.json()) as { id: string };

    const { existsSync } = await import('node:fs');
    const sessionPath = resolve(tmpHome, '.coral', 'chat-sessions', `${id}.json`);
    expect(existsSync(sessionPath)).toBe(true);

    const del = await app.request(`/api/chat/sessions/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(existsSync(sessionPath)).toBe(false);
  });

  it('POST /sessions/:id/messages rejects empty content', async () => {
    const app = await buildApp();
    const createRes = await app.request('/api/chat/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const { id } = (await createRes.json()) as { id: string };

    const res = await app.request(`/api/chat/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });
});
