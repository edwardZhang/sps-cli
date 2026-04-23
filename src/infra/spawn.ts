/**
 * @module        infra/spawn
 * @description   ProcessSpawner port —— 只用于启动 supervisor（长跑 sps tick 进程）
 *
 * @layer         infra
 *
 * 注意：Console 层禁止用 spawn 执行同步 CLI 操作（如 card add / worker launch）。
 * 这些都应走 Service 层直接调 Domain。只有 pipeline supervisor 这种长跑 + detach
 * 的进程才合法用 spawn。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SupervisorSpawnOptions {
  /** supervisor 要带的参数，如 ['tick', '<project>'] */
  args: string[];
  /** 输出重定向目标文件 */
  logPath: string;
  /** 工作目录，可选 */
  cwd?: string;
}

export interface CliSyncOptions {
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

export interface CliSyncResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ProcessSpawner {
  /**
   * 启动一个 detached supervisor 进程，父退出后子继续跑。
   * 返回 ChildProcess 句柄（调用方可以 kill，但不 await）。
   */
  spawnSupervisor(opts: SupervisorSpawnOptions): ChildProcess;

  /**
   * 同步 spawn sps 子命令（短任务）—— 用于 executor glue。
   * Console 路由禁止直接用，必须经过 service → executor → spawner 这条路径。
   */
  runCliSync(opts: CliSyncOptions): Promise<CliSyncResult>;
}

/**
 * 定位 CLI 主入口 —— 优先用运行时的 process.argv[1]（就是当前 sps 可执行文件），
 * 测试环境兜底到源码路径。
 */
function cliEntry(): { node: string; entry: string } {
  return { node: process.argv[0] ?? 'node', entry: process.argv[1] ?? defaultEntry() };
}

function defaultEntry(): string {
  // infra/spawn.ts → src/ → workflow-cli/ → main.ts (源码模式) 或 dist/main.js（编译）
  const here = fileURLToPath(import.meta.url);
  // 源码：.../src/infra/spawn.ts → .../src/main.ts
  const srcSibling = resolve(dirname(here), '..', 'main.ts');
  if (existsSync(srcSibling)) return srcSibling;
  // 编译：.../dist/infra/spawn.js → .../dist/main.js
  const distSibling = resolve(dirname(here), '..', 'main.js');
  return distSibling;
}

export class NodeProcessSpawner implements ProcessSpawner {
  spawnSupervisor(opts: SupervisorSpawnOptions): ChildProcess {
    const { node, entry } = cliEntry();
    const logDir = dirname(opts.logPath);
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
    const logFd = openSync(opts.logPath, 'a');
    const child = spawn(node, [entry, ...opts.args], {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    return child;
  }

  runCliSync(opts: CliSyncOptions): Promise<CliSyncResult> {
    const { node, entry } = cliEntry();
    return new Promise((resolvePromise) => {
      const child = spawn(node, [entry, ...opts.args], {
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      const timer = opts.timeoutMs
        ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs)
        : null;
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolvePromise({ exitCode: code, stdout, stderr });
      });
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolvePromise({ exitCode: -1, stdout, stderr: stderr + String(err) });
      });
    });
  }
}

// ─── 测试用 fake ───────────────────────────────────────────────────

export interface FakeSpawnCall {
  args: string[];
  logPath: string;
  cwd?: string;
}

/**
 * 不真 spawn，仅记录调用。用于 Service 层单测验证 "PipelineService.start
 * 的确调用了 supervisor"。
 */
export class FakeProcessSpawner implements ProcessSpawner {
  public calls: FakeSpawnCall[] = [];
  public syncCalls: Array<{ args: string[]; cwd?: string }> = [];
  /** 测试可以预设每次 runCliSync 的响应；缺省返 { exitCode: 0, stdout:'', stderr:'' } */
  public nextSyncResult: CliSyncResult | null = null;
  private _pid = 100000;

  async runCliSync(opts: CliSyncOptions): Promise<CliSyncResult> {
    this.syncCalls.push({ args: opts.args, cwd: opts.cwd });
    return this.nextSyncResult ?? { exitCode: 0, stdout: '', stderr: '' };
  }

  spawnSupervisor(opts: SupervisorSpawnOptions): ChildProcess {
    this.calls.push({ args: opts.args, logPath: opts.logPath, cwd: opts.cwd });
    // 返回一个 stub 足够满足 ChildProcess 接口用到的字段
    const pid = this._pid++;
    const stub = {
      pid,
      unref() {},
      kill() {
        return true;
      },
      on() {
        return stub;
      },
      once() {
        return stub;
      },
      removeListener() {
        return stub;
      },
    } as unknown as ChildProcess;
    return stub;
  }
}
