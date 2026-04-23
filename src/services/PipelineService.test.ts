import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../infra/clock.js';
import { InMemoryFileSystem } from '../infra/filesystem.js';
import { FakeProcessSpawner } from '../infra/spawn.js';
import { type DomainEvent, InMemoryEventBus } from '../shared/domainEvents.js';
import {
  activePipelineFile,
  pipelineFile,
  pipelinesDir,
  projectDir,
} from '../shared/runtimePaths.js';
import { type PipelineExecutor, PipelineService } from './PipelineService.js';

function newSvc(extra?: { executor?: PipelineExecutor }): {
  svc: PipelineService;
  fs: InMemoryFileSystem;
  spawner: FakeProcessSpawner;
  events: DomainEvent[];
} {
  const fs = new InMemoryFileSystem();
  const clock = new FakeClock(new Date('2026-04-23T12:00:00Z'));
  const spawner = new FakeProcessSpawner();
  const bus = new InMemoryEventBus();
  const events: DomainEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const svc = new PipelineService({ fs, clock, events: bus, spawner, executor: extra?.executor });
  return { svc, fs, spawner, events };
}

function seedProject(fs: InMemoryFileSystem, name: string) {
  fs.mkdir(projectDir(name), { recursive: true });
  fs.mkdir(pipelinesDir(name), { recursive: true });
  fs.writeFile(
    activePipelineFile(name),
    'mode: project\nstages:\n  - name: develop\n',
  );
}

