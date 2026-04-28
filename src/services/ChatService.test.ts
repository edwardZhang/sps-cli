import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../infra/clock.js';
import { InMemoryFileSystem } from '../infra/filesystem.js';
import { InMemoryEventBus } from '../shared/domainEvents.js';
import { chatSessionsDir } from '../shared/runtimePaths.js';
import { type ChatExecutor, ChatService } from './ChatService.js';

function newSvc(extra?: { executor?: ChatExecutor }) {
  const fs = new InMemoryFileSystem();
  const clock = new FakeClock(new Date('2026-04-23T12:00:00Z'));
  const events = new InMemoryEventBus();
  const svc = new ChatService({ fs, clock, events, executor: extra?.executor });
  return { svc, fs, clock };
}

describe('ChatService', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    process.env.HOME = '/h';
  });
  afterEach(() => {
    process.env.HOME = prev;
  });

  it('list 无 session 返空', async () => {
    const { svc } = newSvc();
    const r = await svc.list();
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('create → list 返新 session', async () => {
    const { svc } = newSvc();
    const created = await svc.create({ title: 'hello' });
    expect(created.ok).toBe(true);
    const r = await svc.list();
    if (r.ok) {
      expect(r.value).toHaveLength(1);
      expect(r.value[0]?.title).toBe('hello');
    }
  });

  it('create 缺 title 默认 "新对话"', async () => {
    const { svc } = newSvc();
    const r = await svc.create();
    if (r.ok) expect(r.value.title).toBe('新对话');
  });

  it('get 不存在 → not-found', async () => {
    const { svc } = newSvc();
    const r = await svc.get('nonexistent-uuid');
    if (!r.ok) expect(r.error.code).toBe('CHAT_SESSION_NOT_FOUND');
  });

  it('get 成功返完整 session', async () => {
    const { svc } = newSvc();
    const c = await svc.create({ title: 'X' });
    if (!c.ok) throw new Error();
    const r = await svc.get(c.value.id);
    if (r.ok) {
      expect(r.value.title).toBe('X');
      expect(r.value.messages).toEqual([]);
    }
  });

  it('get 非法 id → validation', async () => {
    const { svc } = newSvc();
    const r = await svc.get('../etc/passwd');
    if (!r.ok) expect(r.error.kind).toBe('validation');
  });

  it('getMessages since 过滤', async () => {
    const { svc, fs } = newSvc();
    const c = await svc.create();
    if (!c.ok) throw new Error();
    // 手动写入 messages
    const path = `${chatSessionsDir()}/${c.value.id}.json`;
    fs.writeFile(
      path,
      JSON.stringify({
        id: c.value.id,
        createdAt: c.value.createdAt,
        lastMessageAt: null,
        title: 'X',
        project: null,
        messageCount: 2,
        messages: [
          { id: 'm1', role: 'user', content: 'hi', ts: '2026-04-23T10:00:00Z' },
          { id: 'm2', role: 'assistant', content: 'hello', ts: '2026-04-23T11:00:00Z' },
        ],
      }),
    );
    const r = await svc.getMessages(c.value.id, '2026-04-23T10:30:00Z');
    if (r.ok) {
      expect(r.value.data).toHaveLength(1);
      expect(r.value.data[0]?.id).toBe('m2');
      expect(r.value.total).toBe(2);
    }
  });

  it('delete 存在的会话 → 文件消失', async () => {
    const { svc, fs } = newSvc();
    const c = await svc.create();
    if (!c.ok) throw new Error();
    const path = `${chatSessionsDir()}/${c.value.id}.json`;
    expect(fs.exists(path)).toBe(true);
    const r = await svc.delete(c.value.id);
    expect(r.ok).toBe(true);
    expect(fs.exists(path)).toBe(false);
  });

  it('delete 不存在的会话也 ok (幂等)', async () => {
    const { svc } = newSvc();
    const r = await svc.delete('a1b2c3d4-0000-0000-0000-000000000000');
    expect(r.ok).toBe(true);
  });

  it('delete 调 executor.stopSession (best effort)', async () => {
    const calls: string[] = [];
    const executor: ChatExecutor = {
      async stopSession(id) {
        calls.push(id);
      },
      async cancelRun() {},
    };
    const { svc } = newSvc({ executor });
    const c = await svc.create();
    if (!c.ok) throw new Error();
    await svc.delete(c.value.id);
    expect(calls).toEqual([c.value.id]);
  });

  it('delete executor 抛不阻塞 (best effort)', async () => {
    const executor: ChatExecutor = {
      async stopSession() {
        throw new Error('daemon down');
      },
      async cancelRun() {},
    };
    const { svc, fs } = newSvc({ executor });
    const c = await svc.create();
    if (!c.ok) throw new Error();
    const path = `${chatSessionsDir()}/${c.value.id}.json`;
    const r = await svc.delete(c.value.id);
    expect(r.ok).toBe(true);
    expect(fs.exists(path)).toBe(false);
  });

  it('interrupt 无 executor → internal', async () => {
    const { svc } = newSvc();
    const r = await svc.interrupt('some-id');
    if (!r.ok) expect(r.error.code).toBe('EXECUTOR_MISSING');
  });

  it('interrupt 调 executor.cancelRun', async () => {
    const calls: string[] = [];
    const executor: ChatExecutor = {
      async stopSession() {},
      async cancelRun(id) {
        calls.push(id);
      },
    };
    const { svc } = newSvc({ executor });
    const r = await svc.interrupt('abc');
    expect(r.ok).toBe(true);
    expect(calls).toEqual(['abc']);
  });

  // ─── v0.51.4: per-session cwd ────────────────────────────────────

  describe('cwd', () => {
    it('create 不带 cwd → session.cwd === null', async () => {
      const { svc, fs } = newSvc();
      const c = await svc.create({ title: 'no-cwd' });
      if (!c.ok) throw new Error('create failed');
      expect(c.value.cwd).toBeNull();
      // Persisted JSON also has cwd=null
      const path = `${chatSessionsDir()}/${c.value.id}.json`;
      const persisted = JSON.parse(fs.readFile(path));
      expect(persisted.cwd).toBeNull();
    });

    it('create 带合法绝对路径 → session.cwd 保留', async () => {
      const { svc, fs } = newSvc();
      fs.mkdir('/home/user/project', { recursive: true });
      const c = await svc.create({ title: 't', cwd: '/home/user/project' });
      if (!c.ok) throw new Error('create failed');
      expect(c.value.cwd).toBe('/home/user/project');
    });

    it('create 带相对路径 → CHAT_CWD_NOT_ABSOLUTE', async () => {
      const { svc } = newSvc();
      const c = await svc.create({ cwd: 'projects/foo' });
      expect(c.ok).toBe(false);
      if (!c.ok) expect(c.error.code).toBe('CHAT_CWD_NOT_ABSOLUTE');
    });

    it('create 带不存在路径 → CHAT_CWD_NOT_FOUND', async () => {
      const { svc } = newSvc();
      const c = await svc.create({ cwd: '/no/such/dir' });
      expect(c.ok).toBe(false);
      if (!c.ok) expect(c.error.code).toBe('CHAT_CWD_NOT_FOUND');
    });

    it('create 带空字符串 → 当作未提供（null）', async () => {
      const { svc } = newSvc();
      const c = await svc.create({ cwd: '' });
      if (!c.ok) throw new Error('create failed');
      expect(c.value.cwd).toBeNull();
    });

    it('create cwd 前后空格 → trim 后通过', async () => {
      const { svc, fs } = newSvc();
      fs.mkdir('/repo', { recursive: true });
      const c = await svc.create({ cwd: '  /repo  ' });
      if (!c.ok) throw new Error('create failed');
      expect(c.value.cwd).toBe('/repo');
    });

    it('list 返回的 summary 含 cwd 字段', async () => {
      const { svc, fs } = newSvc();
      fs.mkdir('/a', { recursive: true });
      fs.mkdir('/b', { recursive: true });
      await svc.create({ title: 'X', cwd: '/a' });
      await svc.create({ title: 'Y', cwd: '/b' });
      await svc.create({ title: 'Z' }); // no cwd
      const r = await svc.list();
      if (!r.ok) throw new Error('list failed');
      const cwds = r.value.map((s) => s.cwd ?? '__null__').sort();
      expect(cwds).toEqual(['/a', '/b', '__null__']);
    });

    it('get 返回 session 含 cwd 字段', async () => {
      const { svc, fs } = newSvc();
      fs.mkdir('/x', { recursive: true });
      const c = await svc.create({ cwd: '/x' });
      if (!c.ok) throw new Error();
      const got = await svc.get(c.value.id);
      if (!got.ok) throw new Error();
      expect(got.value.cwd).toBe('/x');
    });
  });
});
