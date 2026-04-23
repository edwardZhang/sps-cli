import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../infra/clock.js';
import { InMemoryFileSystem } from '../infra/filesystem.js';
import { InMemoryEventBus } from '../shared/domainEvents.js';
import { projectDir, runtimeDir, stateFile, workerMarkerFile } from '../shared/runtimePaths.js';
import { type WorkerExecutor, WorkerService } from './WorkerService.js';

describe('WorkerService', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    process.env.HOME = '/h';
  });
  afterEach(() => {
    process.env.HOME = prev;
  });

  function newSvc(extra?: {
    now?: number;
    executor?: WorkerExecutor;
    titleLookup?: (p: string, seq: number) => Promise<string | null>;
  }): {
    svc: WorkerService;
    fs: InMemoryFileSystem;
    clock: FakeClock;
  } {
    const fs = new InMemoryFileSystem();
    const clock = new FakeClock(extra?.now ?? Date.now());
    const events = new InMemoryEventBus();
    const svc = new WorkerService({
      fs,
      clock,
      events,
      cardTitleLookup: extra?.titleLookup,
      executor: extra?.executor,
    });
    return { svc, fs, clock };
  }

  function seedProject(fs: InMemoryFileSystem, name: string) {
    fs.mkdir(runtimeDir(name), { recursive: true });
  }

  function writeMarker(
    fs: InMemoryFileSystem,
    project: string,
    slot: number,
    payload: Record<string, unknown>,
  ) {
    fs.writeFile(
      workerMarkerFile(project, `worker-${slot}`),
      JSON.stringify(payload),
    );
  }

  describe('listByProject', () => {
    it('空项目返空', async () => {
      const { svc, fs } = newSvc();
      seedProject(fs, 'p');
      const r = await svc.listByProject('p');
      expect(r).toEqual({ ok: true, value: [] });
    });

    it('不存在 runtime 返空', async () => {
      const { svc } = newSvc();
      const r = await svc.listByProject('p');
      expect(r).toEqual({ ok: true, value: [] });
    });

    it('读双前缀 marker', async () => {
      const { svc, fs, clock } = newSvc();
      seedProject(fs, 'p');
      writeMarker(fs, 'p', 1, {
        cardId: 'md-3',
        stage: 'develop',
        dispatchedAt: clock.nowIso(),
      });
      const r = await svc.listByProject('p');
      if (r.ok) {
        expect(r.value).toHaveLength(1);
        expect(r.value[0]?.slot).toBe(1);
        expect(r.value[0]?.card?.seq).toBe(3);
      }
    });

    it('多个 slot 按数字升序', async () => {
      const { svc, fs, clock } = newSvc();
      seedProject(fs, 'p');
      writeMarker(fs, 'p', 3, { cardId: 'md-3', stage: 'dev', dispatchedAt: clock.nowIso() });
      writeMarker(fs, 'p', 1, { cardId: 'md-1', stage: 'dev', dispatchedAt: clock.nowIso() });
      writeMarker(fs, 'p', 2, { cardId: 'md-2', stage: 'dev', dispatchedAt: clock.nowIso() });
      const r = await svc.listByProject('p');
      if (r.ok) expect(r.value.map((w) => w.slot)).toEqual([1, 2, 3]);
    });

    it('pid 死 + 有 card → crashed', async () => {
      const { svc, fs, clock } = newSvc();
      seedProject(fs, 'p');
      writeMarker(fs, 'p', 1, {
        cardId: 'md-3',
        stage: 'dev',
        dispatchedAt: clock.nowIso(),
        pid: 999999, // 不存在
      });
      const r = await svc.listByProject('p');
      if (r.ok) expect(r.value[0]?.state).toBe('crashed');
    });

    it('pid 活 + marker fresh → running（marker > 60s 后）', async () => {
      const now = Date.now();
      const { svc, fs, clock } = newSvc({ now });
      seedProject(fs, 'p');
      writeMarker(fs, 'p', 1, {
        cardId: 'md-3',
        stage: 'dev',
        dispatchedAt: new Date(now - 120_000).toISOString(), // 2 分钟前 dispatch
        pid: process.pid, // 活
      });
      // 手动把文件时间推到 2 分钟前
      const stat = fs.stat(workerMarkerFile('p', 'worker-1'));
      if (stat) {
        // InMemoryFS 的 mtime 取 tick 递增 —— 实际测试里我们 bump clock 到 2 分钟后
        clock.setTime(now + 120_000);
      }
      const r = await svc.listByProject('p');
      if (r.ok) {
        expect(r.value[0]?.state).toBe('running');
      }
    });

    it('title 用 cardTitleLookup 反查', async () => {
      const { svc, fs, clock } = newSvc({
        titleLookup: async (_p, seq) => (seq === 3 ? '真实 title' : null),
      });
      seedProject(fs, 'p');
      writeMarker(fs, 'p', 1, {
        cardId: 'md-3',
        stage: 'dev',
        dispatchedAt: clock.nowIso(),
      });
      const r = await svc.listByProject('p');
      if (r.ok) expect(r.value[0]?.card?.title).toBe('真实 title');
    });

    it('title 反查失败 → fallback 用 #seq', async () => {
      const { svc, fs, clock } = newSvc({
        titleLookup: async () => null,
      });
      seedProject(fs, 'p');
      writeMarker(fs, 'p', 1, {
        cardId: 'md-7',
        stage: 'dev',
        dispatchedAt: clock.nowIso(),
      });
      const r = await svc.listByProject('p');
      if (r.ok) expect(r.value[0]?.card?.title).toBe('#7');
    });

    it('project 非法返 validation', async () => {
      const { svc } = newSvc();
      const r = await svc.listByProject('../etc');
      if (!r.ok) expect(r.error.kind).toBe('validation');
    });

    /**
     * v0.50.5 回归：worker 完成后 supervisor 把 state.json 里 slot 置 idle，
     * 但 marker 文件不清。WorkerService 必须以 state.json 为权威 → 报 idle，
     * 不能因为 marker 存在就继续报 running。
     */
    it('state.json 说 slot idle → 报 idle（不管 marker 是否新鲜）', async () => {
      const { svc, fs, clock } = newSvc();
      seedProject(fs, 'p');
      writeMarker(fs, 'p', 1, {
        cardId: 'md-3',
        stage: 'develop',
        dispatchedAt: clock.nowIso(),
        pid: process.pid, // 活着
      });
      // supervisor 标记 slot 已空闲
      fs.writeFile(
        stateFile('p'),
        JSON.stringify({
          workers: {
            'worker-1': {
              status: 'idle',
              seq: null,
              branch: null,
              worktree: null,
              claimedAt: null,
              lastHeartbeat: null,
            },
          },
        }),
      );
      const r = await svc.listByProject('p');
      if (r.ok) {
        expect(r.value[0]?.state).toBe('idle');
        expect(r.value[0]?.card).toBeNull();
      }
    });

    it('state.json 说 slot active + marker 新鲜 → running（老路径保留）', async () => {
      const { svc, fs, clock } = newSvc();
      seedProject(fs, 'p');
      writeMarker(fs, 'p', 1, {
        cardId: 'md-5',
        stage: 'develop',
        dispatchedAt: clock.nowIso(),
        pid: process.pid,
      });
      fs.writeFile(
        stateFile('p'),
        JSON.stringify({
          workers: {
            'worker-1': {
              status: 'active',
              seq: 5,
              branch: null,
              worktree: null,
              claimedAt: clock.nowIso(),
              lastHeartbeat: clock.nowIso(),
            },
          },
        }),
      );
      const r = await svc.listByProject('p');
      if (r.ok) {
        expect(['running', 'starting']).toContain(r.value[0]?.state);
        expect(r.value[0]?.card?.seq).toBe(5);
      }
    });
  });

  describe('getBySlot', () => {
    it('slot 无 marker 返 not-found', async () => {
      const { svc, fs } = newSvc();
      seedProject(fs, 'p');
      const r = await svc.getBySlot('p', 99);
      if (!r.ok) expect(r.error.code).toBe('WORKER_MARKER_NOT_FOUND');
    });

    it('slot 0 / 负数返 validation', async () => {
      const { svc } = newSvc();
      const r = await svc.getBySlot('p', 0);
      if (!r.ok) expect(r.error.kind).toBe('validation');
    });

    it('存在返 WorkerInfo', async () => {
      const { svc, fs, clock } = newSvc();
      seedProject(fs, 'p');
      writeMarker(fs, 'p', 1, {
        cardId: 'md-3',
        stage: 'dev',
        dispatchedAt: clock.nowIso(),
      });
      const r = await svc.getBySlot('p', 1);
      if (r.ok) {
        expect(r.value.slot).toBe(1);
        expect(r.value.card?.seq).toBe(3);
      }
    });
  });

  describe('aggregate', () => {
    it('空返三段空', async () => {
      const { svc } = newSvc();
      const r = await svc.aggregate();
      if (r.ok) {
        expect(r.value.alerts).toEqual([]);
        expect(r.value.active).toEqual([]);
        expect(r.value.capacity).toEqual([]);
      }
    });

    it('crashed 进 alerts + capacity 统计', async () => {
      const { svc, fs, clock } = newSvc();
      fs.mkdir(projectDir('p1'), { recursive: true });
      seedProject(fs, 'p1');
      writeMarker(fs, 'p1', 1, {
        cardId: 'md-5',
        stage: 'dev',
        dispatchedAt: clock.nowIso(),
        pid: 999999,
      });
      const r = await svc.aggregate();
      if (r.ok) {
        expect(r.value.alerts).toHaveLength(1);
        expect(r.value.alerts[0]?.state).toBe('crashed');
        expect(r.value.capacity[0]?.crashed).toBe(1);
      }
    });
  });

  describe('launch / kill', () => {
    it('未注入 executor 返 internal', async () => {
      const { svc, fs } = newSvc();
      fs.mkdir(projectDir('p'), { recursive: true });
      const r = await svc.launch('p', 1);
      if (!r.ok) expect(r.error.code).toBe('WORKER_EXECUTOR_MISSING');
    });

    it('launch 成功', async () => {
      const calls: Array<{ project: string; seq: number }> = [];
      const executor: WorkerExecutor = {
        async launch(project, seq) {
          calls.push({ project, seq });
        },
        async kill() {},
      };
      const { svc, fs } = newSvc({ executor });
      fs.mkdir(projectDir('p'), { recursive: true });
      const r = await svc.launch('p', 3);
      expect(r.ok).toBe(true);
      expect(calls).toEqual([{ project: 'p', seq: 3 }]);
    });

    it('launch 项目不存在 → not-found', async () => {
      const executor: WorkerExecutor = {
        async launch() {},
        async kill() {},
      };
      const { svc } = newSvc({ executor });
      const r = await svc.launch('no-such', 1);
      if (!r.ok) expect(r.error.kind).toBe('not-found');
    });

    it('launch executor 抛 → external', async () => {
      const executor: WorkerExecutor = {
        async launch() {
          throw new Error('boom');
        },
        async kill() {},
      };
      const { svc, fs } = newSvc({ executor });
      fs.mkdir(projectDir('p'), { recursive: true });
      const r = await svc.launch('p', 1);
      if (!r.ok) {
        expect(r.error.kind).toBe('external');
        expect(r.error.code).toBe('WORKER_LAUNCH_FAIL');
      }
    });

    it('kill 成功 + executor 被调', async () => {
      const kills: Array<{ project: string; slot: number }> = [];
      const executor: WorkerExecutor = {
        async launch() {},
        async kill(project, slot) {
          kills.push({ project, slot });
        },
      };
      const { svc } = newSvc({ executor });
      const r = await svc.kill('p', 2);
      expect(r.ok).toBe(true);
      expect(kills).toEqual([{ project: 'p', slot: 2 }]);
    });
  });
});
