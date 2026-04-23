import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../infra/clock.js';
import { InMemoryFileSystem } from '../infra/filesystem.js';
import { InMemoryEventBus } from '../shared/domainEvents.js';
import {
  cardsDir,
  projectConfFile,
  projectDir,
  runtimeDir,
  supervisorPidFile,
} from '../shared/runtimePaths.js';
import { type ProjectInitExecutor, ProjectService } from './ProjectService.js';

function newService(extra?: { initExecutor?: ProjectInitExecutor }): {
  svc: ProjectService;
  fs: InMemoryFileSystem;
  clock: FakeClock;
  events: InMemoryEventBus;
} {
  const fs = new InMemoryFileSystem();
  const clock = new FakeClock(1000);
  const events = new InMemoryEventBus();
  const svc = new ProjectService({ fs, clock, events, initExecutor: extra?.initExecutor });
  return { svc, fs, clock, events };
}

function seedProject(fs: InMemoryFileSystem, name: string, confLines?: string[]): void {
  const conf =
    confLines ??
    [
      `export PROJECT_NAME="${name}"`,
      `export PROJECT_DIR="/repos/${name}"`,
      `export PM_TOOL="markdown"`,
      `export AGENT_PROVIDER="claude"`,
    ];
  fs.writeFile(projectConfFile(name), `${conf.join('\n')}\n`);
  fs.mkdir(cardsDir(name), { recursive: true });
  fs.mkdir(runtimeDir(name), { recursive: true });
}

describe('ProjectService.list', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    process.env.HOME = '/h';
  });
  afterEach(() => {
    process.env.HOME = prev;
  });

  it('无项目返空数组', async () => {
    const { svc } = newService();
    const r = await svc.list();
    expect(r).toEqual({ ok: true, value: [] });
  });

  it('列出多个项目并按字母序', async () => {
    const { svc, fs } = newService();
    seedProject(fs, 'beta');
    seedProject(fs, 'alpha');
    const r = await svc.list();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.map((p) => p.name)).toEqual(['alpha', 'beta']);
    }
  });

  it('项目概览含 conf 字段 + 默认值', async () => {
    const { svc, fs } = newService();
    seedProject(fs, 'x');
    const r = await svc.list();
    if (r.ok) {
      const p = r.value[0]!;
      expect(p.repoDir).toBe('/repos/x');
      expect(p.pmBackend).toBe('markdown');
      expect(p.agentProvider).toBe('claude');
    }
  });

  it('pipelineStatus 默认 idle', async () => {
    const { svc, fs } = newService();
    seedProject(fs, 'x');
    const r = await svc.list();
    if (r.ok) expect(r.value[0]?.pipelineStatus).toBe('idle');
  });
});

describe('ProjectService.get', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    process.env.HOME = '/h';
  });
  afterEach(() => {
    process.env.HOME = prev;
  });

  it('不存在返 not-found', async () => {
    const { svc } = newService();
    const r = await svc.get('nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('not-found');
  });

  it('存在返 summary', async () => {
    const { svc, fs } = newService();
    seedProject(fs, 'x');
    const r = await svc.get('x');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('x');
  });

  it('非法 name 返 validation', async () => {
    const { svc } = newService();
    const r = await svc.get('../etc');
    if (!r.ok) expect(r.error.kind).toBe('validation');
  });
});

describe('ProjectService.create', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    process.env.HOME = '/h';
  });
  afterEach(() => {
    process.env.HOME = prev;
  });

  it('未注入 initExecutor 返 internal', async () => {
    const { svc } = newService();
    const r = await svc.create({
      name: 'x',
      projectDir: '/r',
      mergeBranch: 'main',
      maxWorkers: '1',
    });
    if (!r.ok) {
      expect(r.error.kind).toBe('internal');
      expect(r.error.code).toBe('INIT_EXECUTOR_MISSING');
    }
  });

  it('name 非法返 validation', async () => {
    const { svc } = newService();
    const r = await svc.create({
      name: 'a/b',
      projectDir: '/r',
      mergeBranch: 'main',
      maxWorkers: '1',
    });
    if (!r.ok) expect(r.error.kind).toBe('validation');
  });

  it('已存在返 conflict', async () => {
    const { svc, fs } = newService();
    seedProject(fs, 'x');
    const r = await svc.create({
      name: 'x',
      projectDir: '/r',
      mergeBranch: 'main',
      maxWorkers: '1',
    });
    if (!r.ok) expect(r.error.kind).toBe('conflict');
  });

  it('initExecutor 成功 + 返 summary', async () => {
    let called = false;
    const initExecutor: ProjectInitExecutor = {
      async init(name) {
        called = true;
        // 模拟 executeProjectInit 写入 conf + 目录
        const { fs } = svcHolder;
        seedProject(fs, name);
      },
    };
    const svcHolder = newService({ initExecutor });
    const r = await svcHolder.svc.create({
      name: 'new-proj',
      projectDir: '/r',
      mergeBranch: 'main',
      maxWorkers: '1',
    });
    expect(called).toBe(true);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('new-proj');
  });

  it('initExecutor 抛错返 external', async () => {
    const initExecutor: ProjectInitExecutor = {
      async init() {
        throw new Error('git clone failed');
      },
    };
    const { svc } = newService({ initExecutor });
    const r = await svc.create({
      name: 'x',
      projectDir: '/r',
      mergeBranch: 'main',
      maxWorkers: '1',
    });
    if (!r.ok) {
      expect(r.error.kind).toBe('external');
      expect(r.error.code).toBe('PROJECT_INIT_FAIL');
    }
  });
});

