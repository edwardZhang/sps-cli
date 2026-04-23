import { describe, expect, it } from 'vitest';
import { FakeProcessSpawner } from './spawn.js';

describe('FakeProcessSpawner', () => {
  it('spawnSupervisor 记录调用', () => {
    const sp = new FakeProcessSpawner();
    sp.spawnSupervisor({ args: ['tick', 'alpha'], logPath: '/tmp/a.log' });
    sp.spawnSupervisor({ args: ['tick', 'beta'], logPath: '/tmp/b.log', cwd: '/x' });
    expect(sp.calls).toEqual([
      { args: ['tick', 'alpha'], logPath: '/tmp/a.log', cwd: undefined },
      { args: ['tick', 'beta'], logPath: '/tmp/b.log', cwd: '/x' },
    ]);
  });

  it('返回 stub ChildProcess 有 pid', () => {
    const sp = new FakeProcessSpawner();
    const h = sp.spawnSupervisor({ args: [], logPath: '/t.log' });
    expect(h.pid).toBeGreaterThan(0);
    expect(h.kill()).toBe(true);
    expect(() => h.unref()).not.toThrow();
  });

  it('每次 pid 递增', () => {
    const sp = new FakeProcessSpawner();
    const a = sp.spawnSupervisor({ args: [], logPath: '/t.log' });
    const b = sp.spawnSupervisor({ args: [], logPath: '/t.log' });
    expect((b.pid ?? 0) - (a.pid ?? 0)).toBe(1);
  });
});
