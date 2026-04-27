/**
 * @module        services/ProjectService
 * @description   项目生命周期 service —— list / get / create / delete / conf CRUD
 *
 * @layer         services
 *
 * 职责：
 *   - 扫 ~/.coral/projects/ 汇总每项目的概览（cards / workers / pipelineStatus）
 *   - 通过 executeProjectInit 创建新项目（CLI 和 Console 共用同一条路径）
 *   - conf 文件读写 + etag 乐观锁
 *   - 删项目（可选同时删 repo 的 .claude/）
 *
 * 不直接触发 executeProjectInit —— 保留为 Phase 3 才接 CLI 命令层迁移时注入的
 * 钩子，这里先用 fs 原语实现 conf 读写，项目创建接一个 ProjectInitExecutor port。
 */
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { Clock } from '../infra/clock.js';
import type { FileSystem } from '../infra/filesystem.js';
import type { DomainEventBus } from '../shared/domainEvents.js';
import { type DomainError, domainError } from '../shared/errors.js';
import { err, ok, type Result } from '../shared/result.js';
import {
  cardsDir,
  projectConfFile,
  projectDir,
  projectsDir,
  runtimeDir,
  slotFromMarkerFilename,
  supervisorPidFile,
  WorkerMarkerFilenameRe,
} from '../shared/runtimePaths.js';

// ─── Domain types ─────────────────────────────────────────────────

export type PipelineStatus = 'idle' | 'running' | 'stopping' | 'error';

export interface ProjectSummary {
  readonly name: string;
  readonly repoDir: string | null;
  readonly pmBackend: string;
  readonly agentProvider: string;
  readonly cards: { total: number; inprogress: number; done: number };
  readonly workers: { total: number; active: number };
  readonly pipelineStatus: PipelineStatus;
  readonly lastActivityAt: string | null;
}

export interface ConfContent {
  readonly content: string;
  readonly etag: string;
}

export interface ProjectInitExecutor {
  /**
   * 由 Phase 3 的 delivery 层注入。默认 container 未注入时 create() 会返 external 错误。
   * 拆出 port 是因为：
   *   - executeProjectInit 目前深度依赖 process.exit / 交互 readline，短期迁不进来
   *   - 重构期间保留命令层调 Service，Service 再回调命令层的 port 实现
   */
  init(project: string, opts: ProjectInitOpts): Promise<void>;
}

export interface ProjectInitOpts {
  projectDir: string;
  mergeBranch: string;
  maxWorkers: string;
  gitlabProject?: string;
  gitlabProjectId?: string;
  matrixRoomId?: string;
  /** v0.50.24：是否启用 git（false 时不写 GITLAB_* 到 conf，project.yaml 写 git: false） */
  enableGit?: boolean;
  /** v0.50.24：ACK 超时秒数（默认 300 = 5 分钟） */
  ackTimeoutS?: number;
  /** v0.51.0：启用 wiki/ 知识库（默认 false）。true → conf 写 WIKI_ENABLED=true 并自动 scaffold。 */
  enableWiki?: boolean;
}

export interface CreateProjectInput extends ProjectInitOpts {
  name: string;
}

export interface DeleteProjectOpts {
  includeClaudeDir?: boolean;
}

export interface DeleteProjectReport {
  readonly name: string;
  readonly claudeRemoved: Array<{ path: string; ok: boolean; error?: string }>;
}

// ─── Service ──────────────────────────────────────────────────────

export interface ProjectServiceDeps {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly events: DomainEventBus;
  readonly initExecutor?: ProjectInitExecutor;
}

export class ProjectService {
  constructor(private readonly deps: ProjectServiceDeps) {}

  /** 列出 ~/.coral/projects/ 下所有项目的概览。 */
  async list(): Promise<Result<ProjectSummary[]>> {
    const base = projectsDir();
    if (!this.deps.fs.exists(base)) {
      return ok([]);
    }
    let entries;
    try {
      entries = this.deps.fs.readDir(base);
    } catch (cause) {
      return err(domainError('internal', 'PROJECTS_DIR_READ_FAIL', '无法读取项目目录', { cause }));
    }
    const names = entries.filter((e) => e.isDirectory).map((e) => e.name).sort();
    const summaries: ProjectSummary[] = [];
    for (const name of names) {
      const r = this.readSummary(name);
      if (r) summaries.push(r);
    }
    return ok(summaries);
  }

  /** 获取单个项目概览。找不到返 not-found。 */
  async get(name: string): Promise<Result<ProjectSummary>> {
    if (!this.isValidName(name)) {
      return err(invalidName());
    }
    const dir = projectDir(name);
    if (!this.deps.fs.exists(dir)) {
      return err(projectNotFound(name));
    }
    const summary = this.readSummary(name);
    if (!summary) {
      return err(projectNotFound(name));
    }
    return ok(summary);
  }

