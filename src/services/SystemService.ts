/**
 * @module        services/SystemService
 * @description   系统级信息 + ~/.coral/env CRUD + npm upgrade + doctor
 *
 * @layer         services
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import type { Clock } from '../infra/clock.js';
import type { FileSystem } from '../infra/filesystem.js';
import type { ProcessSpawner } from '../infra/spawn.js';
import { domainError, type DomainError } from '../shared/errors.js';
import { err, ok, type Result } from '../shared/result.js';
import {
  globalEnvFile,
  projectConfFile,
  projectsDir,
  runtimeDir,
  supervisorPidFile,
  WorkerMarkerFilenameRe,
} from '../shared/runtimePaths.js';
import { resolve } from 'node:path';

// ─── Types ────────────────────────────────────────────────────────

export interface SystemInfo {
  readonly version: string;
  readonly nodeVersion: string;
  readonly startedAt: string;
  readonly uptimeMs: number;
  readonly platform: string;
  readonly pid: number;
}

export interface EnvEntry {
  readonly key: string;
  readonly value: string;
  readonly masked: boolean;
}

export interface EnvListing {
  readonly path: string;
  readonly exists: boolean;
  readonly entries: EnvEntry[];
}

export interface EnvRaw {
  readonly path: string;
  readonly exists: boolean;
  readonly content: string;
  readonly etag: string;
}

export interface LatestVersion {
  readonly current: string;
  readonly latest: string;
  readonly upToDate: boolean;
}

export interface UpgradeResult {
  readonly ok: boolean;
  readonly output: string;
  /** v0.50.14：npm 真正装上的版本号（null 表示查不到） */
  readonly installedVersion: string | null;
  /** 用户可以复制到终端自己跑的等价命令 */
  readonly command: string;
}

export interface DoctorReport {
  readonly project: string;
  readonly issues: string[];
  readonly ok: boolean;
}

/** v0.50.14：单项目真实 doctor 输出（spawn `sps doctor <proj> --json`） */
export interface DoctorCheck {
  readonly name: string;
  readonly status: 'pass' | 'warn' | 'fail' | 'info';
  readonly message: string;
}

export interface DoctorProjectResult {
  readonly project: string;
  readonly ok: boolean;
  readonly checks: DoctorCheck[];
  readonly fixes: string[];
  /** 命令 stderr/log（debug 用） */
  readonly log: string;
}

const SECRET_KEY_PATTERNS = [
  /_TOKEN$/,
  /_KEY$/,
  /_SECRET$/,
  /_PASSWORD$/,
  /_PASS$/,
  /^(ANTHROPIC|OPENAI|CLAUDE|PLANE|TRELLO|MATRIX)_/,
];

// ─── Service ──────────────────────────────────────────────────────

export interface SystemServiceDeps {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly spawner: ProcessSpawner;
  readonly version: string;
  readonly startedAt: Date;
}

export class SystemService {
  constructor(private readonly deps: SystemServiceDeps) {}

  info(): SystemInfo {
    return {
      version: this.deps.version,
      nodeVersion: process.version,
      startedAt: this.deps.startedAt.toISOString(),
      uptimeMs: this.deps.clock.now() - this.deps.startedAt.getTime(),
      platform: process.platform,
      pid: process.pid,
    };
  }

  async readEnv(): Promise<Result<EnvListing, DomainError>> {
    const path = globalEnvFile();
    if (!this.deps.fs.exists(path)) {
      return ok({ path, exists: false, entries: [] });
    }
    try {
      const raw = this.deps.fs.readFile(path);
      const entries: EnvEntry[] = [];
      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const m = t.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=["']?(.*?)["']?\s*$/);
        if (!m) continue;
        const key = m[1] ?? '';
        const value = m[2] ?? '';
        const masked = isSecret(key);
        entries.push({ key, value: masked ? maskSecret(value) : value, masked });
      }
      return ok({ path, exists: true, entries });
    } catch (cause) {
      return err(domainError('internal', 'ENV_READ_FAIL', 'env 文件读取失败', { cause }));
    }
  }

  async readEnvRaw(): Promise<Result<EnvRaw, DomainError>> {
    const path = globalEnvFile();
    if (!this.deps.fs.exists(path)) {
      return ok({ path, exists: false, content: '', etag: '' });
    }
    try {
      const content = this.deps.fs.readFile(path);
      return ok({ path, exists: true, content, etag: hashEtag(content) });
    } catch (cause) {
      return err(domainError('internal', 'ENV_READ_FAIL', 'env 文件读取失败', { cause }));
    }
  }