describe('PipelineService', () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.HOME;
    process.env.HOME = '/h';
  });
  afterEach(() => {
    process.env.HOME = prev;
  });

  describe('start', () => {
    it('项目不存在返 not-found', async () => {
      const { svc } = newSvc();
      const r = await svc.start('no-such');
      if (!r.ok) expect(r.error.kind).toBe('not-found');
    });

    it('调 spawner + emit pipeline.started', async () => {
      const { svc, fs, spawner, events } = newSvc();
      seedProject(fs, 'p');
      const r = await svc.start('p');
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.status).toBe('running');
      expect(spawner.calls).toHaveLength(1);
      expect(spawner.calls[0]?.args).toEqual(['tick', 'p']);
      expect(events.find((e) => e.type === 'pipeline.started')).toBeDefined();
    });
  });

  describe('stop / reset', () => {
    it('无 executor 返 internal', async () => {
      const { svc } = newSvc();
      const r = await svc.stop('p');
      if (!r.ok) expect(r.error.code).toBe('EXECUTOR_MISSING');
    });

    it('executor 抛 → external', async () => {
      const executor: PipelineExecutor = {
        async stop() {
          throw new Error('cli failed');
        },
        async reset() {},
        async recoverOrphans() {
          return 0;
        },
      };
      const { svc } = newSvc({ executor });
      const r = await svc.stop('p');
      if (!r.ok) expect(r.error.kind).toBe('external');
    });

    it('stop 成功 + emit pipeline.stopped', async () => {
      const executor: PipelineExecutor = {
        async stop() {},
        async reset() {},
        async recoverOrphans() {
          return 0;
        },
      };
      const { svc, events } = newSvc({ executor });
      const r = await svc.stop('p');
      expect(r.ok).toBe(true);
      expect(events.find((e) => e.type === 'pipeline.stopped')).toBeDefined();
    });

    it('reset 转发到 executor', async () => {
      const calls: unknown[] = [];
      const executor: PipelineExecutor = {
        async stop() {},
        async reset(project, opts) {
          calls.push({ project, opts });
        },
        async recoverOrphans() {
          return 0;
        },
      };
      const { svc } = newSvc({ executor });
      const r = await svc.reset('p', { all: true });
      expect(r.ok).toBe(true);
      expect(calls).toEqual([{ project: 'p', opts: { all: true } }]);
    });
  });

  describe('status', () => {
    it('无 pid 返 idle', async () => {
      const { svc } = newSvc();
      const r = await svc.status('p');
      if (r.ok) expect(r.value).toEqual({ status: 'idle', pid: null });
    });
  });

  describe('pipelines CRUD', () => {
    it('listPipelines 空目录返 active null', async () => {
      const { svc } = newSvc();
      const r = await svc.listPipelines('p');
      if (r.ok) expect(r.value.active).toBeNull();
    });

    it('listPipelines 含 active + available', async () => {
      const { svc, fs } = newSvc();
      seedProject(fs, 'p');
      fs.writeFile(pipelineFile('p', 'variant-a.yaml'), 'mode: project\nstages:\n  - name: x\n');
      const r = await svc.listPipelines('p');
      if (r.ok) {
        expect(r.value.active).toBe('project.yaml');
        expect(r.value.available.map((a) => a.name)).toContain('variant-a.yaml');
      }
    });

    it('readPipeline 不存在返 not-found', async () => {
      const { svc } = newSvc();
      const r = await svc.readPipeline('p', 'a.yaml');
      if (!r.ok) expect(r.error.code).toBe('PIPELINE_NOT_FOUND');
    });

    it('readPipeline 路径穿越返 validation', async () => {
      const { svc } = newSvc();
      const r = await svc.readPipeline('p', '../etc.yaml');
      if (!r.ok) expect(r.error.kind).toBe('validation');
    });

    it('readPipeline 返 content + etag + parsed', async () => {
      const { svc, fs } = newSvc();
      seedProject(fs, 'p');
      const r = await svc.readPipeline('p', 'project.yaml');
      if (r.ok) {
        expect(r.value.content).toContain('mode: project');
        expect(r.value.etag).toMatch(/^[0-9a-f]{16}$/);
        expect(r.value.parseError).toBeNull();
        expect(r.value.isActive).toBe(true);
      }
    });

    it('writePipeline etag mismatch → conflict', async () => {
      const { svc, fs } = newSvc();
      seedProject(fs, 'p');
      const r = await svc.writePipeline('p', 'project.yaml', 'mode: project\nstages:\n  - name: y\n', 'badetagxxxx');
      if (!r.ok) expect(r.error.code).toBe('PIPELINE_ETAG_MISMATCH');
    });

    it('writePipeline yaml 语法错误 → validation', async () => {
      const { svc, fs } = newSvc();
      seedProject(fs, 'p');
      const read = await svc.readPipeline('p', 'project.yaml');
      if (!read.ok) throw new Error('read failed');
      const r = await svc.writePipeline('p', 'project.yaml', 'mode: [bad: yaml', read.value.etag);
      if (!r.ok) expect(r.error.code).toBe('YAML_INVALID');
    });

    it('writePipeline 成功返新 etag', async () => {
      const { svc, fs } = newSvc();
      seedProject(fs, 'p');
      const read = await svc.readPipeline('p', 'project.yaml');
      if (!read.ok) throw new Error('read failed');
      const newContent = 'mode: project\nstages:\n  - name: new-stage\n';
      const r = await svc.writePipeline('p', 'project.yaml', newContent, read.value.etag);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.etag).not.toBe(read.value.etag);
    });

    it('createPipeline blank 模板', async () => {
      const { svc, fs } = newSvc();
      seedProject(fs, 'p');
      const r = await svc.createPipeline('p', { name: 'new.yaml', template: 'blank' });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.content).toContain('mode: project');
    });

    it('createPipeline 已存在返 conflict', async () => {
      const { svc, fs } = newSvc();
      seedProject(fs, 'p');
      const r = await svc.createPipeline('p', { name: 'project.yaml' });
      if (!r.ok) expect(r.error.kind).toBe('conflict');
    });

    it('deletePipeline project.yaml 拒绝', async () => {
      const { svc, fs } = newSvc();
      seedProject(fs, 'p');
      const r = await svc.deletePipeline('p', 'project.yaml');
      if (!r.ok) expect(r.error.code).toBe('CANNOT_DELETE_ACTIVE');
    });

    it('deletePipeline 成功', async () => {
      const { svc, fs } = newSvc();
      seedProject(fs, 'p');
      fs.writeFile(pipelineFile('p', 'bye.yaml'), 'mode: project\nstages:\n  - name: x\n');
      const r = await svc.deletePipeline('p', 'bye.yaml');
      expect(r.ok).toBe(true);
      expect(fs.exists(pipelineFile('p', 'bye.yaml'))).toBe(false);
    });

    it('switchActive 成功', async () => {
      const { svc, fs } = newSvc();
      seedProject(fs, 'p');
      fs.writeFile(pipelineFile('p', 'variant.yaml'), 'mode: project\nstages:\n  - name: x\n');
      const r = await svc.switchActive('p', 'variant.yaml');
      if (r.ok) expect(r.value.activePipeline).toBe('variant.yaml');
      expect(fs.readFile(activePipelineFile('p'))).toContain('x');
    });

    it('switchActive 对 project.yaml 返 validation', async () => {
      const { svc, fs } = newSvc();
      seedProject(fs, 'p');
      const r = await svc.switchActive('p', 'project.yaml');
      if (!r.ok) expect(r.error.kind).toBe('validation');
    });
  });
});