  /**
   * 创建项目。需要 ProjectInitExecutor 注入。
   * 已存在返 conflict。
   */
  async create(input: CreateProjectInput): Promise<Result<ProjectSummary>> {
    if (!this.isValidName(input.name)) {
      return err(invalidName());
    }
    if (this.deps.fs.exists(projectDir(input.name))) {
      return err(
        domainError('conflict', 'PROJECT_EXISTS', `项目 ${input.name} 已存在`, {
          details: { name: input.name },
        }),
      );
    }
    if (!this.deps.initExecutor) {
      return err(
        domainError(
          'internal',
          'INIT_EXECUTOR_MISSING',
          '项目创建需要 ProjectInitExecutor 注入（Phase 3 task）',
        ),
      );
    }
    try {
      await this.deps.initExecutor.init(input.name, input);
    } catch (cause) {
      return err(
        domainError('external', 'PROJECT_INIT_FAIL', '项目初始化失败', {
          cause,
          details: { message: cause instanceof Error ? cause.message : String(cause) },
        }),
      );
    }
    const summary = this.readSummary(input.name);
    if (!summary) {
      return err(
        domainError('internal', 'PROJECT_INIT_POST_READ_FAIL', '初始化完成但读不到项目概览'),
      );
    }
    return ok(summary);
  }

