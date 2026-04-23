/**
 * @module        services/PipelineService
 * @description   Pipeline 控制 + yaml CRUD service
 *
 * @layer         services
 *
 * 职责：
 *   - start：spawn 后台 supervisor（唯一允许用 ProcessSpawner 的 service）
 *   - stop：注入 PipelineExecutor.stop 调 CLI 停止（Phase 3 会接到 Domain 内部实现）
 *   - reset：注入 PipelineExecutor.reset
 *   - status：读 supervisor.pid 判进程活
 *   - pipelines yaml CRUD：list / get / write / create / delete / switch active
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import YAML from 'yaml';
import type { Clock } from '../infra/clock.js';
import type { FileSystem } from '../infra/filesystem.js';
import type { ProcessSpawner } from '../infra/spawn.js';
import type { DomainEventBus } from '../shared/domainEvents.js';
import { type DomainError, domainError } from '../shared/errors.js';
import { err, ok, type Result } from '../shared/result.js';
import {
  activePipelineFile,
  logsDir,
  PipelineFilenameRe,
  pipelineFile,
  pipelinesDir,
  projectDir,
  supervisorPidFile,
} from '../shared/runtimePaths.js';

export type PipelineStatus = 'idle' | 'running';

export interface PipelineStatusInfo {
  readonly status: PipelineStatus;
  readonly pid: number | null;
}

export interface PipelineSummary {
  readonly active: string | null;
  readonly available: Array<{ name: string; isActive: boolean }>;
}

export interface PipelineFileContent {
  readonly content: string;
  readonly etag: string;
  readonly parsed: unknown;
  readonly parseError: string | null;
  readonly isActive: boolean;
}

export interface CreatePipelineInput {
  name: string;
  template?: 'blank' | 'sample' | 'active';
}

export interface ResetPipelineOpts {
  all?: boolean;
  cards?: number[];
}

/** CLI 命令层注入的钩子（Phase 3） */
export interface PipelineExecutor {
  stop(project: string): Promise<void>;
  reset(project: string, opts: ResetPipelineOpts): Promise<void>;
  // v0.50.8：启动前回收上次遗留的 in-flight 卡片。
  //   - 扫 state.json 里所有 active/merging/resolving 的 slot
  //   - 对应卡片：清瞬态 label（STARTED-x / ACK-x / CLAIMED / STALE-RUNTIME）+ 移回首阶段 trigger state（Todo）
  //   - 清 state.json 把 slot 置 idle + 清 lease
  //   返回回收了多少张卡。
  recoverOrphans(project: string): Promise<number>;
}

export interface PipelineServiceDeps {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly events: DomainEventBus;
  readonly spawner: ProcessSpawner;
  readonly executor?: PipelineExecutor;
}

export class PipelineService {
  constructor(private readonly deps: PipelineServiceDeps) {}