describe('ProjectService.delete', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    process.env.HOME = '/h';
  });
  afterEach(() => {
    process.env.HOME = prev;
  });

  it('不存在返 not-found', async () => {
    const { svc } = newService();
    const r = await svc.delete('nope');
    if (!r.ok) expect(r.error.kind).toBe('not-found');
  });

  it('成功删项目 + claudeRemoved 报告 (repo 无 .claude/ 时空数组)', async () => {
    const { svc, fs } = newService();
    seedProject(fs, 'x');
    const r = await svc.delete('x');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe('x');
      expect(r.value.claudeRemoved).toEqual([]);
    }
    expect(fs.exists(projectDir('x'))).toBe(false);
  });

  it('pipeline 在跑时拒绝 (conflict)', async () => {
    const { svc, fs } = newService();
    seedProject(fs, 'x');
    fs.writeFile(supervisorPidFile('x'), `${process.pid}\n`); // self pid → alive
    const r = await svc.delete('x');
    if (!r.ok) {
      expect(r.error.kind).toBe('conflict');
      expect(r.error.code).toBe('PIPELINE_RUNNING');
    }
    // 没删
    expect(fs.exists(projectDir('x'))).toBe(true);
  });

  it('includeClaudeDir:false 不动 repo .claude/', async () => {
    const { svc, fs } = newService();
    seedProject(fs, 'x');
    fs.writeFile('/repos/x/.claude/settings.json', '{}');
    const r = await svc.delete('x', { includeClaudeDir: false });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.claudeRemoved).toEqual([]);
    // .claude/ 保留
    expect(fs.exists('/repos/x/.claude/settings.json')).toBe(true);
  });
});

describe('ProjectService.readConf / writeConf', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    process.env.HOME = '/h';
  });
  afterEach(() => {
    process.env.HOME = prev;
  });

  it('readConf 不存在返 not-found', async () => {
    const { svc } = newService();
    const r = await svc.readConf('nope');
    if (!r.ok) expect(r.error.kind).toBe('not-found');
  });

  it('readConf 返 content + etag', async () => {
    const { svc, fs } = newService();
    seedProject(fs, 'x');
    const r = await svc.readConf('x');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.content).toContain('PROJECT_NAME="x"');
      expect(r.value.etag).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('writeConf etag 匹配 → 成功 + 新 etag', async () => {
    const { svc, fs } = newService();
    seedProject(fs, 'x');
    const read = await svc.readConf('x');
    if (!read.ok) throw new Error('read failed');
    const r = await svc.writeConf('x', 'export PROJECT_NAME="x"\nexport NEW=1\n', read.value.etag);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.etag).not.toBe(read.value.etag);
    expect(fs.readFile(projectConfFile('x'))).toContain('NEW=1');
  });

  it('writeConf etag mismatch → conflict', async () => {
    const { svc, fs } = newService();
    seedProject(fs, 'x');
    const r = await svc.writeConf('x', 'new content', 'baadbeefbaadbeef');
    if (!r.ok) {
      expect(r.error.kind).toBe('conflict');
      expect(r.error.code).toBe('CONF_ETAG_MISMATCH');
    }
  });

  it('writeConf 缺 etag → validation', async () => {
    const { svc, fs } = newService();
    seedProject(fs, 'x');
    const r = await svc.writeConf('x', 'content', '');
    if (!r.ok) expect(r.error.kind).toBe('validation');
  });
});
