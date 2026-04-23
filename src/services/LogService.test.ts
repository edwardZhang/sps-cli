import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeFileSystem } from '../infra/filesystem.js';
import { logsDir, projectDir } from '../shared/runtimePaths.js';
import { LogService, parseLogLine } from './LogService.js';

/**
 * LogService 测试必须走真 FS —— 依赖 Node readline + createReadStream，
 * InMemoryFS 不模拟这些。tmpdir 隔离就够了。
 */
describe('LogService', () => {
  let tmpHome: string;
  let prev: string | undefined;
  let svc: LogService;

  beforeEach(() => {
    prev = process.env.HOME;
    tmpHome = mkdtempSync(resolve(tmpdir(), 'sps-logsvc-'));
    process.env.HOME = tmpHome;
    svc = new LogService({ fs: new NodeFileSystem() });
  });

  afterEach(() => {
    process.env.HOME = prev;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function seedProject(name: string): void {
    const fs = new NodeFileSystem();
    fs.mkdir(projectDir(name), { recursive: true });
    fs.writeFile(resolve(projectDir(name), 'conf'), `export PROJECT_NAME="${name}"\n`);
  }

  function writeLog(project: string, filename: string, content: string): string {
    const dir = logsDir(project);
    const fs = new NodeFileSystem();
    fs.mkdir(dir, { recursive: true });
    const path = resolve(dir, filename);
    writeFileSync(path, content);
    return path;
  }

  it('tail 无项目日志 → 空', async () => {
    seedProject('x');
    const r = await svc.tail({ project: 'x' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.data).toEqual([]);
      expect(r.value.files).toEqual([]);
    }
  });

  it('tail 读最新 pipeline log', async () => {
    seedProject('x');
    writeLog(
      'x',
      'pipeline-2026-04-23.log',
      '2026-04-23 10:00:00.000 INFO line 1\n2026-04-23 10:00:01.000 INFO line 2\n',
    );
    const r = await svc.tail({ project: 'x' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.data).toHaveLength(2);
      expect(r.value.files).toHaveLength(1);
    }
  });

  it('tail limit 截断', async () => {
    seedProject('x');
    writeLog(
      'x',
      'pipeline-2026-04-23.log',
      Array.from({ length: 20 }, (_, i) => `2026-04-23 10:00:0${i}.000 INFO line ${i}`).join(
        '\n',
      ) + '\n',
    );
    const r = await svc.tail({ project: 'x', limit: 5 });
    if (r.ok) expect(r.value.data).toHaveLength(5);
  });

  it('tail worker 过滤', async () => {
    seedProject('x');
    writeLog(
      'x',
      'pipeline-2026-04-23.log',
      '2026-04-23 10:00:00.000 INFO pipeline only\n',
    );
    writeLog(
      'x',
      'sps-acp-x-worker-1-acp-123.log',
      '2026-04-23 10:01:00.000 INFO worker-1 msg\n',
    );
    const r = await svc.tail({ project: 'x', worker: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.file ?? '').toContain('worker-1');
  });

  it('tail since 过滤时间', async () => {
    seedProject('x');
    writeLog(
      'x',
      'pipeline-2026-04-23.log',
      '2026-04-22 10:00:00.000 INFO old\n2026-04-23 10:00:00.000 INFO new\n',
    );
    const r = await svc.tail({ project: 'x', since: '2026-04-23T00:00:00' });
    if (r.ok) {
      const msgs = r.value.data.map((l) => l.msg).join(' ');
      expect(msgs).toContain('new');
    }
  });

  it('aggregate 空目录返空', async () => {
    const r = await svc.aggregate();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.data).toEqual([]);
    }
  });

  it('aggregate 读多项目 log 并合并', async () => {
    seedProject('a');
    seedProject('b');
    writeLog(
      'a',
      'pipeline-2026-04-23.log',
      '2026-04-23 09:00:00.000 INFO from a\n',
    );
    writeLog(
      'b',
      'pipeline-2026-04-23.log',
      '2026-04-23 10:00:00.000 INFO from b\n',
    );
    const r = await svc.aggregate();
    expect(r.ok).toBe(true);
    if (r.ok) {
      const projects = new Set(r.value.data.map((l) => l.project));
      expect(projects.size).toBeGreaterThanOrEqual(2);
    }
  });

  it('aggregate ts 升序排序', async () => {
    seedProject('a');
    writeLog(
      'a',
      'pipeline-2026-04-23.log',
      '2026-04-23 10:00:02.000 INFO third\n2026-04-23 10:00:01.000 INFO second\n2026-04-23 10:00:00.000 INFO first\n',
    );
    const r = await svc.aggregate();
    if (r.ok) {
      const msgs = r.value.data.map((l) => l.msg);
      const firstIdx = msgs.findIndex((m) => m.includes('first'));
      const thirdIdx = msgs.findIndex((m) => m.includes('third'));
      expect(firstIdx).toBeLessThan(thirdIdx);
    }
  });
});

describe('parseLogLine', () => {
  it('带 ts + level + worker 的行', () => {
    const r = parseLogLine('2026-04-23 10:00:00.000 INFO worker-1 hello');
    expect(r.worker).toBe(1);
    expect(r.level).toBe('info');
    expect(r.msg).toBe('hello');
    expect(r.ts).toMatch(/^2026-04-23/);
  });

  it('无 ts 的行保持原样', () => {
    const r = parseLogLine('just some output');
    expect(r.ts).toBeNull();
    expect(r.msg).toBe('just some output');
    expect(r.level).toBe('info');
  });

  it('ANSI 色码被清掉', () => {
    const r = parseLogLine('2026-04-23 10:00:00.000 \x1b[32mINFO\x1b[0m colorful');
    expect(r.msg).not.toContain('\x1b');
  });

  it('level WARNING 归一到 warn', () => {
    const r = parseLogLine('2026-04-23 10:00:00.000 WARNING heads up');
    expect(r.level).toBe('warn');
  });
});