  /** 启动 pipeline —— 已在跑直接返当前 pid。 */
  async start(project: string): Promise<Result<PipelineStatusInfo, DomainError>> {
    if (!isValidProject(project)) return err(invalidProject());
    if (!this.deps.fs.exists(projectDir(project))) {
      return err(projectNotFound(project));
    }
    const existing = this.readSupervisorPid(project);
    if (existing) {
      return ok({ status: 'running', pid: existing });
    }
    if (!this.deps.fs.exists(logsDir(project))) {
      this.deps.fs.mkdir(logsDir(project), { recursive: true });
    }
    // v0.50.8：启动前先回收遗孤卡片 —— 上一轮被 stop/crash 的卡，slot 还 active 但
    // tick 进程没了，MonitorEngine 会把它打 STALE-RUNTIME，下一轮又被 SKIP，最后
    // 链式升级到 ACK-TIMEOUT / NEEDS-FIX，卡在 Inprogress 永远跑不起来。
    // 这里一次性清 label + 移回 Todo，让下一个 tick 能重新 prepare 派发。
    // executor 缺失时跳过（单元测试场景），线上容器总会注入。
    if (this.deps.executor) {
      try {
        await this.deps.executor.recoverOrphans(project);
      } catch {
        /* 回收失败不阻塞 start —— 坏情况也就退化到老行为 */
      }
    }
    const date = this.deps.clock.nowIso().slice(0, 10);
    const logPath = resolve(logsDir(project), `console-tick-${date}.log`);
    try {
      const child = this.deps.spawner.spawnSupervisor({
        args: ['tick', project],
        logPath,
      });
      const pid = child.pid ?? null;
      // v0.50.7：写 supervisor.pid 文件 —— ProjectService.isPipelineRunning 靠它判活。
      // 历史上 sps tick 进程不自己写这个文件（v0.44 Console 引入时的设计缺陷，
      // 从来没有生效过 pipeline running 检测）。Service 层一口气把 spawn + pid
      // 登记都做了，对外原子。
      if (pid !== null && pid > 0) {
        try {
          this.deps.fs.writeFileAtomic(supervisorPidFile(project), `${pid}\n`);
        } catch {
          /* pid 文件写失败不阻塞启动，下一次 poll 会补偿 */
        }
      }
      this.deps.events.emit({
        type: 'pipeline.started',
        project,
        pid: pid ?? 0,
        ts: this.deps.clock.now(),
      });
      return ok({ status: 'running', pid });
    } catch (cause) {
      return err(
        domainError('external', 'PIPELINE_SPAWN_FAIL', '启动 pipeline 失败', {
          cause,
          details: { message: cause instanceof Error ? cause.message : String(cause) },
        }),
      );
    }
  }

  async stop(project: string): Promise<Result<void, DomainError>> {
    if (!isValidProject(project)) return err(invalidProject());
    if (!this.deps.executor) {
      return err(
        domainError('internal', 'EXECUTOR_MISSING', 'PipelineExecutor 未注入'),
      );
    }
    try {
      await this.deps.executor.stop(project);
    } catch (cause) {
      return err(
        domainError('external', 'PIPELINE_STOP_FAIL', 'stop pipeline 失败', {
          cause,
          details: { message: cause instanceof Error ? cause.message : String(cause) },
        }),
      );
    }
    // 清 supervisor.pid —— pipeline 已经停了，配对的文件也该清
    try {
      const pidPath = supervisorPidFile(project);
      if (this.deps.fs.exists(pidPath)) {
        this.deps.fs.unlink(pidPath);
      }
    } catch {
      /* best effort */
    }
    this.deps.events.emit({
      type: 'pipeline.stopped',
      project,
      ts: this.deps.clock.now(),
    });
    return ok(undefined);
  }

  async reset(
    project: string,
    opts: ResetPipelineOpts = {},
  ): Promise<Result<void, DomainError>> {
    if (!isValidProject(project)) return err(invalidProject());
    if (!this.deps.executor) {
      return err(domainError('internal', 'EXECUTOR_MISSING', 'PipelineExecutor 未注入'));
    }
    try {
      await this.deps.executor.reset(project, opts);
    } catch (cause) {
      return err(
        domainError('external', 'PIPELINE_RESET_FAIL', 'reset pipeline 失败', {
          cause,
        }),
      );
    }
    return ok(undefined);
  }

  async status(project: string): Promise<Result<PipelineStatusInfo, DomainError>> {
    if (!isValidProject(project)) return err(invalidProject());
    const pid = this.readSupervisorPid(project);
    return ok({ status: pid ? 'running' : 'idle', pid });
  }

  // ─── Pipeline yaml CRUD ──────────────────────────────────────────

  async listPipelines(project: string): Promise<Result<PipelineSummary>> {
    if (!isValidProject(project)) return err(invalidProject());
    const dir = pipelinesDir(project);
    if (!this.deps.fs.exists(dir)) {
      return ok({ active: null, available: [] });
    }
    let files: string[];
    try {
      files = this.deps.fs
        .readDir(dir)
        .filter((e) => e.isFile && e.name.endsWith('.yaml'))
        .map((e) => e.name)
        .sort();
    } catch (cause) {
      return err(
        domainError('internal', 'PIPELINES_READ_FAIL', 'pipelines 目录读取失败', { cause }),
      );
    }
    const activePath = activePipelineFile(project);
    let activeHash: string | null = null;
    if (this.deps.fs.exists(activePath)) {
      try {
        const content = this.deps.fs.readFile(activePath);
        activeHash = createHash('sha256').update(content).digest('hex');
      } catch {
        /* ignore */
      }
    }
    const available = files
      .filter((f) => f !== 'project.yaml')
      .map((name) => {
        const full = resolve(dir, name);
        let isActive = false;
        try {
          const content = this.deps.fs.readFile(full);
          isActive = activeHash !== null && createHash('sha256').update(content).digest('hex') === activeHash;
        } catch {
          /* ignore */
        }
        return { name, isActive };
      });
    return ok({ active: activeHash ? 'project.yaml' : null, available });
  }