  async writeEnv(
    content: string,
    etag: string | undefined,
  ): Promise<Result<{ etag: string }, DomainError>> {
    const path = globalEnvFile();
    const exists = this.deps.fs.exists(path);

    if (exists) {
      if (!etag) {
        return err(domainError('validation', 'ETAG_REQUIRED', 'etag 必填（已有文件）'));
      }
      const currentContent = this.deps.fs.readFile(path);
      const currentEtag = hashEtag(currentContent);
      if (etag !== currentEtag) {
        return err(
          domainError(
            'conflict',
            'ENV_ETAG_MISMATCH',
            'env 已被其它编辑修改，请重新加载',
            { details: { currentEtag } },
          ),
        );
      }
    }
    try {
      this.deps.fs.writeFileAtomic(path, content);
      // 保持 0600 权限 —— env 常含 secret
      try {
        chmodSync(path, 0o600);
      } catch {
        /* best effort */
      }
    } catch (cause) {
      return err(domainError('internal', 'ENV_WRITE_FAIL', 'env 写入失败', { cause }));
    }
    return ok({ etag: hashEtag(content) });
  }

  async latestVersion(): Promise<Result<LatestVersion, DomainError>> {
    // `spawner` is wired as ProcessSpawner for sps CLI; `npm view` is a different
    // binary so we spawn it directly (still isolated to the service layer).
    return new Promise((resolvePromise) => {
      const child = spawn('npm', ['view', '@coralai/sps-cli', 'version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* noop */
        }
        resolvePromise(
          err(
            domainError('external', 'NPM_VIEW_TIMEOUT', 'npm view 超时 (10s)', {
              details: { timeoutMs: 10_000 },
            }),
          ),
        );
      }, 10_000);
      child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        if (code === 0) {
          const latest = stdout.trim();
          resolvePromise(
            ok({
              current: this.deps.version,
              latest,
              upToDate: this.deps.version === latest,
            }),
          );
        } else {
          resolvePromise(
            err(
              domainError('external', 'NPM_VIEW_FAIL', 'npm view 失败', {
                details: { stderr: stderr.trim(), exitCode: code },
              }),
            ),
          );
        }
      });
      child.on('error', (e: Error) => {
        clearTimeout(timer);
        resolvePromise(
          err(
            domainError('external', 'NPM_VIEW_ERROR', 'npm view 出错', {
              cause: e,
              details: { message: e.message },
            }),
          ),
        );
      });
    });
  }

  /**
   * 执行 npm i -g —— pipeline 在跑时拒绝以保证原子性。
   *
   * v0.50.14：返回真正装上的版本号（npm ls 验证），避免 npm 吞错误假报成功。
   */
  async upgrade(): Promise<Result<UpgradeResult, DomainError>> {
    const running = this.listRunningPipelines();
    if (running.length > 0) {
      return err(
        domainError('conflict', 'PIPELINES_RUNNING', '有 pipeline 在跑，升级前请先停止', {
          details: { projects: running },
        }),
      );
    }

    const command = 'npm i -g @coralai/sps-cli@latest';

    const runResult = await new Promise<{ code: number | null; output: string }>((resolvePromise) => {
      const child = spawn('npm', ['i', '-g', '@coralai/sps-cli@latest'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* noop */
        }
        resolvePromise({ code: null, output: output + '\n[timeout 120s]' });
      }, 120_000);
      child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolvePromise({ code, output });
      });
      child.on('error', (e: Error) => {
        clearTimeout(timer);
        resolvePromise({ code: null, output: output + `\n[spawn error: ${e.message}]` });
      });
    });

    // 验证：npm ls -g 真去读装了啥。比只看 exit code 可靠——npm 有时 code 0
    // 但实际没装（权限 / registry 缓存 / 静默失败）。
    const installedVersion = await this.readInstalledVersion();
    const npmExitOk = runResult.code === 0;
    const versionSane = installedVersion != null && installedVersion !== this.deps.version;
    // 成功条件：npm exit 0 AND 装上的版本 != console 当前版本（证明真的换了）
    // 注意：console 进程用的还是老版本代码，`this.deps.version` 是老的。
    return ok({
      ok: npmExitOk && versionSane,
      output: runResult.output,
      installedVersion,
      command,
    });
  }

  /** 读全局安装的 sps-cli 真实版本（spawn `npm ls -g --json`）。 */
  private readInstalledVersion(): Promise<string | null> {
    return new Promise((resolvePromise) => {
      const child = spawn('npm', ['ls', '-g', '--depth=0', '--json', '@coralai/sps-cli'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout?.on('data', (d: Buffer) => (out += d.toString()));
      child.stderr?.on('data', () => { /* npm warnings ignored */ });
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
        resolvePromise(null);
      }, 10_000);
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const parsed = JSON.parse(out);
          const v = parsed?.dependencies?.['@coralai/sps-cli']?.version;
          resolvePromise(typeof v === 'string' ? v : null);
        } catch {
          resolvePromise(null);
        }
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolvePromise(null);
      });
    });
  }

  /**
   * v0.50.14：单项目 spawn `sps doctor <project> [--fix] --json`，解析 JSON 输出。
   *
   * 实现注意：`executeDoctor` 内部用 `process.exit()` 结束，不能 in-process 调，否则
   * 把 console server 也杀了。跟 pipeline stop/reset 同样走子进程隔离。
   */
  async doctorProject(
    project: string,
    opts: { fix?: boolean } = {},
  ): Promise<Result<DoctorProjectResult, DomainError>> {
    if (!isValidProject(project)) {
      return err(domainError('validation', 'INVALID_PROJECT_NAME', '项目名非法'));
    }
    const args = ['doctor', project, '--json'];
    if (opts.fix) args.push('--fix');
    try {
      const res = await this.deps.spawner.runCliSync({ args, timeoutMs: 60_000 });
      // doctor 在有 fail check 时 exit=1，但仍会打印 JSON。解析优先。
      const stdout = res.stdout || '';
      let parsed: {
        project?: string;
        status?: string;
        details?: { checks?: DoctorCheck[]; fixes?: string[] };
      } | null = null;
      try {
        parsed = JSON.parse(stdout);
      } catch {
        return err(
          domainError('external', 'DOCTOR_PARSE_FAIL', 'doctor JSON 解析失败', {
            details: { stdout: stdout.slice(0, 500), stderr: res.stderr.slice(0, 500) },
          }),
        );
      }
      const checks = parsed?.details?.checks ?? [];
      const fixes = parsed?.details?.fixes ?? [];
      return ok({
        project,
        ok: !checks.some((c) => c.status === 'fail'),
        checks,
        fixes,
        log: res.stderr,
      });
    } catch (cause) {
      return err(
        domainError('external', 'DOCTOR_SPAWN_FAIL', 'doctor 启动失败', { cause }),
      );
    }
  }

  async doctorAll(): Promise<Result<DoctorReport[], DomainError>> {
    const root = projectsDir();
    if (!this.deps.fs.exists(root)) {
      return ok([]);
    }
    let names: string[];
    try {
      names = this.deps.fs.readDir(root).filter((e) => e.isDirectory).map((e) => e.name);
    } catch (cause) {
      return err(
        domainError('internal', 'PROJECTS_READ_FAIL', 'projects 目录读取失败', { cause }),
      );
    }
    const now = this.deps.clock.now();
    const report: DoctorReport[] = [];
    for (const name of names) {
      const issues: string[] = [];
      if (!this.deps.fs.exists(projectConfFile(name))) issues.push('missing conf');
      const cardsDir = resolve(root, name, 'cards');
      if (!this.deps.fs.exists(cardsDir)) issues.push('missing cards/');
      const runtime = runtimeDir(name);
      if (this.deps.fs.exists(runtime)) {
        try {
          const markers = this.deps.fs
            .readDir(runtime)
            .filter((e) => e.isFile && WorkerMarkerFilenameRe.test(e.name));
          for (const mf of markers) {
            const stat = this.deps.fs.stat(resolve(runtime, mf.name));
            if (stat) {
              const ageMin = Math.floor((now - stat.mtimeMs) / 60000);
              if (ageMin > 60) issues.push(`stale marker ${mf.name} (${ageMin}m)`);
            }
          }
        } catch {
          /* ignore */
        }
      }
      report.push({ project: name, issues, ok: issues.length === 0 });
    }
    return ok(report);
  }

  /** 列出当前在跑 pipeline 的项目名 —— upgrade 前置检查用 */
  private listRunningPipelines(): string[] {
    const root = projectsDir();
    if (!this.deps.fs.exists(root)) return [];
    const out: string[] = [];
    try {
      const names = this.deps.fs.readDir(root).filter((e) => e.isDirectory).map((e) => e.name);
      for (const name of names) {
        const pidFile = supervisorPidFile(name);
        if (!this.deps.fs.exists(pidFile)) continue;
        try {
          const pid = Number.parseInt(this.deps.fs.readFile(pidFile).trim(), 10);
          if (pid > 0) {
            try {
              process.kill(pid, 0);
              out.push(name);
            } catch {
              /* dead pid */
            }
          }
        } catch {
          /* unreadable */
        }
      }
    } catch {
      /* ignore */
    }
    return out;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 6) return '****';
  return value.slice(0, 4) + '****';
}

function isSecret(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((p) => p.test(key));
}

function hashEtag(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function isValidProject(project: string): boolean {
  return typeof project === 'string' && /^[a-zA-Z0-9_-]+$/.test(project);
}
