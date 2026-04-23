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
}

export interface DoctorReport {
  readonly project: string;
  readonly issues: string[];
  readonly ok: boolean;
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

  /** 执行 npm i -g —— pipeline 在跑时拒绝以保证原子性。 */
  async upgrade(): Promise<Result<UpgradeResult, DomainError>> {
    const running = this.listRunningPipelines();
    if (running.length > 0) {
      return err(
        domainError('conflict', 'PIPELINES_RUNNING', '有 pipeline 在跑，升级前请先停止', {
          details: { projects: running },
        }),
      );
    }

    return new Promise((resolvePromise) => {
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
        resolvePromise(ok({ ok: false, output: output + '\n[timeout 120s]' }));
      }, 120_000);
      child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolvePromise(ok({ ok: code === 0, output }));
      });
      child.on('error', (e: Error) => {
        clearTimeout(timer);
        resolvePromise(ok({ ok: false, output: output + `\n[spawn error: ${e.message}]` }));
      });
    });
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
