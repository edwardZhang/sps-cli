/**
 * @module        test/e2e/helpers/cliRunner
 * @description   Phase 0 characterization 用：spawn sps CLI 进程，捕获 stdout/stderr/exit
 *
 * 用 tsx 直接跑 src/main.ts（避免每次重编译 dist）。
 * 也暴露直接调命令函数的 runCommand —— 不 spawn，更快，单测隔离更好。
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SRC_ROOT = resolve(__dirname, '..', '..', '..', 'src');
const MAIN_ENTRY = resolve(SRC_ROOT, 'main.ts');

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CliRunOpts {
  /** 自定义 HOME，用于隔离 */
  home: string;
  /** 超时毫秒，默认 10s */
  timeoutMs?: number;
  /** cwd */
  cwd?: string;
}

/**
 * spawn `tsx src/main.ts <args>`，返回完整结果。
 * 用于 CLI E2E —— 验证用户真正会看到的 stdout/stderr/exit 行为。
 */
export async function runCli(args: string[], opts: CliRunOpts): Promise<CliResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(
      process.execPath,
      [resolve(SRC_ROOT, '..', 'node_modules', '.bin', 'tsx'), MAIN_ENTRY, ...args],
      {
        cwd: opts.cwd,
        env: { ...process.env, HOME: opts.home, FORCE_COLOR: '0', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs ?? 10_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolvePromise({ exitCode: -1, stdout, stderr: stderr + String(err) });
    });
  });
}

/**
 * 过滤 ANSI 色码，便于 assert。
 */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}
