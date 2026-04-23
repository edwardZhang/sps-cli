/**
 * @module        services/container
 * @description   Service DI 容器 —— 一次构造，Delivery 层取用
 *
 * @layer         services
 *
 * 使用：
 *   CLI:     const c = createContainer();
 *   Console: const c = createContainer({ events });      // 注入 SseEventBus
 *   Tests:   const c = createContainer({ fs, clock, events, spawner });
 */
import { type Clock, SystemClock } from '../infra/clock.js';
import { type FileSystem, NodeFileSystem } from '../infra/filesystem.js';
import { NodeProcessSpawner, type ProcessSpawner } from '../infra/spawn.js';
import { type DomainEventBus, NoopEventBus } from '../shared/domainEvents.js';
import { CardService } from './CardService.js';
import { type ChatExecutor, ChatService } from './ChatService.js';
import { DefaultTaskBackendFactory } from './defaults.js';
import { LogService } from './LogService.js';
import { type PipelineExecutor, PipelineService } from './PipelineService.js';
import { type ProjectInitExecutor, ProjectService } from './ProjectService.js';
import type { TaskBackendFactory } from './ports.js';
import { SkillService } from './SkillService.js';
import { type WorkerExecutor, WorkerService } from './WorkerService.js';

export interface ServiceContainer {
  readonly projects: ProjectService;
  readonly cards: CardService;
  readonly workers: WorkerService;
  readonly pipelines: PipelineService;
  readonly skills: SkillService;
  readonly logs: LogService;
  readonly chat: ChatService;
}

export interface ContainerOptions {
  /** 基础 infra —— 不传用 Node 默认 */
  fs?: FileSystem;
  clock?: Clock;
  events?: DomainEventBus;
  spawner?: ProcessSpawner;
  /** Phase 3 注入的 CLI 适配器（未注入时相关 Service 方法返 internal 错误） */
  taskBackendFactory?: TaskBackendFactory;
  projectInitExecutor?: ProjectInitExecutor;
  workerExecutor?: WorkerExecutor;
  pipelineExecutor?: PipelineExecutor;
  chatExecutor?: ChatExecutor;
}

export function createContainer(opts: ContainerOptions = {}): ServiceContainer {
  const fs = opts.fs ?? new NodeFileSystem();
  const clock = opts.clock ?? new SystemClock();
  const events = opts.events ?? new NoopEventBus();
  const spawner = opts.spawner ?? new NodeProcessSpawner();
  const taskBackendFactory = opts.taskBackendFactory ?? new DefaultTaskBackendFactory();

  return {
    projects: new ProjectService({
      fs,
      clock,
      events,
      initExecutor: opts.projectInitExecutor,
    }),
    cards: new CardService({
      backendFactory: taskBackendFactory,
      events,
      clock,
    }),
    workers: new WorkerService({
      fs,
      clock,
      events,
      executor: opts.workerExecutor,
    }),
    pipelines: new PipelineService({
      fs,
      clock,
      events,
      spawner,
      executor: opts.pipelineExecutor,
    }),
    skills: new SkillService({ events }),
    logs: new LogService({ fs }),
    chat: new ChatService({
      fs,
      clock,
      events,
      executor: opts.chatExecutor,
    }),
  };
}