  /**
   * 删除项目。pipeline 在跑时拒绝（conflict）。
   * opts.includeClaudeDir 默认 true，也会删对应 repo 的 .claude/。
   */
  async delete(
    name: string,
    opts: DeleteProjectOpts = {},
  ): Promise<Result<DeleteProjectReport>> {
    if (!this.isValidName(name)) {
      return err(invalidName());
    }
    const dir = projectDir(name);
    if (!this.deps.fs.exists(dir)) {
      return err(projectNotFound(name));
    }
    if (this.isPipelineRunning(name)) {
      return err(
        domainError('conflict', 'PIPELINE_RUNNING', '项目 pipeline 正在运行，先停止再删除', {
          details: { project: name },
        }),
      );
    }

    const includeClaude = opts.includeClaudeDir !== false;
    let repoDirPath: string | null = null;
    if (includeClaude) {
      try {
        const conf = this.deps.fs.readFile(projectConfFile(name));
        const match = conf.match(/export\s+PROJECT_DIR=["']?([^"'\n]+)/);
        repoDirPath = match?.[1]?.trim() || null;
      } catch {
        // conf 丢了就不处理 claude/
      }
    }

    try {
      this.deps.fs.rm(dir, { recursive: true, force: true });
    } catch (cause) {
      return err(
        domainError('internal', 'PROJECT_DELETE_FAIL', '项目目录删除失败', { cause }),
      );
    }

    const claudeRemoved: DeleteProjectReport['claudeRemoved'] = [];
    if (includeClaude && repoDirPath) {
      const claudePath = resolve(repoDirPath, '.claude');
      if (this.deps.fs.exists(claudePath)) {
        try {
          this.deps.fs.rm(claudePath, { recursive: true, force: true });
          claudeRemoved.push({ path: claudePath, ok: true });
        } catch (cause) {
          claudeRemoved.push({
            path: claudePath,
            ok: false,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    }

    return ok({ name, claudeRemoved });
  }

  /** 读 conf 文件 —— 返回 content + etag（SHA-256 前 16 位）。 */
  async readConf(name: string): Promise<Result<ConfContent>> {
    if (!this.isValidName(name)) return err(invalidName());
    const confPath = projectConfFile(name);
    if (!this.deps.fs.exists(confPath)) {
      return err(
        domainError('not-found', 'CONF_NOT_FOUND', `项目 ${name} 的 conf 文件不存在`),
      );
    }
    try {
      const content = this.deps.fs.readFile(confPath);
      return ok({ content, etag: hashEtag(content) });
    } catch (cause) {
      return err(domainError('internal', 'CONF_READ_FAIL', 'conf 读取失败', { cause }));
    }
  }

  /**
   * 写 conf —— etag 乐观锁。mismatch 返 conflict；内容相同 etag 不变。
   * 文件权限保持 0600（conf 可能含 secret）。
   */
  async writeConf(
    name: string,
    content: string,
    etag: string,
  ): Promise<Result<{ etag: string }>> {
    if (!this.isValidName(name)) return err(invalidName());
    const confPath = projectConfFile(name);
    if (!this.deps.fs.exists(confPath)) {
      return err(
        domainError('not-found', 'CONF_NOT_FOUND', `项目 ${name} 的 conf 文件不存在`),
      );
    }
    if (!etag || typeof etag !== 'string') {
      return err(
        domainError('validation', 'ETAG_REQUIRED', 'etag 必填 —— 避免并发覆盖'),
      );
    }
    let current: string;
    try {
      current = this.deps.fs.readFile(confPath);
    } catch (cause) {
      return err(domainError('internal', 'CONF_READ_FAIL', 'conf 读取失败', { cause }));
    }
    const currentEtag = hashEtag(current);
    if (etag !== currentEtag) {
      return err(
        domainError(
          'conflict',
          'CONF_ETAG_MISMATCH',
          'conf 已被其它编辑修改，请重新加载',
          { details: { currentEtag } },
        ),
      );
    }
    try {
      this.deps.fs.writeFileAtomic(confPath, content);
    } catch (cause) {
      return err(domainError('internal', 'CONF_WRITE_FAIL', 'conf 写入失败', { cause }));
    }
    return ok({ etag: hashEtag(content) });
  }

  // ─── 内部 helpers ────────────────────────────────────────────────

  private isValidName(name: string): boolean {
    return typeof name === 'string' && /^[a-zA-Z0-9_-]+$/.test(name);
  }

  private readSummary(name: string): ProjectSummary | null {
    const dir = projectDir(name);
    if (!this.deps.fs.exists(dir)) return null;

    const conf = this.parseConf(name);
    const cards = this.countCards(name);
    const workers = this.countWorkers(name);
    const pipelineStatus: PipelineStatus = this.isPipelineRunning(name) ? 'running' : 'idle';
    const lastActivityAt = (() => {
      const st = this.deps.fs.stat(runtimeDir(name));
      return st ? new Date(st.mtimeMs).toISOString() : null;
    })();

    return {
      name,
      repoDir: conf.PROJECT_DIR ?? conf.REPO_DIR ?? null,
      pmBackend: conf.PM_TOOL ?? 'markdown',
      agentProvider: conf.AGENT_PROVIDER ?? 'claude',
      cards,
      workers,
      pipelineStatus,
      lastActivityAt,
    };
  }

  private parseConf(name: string): Record<string, string> {
    const path = projectConfFile(name);
    if (!this.deps.fs.exists(path)) return {};
    const out: Record<string, string> = {};
    try {
      const text = this.deps.fs.readFile(path);
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const m = trimmed.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=["']?(.*?)["']?\s*$/);
        if (m) out[m[1]!] = m[2]!;
      }
    } catch {
      /* silently empty */
    }
    return out;
  }

  /**
   * 卡片计数 —— 遍历 cards/<state>/*.md 子目录。
   * v0.49.15 修过同一个坑，现在统一走 runtimePaths + 在 service 层单点实现。
   */
  private countCards(name: string): ProjectSummary['cards'] {
    const dir = cardsDir(name);
    if (!this.deps.fs.exists(dir)) return { total: 0, inprogress: 0, done: 0 };
    let total = 0;
    let inprogress = 0;
    let done = 0;
    try {
      for (const entry of this.deps.fs.readDir(dir)) {
        if (!entry.isDirectory) continue;
        const sub = resolve(dir, entry.name);
        const dirLower = entry.name.toLowerCase();
        let files;
        try {
          files = this.deps.fs.readDir(sub).filter(
            (e) => e.isFile && /^\d+.*\.md$/.test(e.name),
          );
        } catch {
          continue;
        }
        total += files.length;
        if (dirLower === 'inprogress') inprogress += files.length;
        else if (dirLower === 'done') done += files.length;
      }
    } catch {
      /* ignore */
    }
    return { total, inprogress, done };
  }

  /**
   * Worker marker 计数 —— 匹配双前缀 + 老单前缀两种格式（v0.49.16 之前遗留）。
   * 活跃判定：marker 最近 5 分钟内更新。
   */
  private countWorkers(name: string): ProjectSummary['workers'] {
    const dir = runtimeDir(name);
    if (!this.deps.fs.exists(dir)) return { total: 0, active: 0 };
    let total = 0;
    let active = 0;
    const now = this.deps.clock.now();
    try {
      for (const entry of this.deps.fs.readDir(dir)) {
        if (!entry.isFile) continue;
        if (!WorkerMarkerFilenameRe.test(entry.name)) continue;
        total++;
        const slot = slotFromMarkerFilename(entry.name);
        if (slot === null) continue;
        const stat = this.deps.fs.stat(resolve(dir, entry.name));
        if (stat && now - stat.mtimeMs < 5 * 60 * 1000) active++;
      }
    } catch {
      /* ignore */
    }
    return { total, active };
  }

  private isPipelineRunning(name: string): boolean {
    const pidPath = supervisorPidFile(name);
    if (!this.deps.fs.exists(pidPath)) return false;
    try {
      const raw = this.deps.fs.readFile(pidPath);
      const pid = Number.parseInt(raw.trim(), 10);
      if (!Number.isFinite(pid) || pid <= 0) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    } catch {
      return false;
    }
  }
}

// ─── Error factories ──────────────────────────────────────────────

function projectNotFound(name: string): DomainError {
  return domainError('not-found', 'PROJECT_NOT_FOUND', `项目 ${name} 不存在`, {
    details: { name },
  });
}

function invalidName(): DomainError {
  return domainError(
    'validation',
    'INVALID_PROJECT_NAME',
    '项目名非法 —— 只允许字母、数字、_ 和 -',
  );
}

function hashEtag(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}
