/**
 * @module        services/container
 * @description   Service DI 容器 —— 一次构造，Delivery 层取用
 *
 * @layer         services
 *
 * 使用：
 *   CLI:     const c = createContainer();
 *   Console: const c = createContainer({ events, systemMeta });
 *   Tests:   const c = createContainer({ fs, clock, events, spawner });
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Clock, SystemClock } from '../infra/clock.js';
import { type FileSystem, NodeFileSystem } from '../infra/filesystem.js';
import { NodeProcessSpawner, type ProcessSpawner } from '../infra/spawn.js';
import { type DomainEventBus, NoopEventBus } from '../shared/domainEvents.js';
import { CardService } from './CardService.js';
import { type ChatExecutor, ChatService } from './ChatService.js';
import { DefaultTaskBackendFactory } from './defaults.js';
import {
  DefaultChatExecutor,
  DefaultPipelineExecutor,
  DefaultProjectInitExecutor,
  DefaultWorkerExecutor,
} from './executors.js';
import { LogService } from './LogService.js';
import { type PipelineExecutor, PipelineService } from './PipelineService.js';
import type { TaskBackendFactory } from './ports.js';
import { type ProjectInitExecutor, ProjectService } from './ProjectService.js';
import { SkillService } from './SkillService.js';
import { SystemService } from './SystemService.js';
import { type WorkerExecutor, WorkerService } from './WorkerService.js';

export interface ServiceContainer {
  readonly projects: ProjectService;
  readonly cards: CardService;
  readonly workers: WorkerService;
  readonly pipelines: PipelineService;
  readonly skills: SkillService;
  readonly logs: LogService;
  readonly chat: ChatService;
  readonly system: SystemService;
}

export interface SystemMeta {
  version: string;
  startedAt: Date;
}

export interface ContainerOptions {
  /** 基础 infra —— 不传用 Node 默认 */
  fs?: FileSystem;
  clock?: Clock;
  events?: DomainEventBus;
  spawner?: ProcessSpawner;
  /** Phase 3 注入的 CLI 适配器 */
  taskBackendFactory?: TaskBackendFactory;
  projectInitExecutor?: ProjectInitExecutor;
  workerExecutor?: WorkerExecutor;
  pipelineExecutor?: PipelineExecutor;
  chatExecutor?: ChatExecutor;
  /** SystemService 元数据 —— 未注入时从 package.json 读 version + now() */
  systemMeta?: SystemMeta;
}

export function createContainer(opts: ContainerOptions = {}): ServiceContainer {
  const fs = opts.fs ?? new NodeFileSystem();
  const clock = opts.clock ?? new SystemClock();
  const events = opts.events ?? new NoopEventBus();
  const spawner = opts.spawner ?? new NodeProcessSpawner();
  const taskBackendFactory = opts.taskBackendFactory ?? new DefaultTaskBackendFactory();

  const workerExecutor = opts.workerExecutor ?? new DefaultWorkerExecutor();
  const pipelineExecutor = opts.pipelineExecutor ?? new DefaultPipelineExecutor(spawner);
  const chatExecutor = opts.chatExecutor ?? new DefaultChatExecutor();
  const projectInitExecutor = opts.projectInitExecutor ?? new DefaultProjectInitExecutor();

  const systemMeta: SystemMeta = opts.systemMeta ?? {
    version: resolveSelfVersion(),
    startedAt: new Date(clock.now()),
  };

  const cards = new CardService({
    backendFactory: taskBackendFactory,
    events,
    clock,
  });

  return {
    projects: new ProjectService({
      fs,
      clock,
      events,
      initExecutor: projectInitExecutor,
    }),
    cards,
    workers: new WorkerService({
      fs,
      clock,
      events,
      executor: workerExecutor,
      cardTitleLookup: async (project, seq) => {
        const r = await cards.get(project, seq);
        return r.ok ? r.value.title : null;
      },
    }),
    pipelines: new PipelineService({
      fs,
      clock,
      events,
      spawner,
      executor: pipelineExecutor,
    }),
    skills: new SkillService({ events }),
    logs: new LogService({ fs }),
    chat: new ChatService({
      fs,
      clock,
      events,
      executor: chatExecutor,
    }),
    system: new SystemService({
      fs,
      clock,
      spawner,
      version: systemMeta.version,
      startedAt: systemMeta.startedAt,
    }),
  };
}

// ─── helpers ───────────────────────────────────────────────────────

function resolveSelfVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    // dist/services/container.js → dist/../package.json
    // src/services/container.ts → src/../package.json
    const pkgPath = resolve(dirname(here), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}
