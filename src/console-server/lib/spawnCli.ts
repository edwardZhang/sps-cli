/**
 * @module        console-server/lib/spawnCli
 * @description   把 sps console 接到现有 CLI 的底层工具：spawn 子进程跑 sps 命令
 *
 * 有两种调用：
 *   - spawnCliSync: 短任务（如 card add），等完成拿到 stdout/stderr
 *   - spawnCliDetached: 长任务（如 tick pipeline），后台跑 + detach + 写 pid 文件
 */
import { spawn, type ChildProcess, execFileSync } from 'node:child_process';
import { openSync } from 'node:fs';

function cliEntry(): { node: string; entry: string } {
  // process.argv[0] = node, process.argv[1] = sps/dist/main.js
  return { node: process.argv[0] ?? 'node', entry: process.argv[1] ?? 'sps' };
}

export interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export async function spawnCliSync(
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number },
): Promise<CliResult> {
  const { node, entry } = cliEntry();
  return new Promise((resolve) => {
    const child = spawn(node, [entry, ...args], {
      cwd: opts?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = opts?.timeoutMs
      ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs)
      : null;

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, stdout, stderr });
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ exitCode: -1, stdout, stderr: stderr + String(err) });
    });
  });
}

/**
 * 后台长任务：spawn detach + pipe 到 log file
 * 适合 sps tick / sps agent 这类生命周期持续的命令
 */
export function spawnCliDetached(
  args: string[],
  opts: { logPath: string; cwd?: string },
): ChildProcess {
  const { node, entry } = cliEntry();
  const logFd = openSync(opts.logPath, 'a');
  const child = spawn(node, [entry, ...args], {
    cwd: opts.cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  // 不跟踪子进程，父退出后子继续跑
  child.unref();
  return child;
}

/**
 * 同步版（慢路径 fallback）：阻塞，较重的操作别用
 */
export function spawnCliBlocking(args: string[], cwd?: string): string {
  const { node, entry } = cliEntry();
  return execFileSync(node, [entry, ...args], { cwd, encoding: 'utf-8' });
}