  async readPipeline(
    project: string,
    filename: string,
  ): Promise<Result<PipelineFileContent, DomainError>> {
    if (!isValidProject(project)) return err(invalidProject());
    if (!PipelineFilenameRe.test(filename)) {
      return err(domainError('validation', 'INVALID_FILENAME', 'pipeline 文件名非法'));
    }
    const path = pipelineFile(project, filename);
    if (!this.deps.fs.exists(path)) {
      return err(domainError('not-found', 'PIPELINE_NOT_FOUND', 'pipeline 文件不存在'));
    }
    let content: string;
    try {
      content = this.deps.fs.readFile(path);
    } catch (cause) {
      return err(domainError('internal', 'PIPELINE_READ_FAIL', '读取失败', { cause }));
    }
    const etag = hashEtag(content);
    let parsed: unknown = null;
    let parseError: string | null = null;
    try {
      parsed = YAML.parse(content);
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }
    return ok({
      content,
      etag,
      parsed,
      parseError,
      isActive: filename === 'project.yaml',
    });
  }

  async writePipeline(
    project: string,
    filename: string,
    content: string,
    etag: string,
  ): Promise<Result<{ etag: string }, DomainError>> {
    if (!isValidProject(project)) return err(invalidProject());
    if (!PipelineFilenameRe.test(filename)) {
      return err(domainError('validation', 'INVALID_FILENAME', 'pipeline 文件名非法'));
    }
    if (!etag) {
      return err(domainError('validation', 'ETAG_REQUIRED', 'etag 必填'));
    }
    const path = pipelineFile(project, filename);
    if (!this.deps.fs.exists(path)) {
      return err(domainError('not-found', 'PIPELINE_NOT_FOUND', 'pipeline 文件不存在'));
    }
    let current: string;
    try {
      current = this.deps.fs.readFile(path);
    } catch (cause) {
      return err(domainError('internal', 'PIPELINE_READ_FAIL', '读取失败', { cause }));
    }
    if (hashEtag(current) !== etag) {
      return err(
        domainError('conflict', 'PIPELINE_ETAG_MISMATCH', 'pipeline 被其它人修改，请重新加载'),
      );
    }
    try {
      YAML.parse(content);
    } catch (e) {
      return err(
        domainError('validation', 'YAML_INVALID', 'YAML 语法错误', {
          details: { message: e instanceof Error ? e.message : String(e) },
        }),
      );
    }
    try {
      this.deps.fs.writeFileAtomic(path, content);
    } catch (cause) {
      return err(domainError('internal', 'PIPELINE_WRITE_FAIL', '写入失败', { cause }));
    }
    return ok({ etag: hashEtag(content) });
  }

  async createPipeline(
    project: string,
    input: CreatePipelineInput,
  ): Promise<Result<{ name: string; content: string; etag: string }, DomainError>> {
    if (!isValidProject(project)) return err(invalidProject());
    if (!PipelineFilenameRe.test(input.name)) {
      return err(domainError('validation', 'INVALID_FILENAME', '文件名非法'));
    }
    const dir = pipelinesDir(project);
    if (!this.deps.fs.exists(dir)) {
      return err(domainError('not-found', 'PIPELINES_DIR_NOT_FOUND', 'pipelines 目录不存在'));
    }
    const path = pipelineFile(project, input.name);
    if (this.deps.fs.exists(path)) {
      return err(domainError('conflict', 'PIPELINE_EXISTS', 'pipeline 已存在'));
    }
    const template = input.template ?? 'blank';
    let content: string;
    if (template === 'sample') {
      const src = resolve(dir, 'sample.yaml.example');
      if (!this.deps.fs.exists(src)) {
        return err(domainError('not-found', 'SAMPLE_NOT_FOUND', 'sample 模板不存在'));
      }
      content = this.deps.fs.readFile(src);
    } else if (template === 'active') {
      const src = activePipelineFile(project);
      if (!this.deps.fs.exists(src)) {
        return err(domainError('not-found', 'ACTIVE_NOT_FOUND', '当前 active pipeline 不存在'));
      }
      content = this.deps.fs.readFile(src);
    } else {
      content = `mode: project\n\nstages:\n  - name: develop\n    on_complete: "move_card Done"\n    on_fail:\n      action: "label NEEDS-FIX"\n      halt: true\n`;
    }
    try {
      this.deps.fs.writeFileAtomic(path, content);
    } catch (cause) {
      return err(domainError('internal', 'PIPELINE_WRITE_FAIL', '写入失败', { cause }));
    }
    return ok({ name: input.name, content, etag: hashEtag(content) });
  }

  async deletePipeline(
    project: string,
    filename: string,
  ): Promise<Result<void, DomainError>> {
    if (!isValidProject(project)) return err(invalidProject());
    if (!PipelineFilenameRe.test(filename)) {
      return err(domainError('validation', 'INVALID_FILENAME', '文件名非法'));
    }
    if (filename === 'project.yaml') {
      return err(
        domainError('conflict', 'CANNOT_DELETE_ACTIVE', '当前 active pipeline 不能删，先切换再删'),
      );
    }
    if (filename === 'sample.yaml.example') {
      return err(
        domainError('conflict', 'CANNOT_DELETE_SAMPLE', 'sample 模板不能删'),
      );
    }
    const path = pipelineFile(project, filename);
    if (!this.deps.fs.exists(path)) {
      return err(domainError('not-found', 'PIPELINE_NOT_FOUND', 'pipeline 不存在'));
    }
    try {
      this.deps.fs.unlink(path);
    } catch (cause) {
      return err(domainError('internal', 'PIPELINE_DELETE_FAIL', '删除失败', { cause }));
    }
    return ok(undefined);
  }

  /** 切换 active pipeline —— 复制指定文件到 project.yaml。 */
  async switchActive(
    project: string,
    filename: string,
  ): Promise<Result<{ activePipeline: string }, DomainError>> {
    if (!isValidProject(project)) return err(invalidProject());
    if (!PipelineFilenameRe.test(filename) || filename === 'project.yaml') {
      return err(
        domainError('validation', 'INVALID_FILENAME', 'pipeline 文件名非法或不能是 project.yaml'),
      );
    }
    if (this.readSupervisorPid(project)) {
      return err(
        domainError(
          'conflict',
          'PIPELINE_RUNNING',
          'pipeline 正在跑，先停止再切换',
        ),
      );
    }
    const src = pipelineFile(project, filename);
    if (!this.deps.fs.exists(src)) {
      return err(domainError('not-found', 'PIPELINE_NOT_FOUND', '源 pipeline 不存在'));
    }
    try {
      const content = this.deps.fs.readFile(src);
      this.deps.fs.writeFileAtomic(activePipelineFile(project), content);
    } catch (cause) {
      return err(domainError('internal', 'PIPELINE_SWITCH_FAIL', '切换失败', { cause }));
    }
    return ok({ activePipeline: filename });
  }

  // ─── 内部 ─────────────────────────────────────────────────────────

  private readSupervisorPid(project: string): number | null {
    const path = supervisorPidFile(project);
    if (!this.deps.fs.exists(path)) return null;
    try {
      const raw = this.deps.fs.readFile(path);
      const pid = Number.parseInt(raw.trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) return null;
      try {
        process.kill(pid, 0);
        return pid;
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────

function hashEtag(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function isValidProject(project: string): boolean {
  return typeof project === 'string' && /^[a-zA-Z0-9_-]+$/.test(project);
}

function invalidProject(): DomainError {
  return domainError('validation', 'INVALID_PROJECT_NAME', '项目名非法');
}

function projectNotFound(name: string): DomainError {
  return domainError('not-found', 'PROJECT_NOT_FOUND', `项目 ${name} 不存在`);
}
