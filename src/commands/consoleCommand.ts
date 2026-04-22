/**
 * @module        consoleCommand
 * @description   `sps console` —— 启动 Console server + 打开浏览器
 *
 * @role          command
 * @layer         command
 * @boundedContext console
 *
 * @trigger       sps console [--port <n>] [--host <h>] [--no-open] [--dev] [--kill]
 *
 * 单实例保证：~/.coral/console.lock 记录 pid + port。
 *   已有实例 → 打印 URL 并退出（或 --kill 清理 stale）
 *   无实例   → acquire lock, 启 server, open browser, 注册 SIGTERM/SIGINT cleanup
 */
import { createRequire } from 'node:module';
import { Logger } from '../core/logger.js';
import { startConsoleServer } from '../console-server/index.js';
import {
  acquireLock,
  detectRunningConsole,
  releaseLock,
} from '../console-server/lib/lockFile.js';
import { pickPort } from '../console-server/lib/portPicker.js';

const DEFAULT_PORT = 4311;
const _require = createRequire(import.meta.url);
const VERSION: string = (_require('../../package.json') as { version: string }).version;

export async function executeConsole(flags: Record<string, unknown>): Promise<void> {
  const log = new Logger('console', '');

  // --kill: 清理 stale lock 并退出
  if (flags.kill) {
    const running = detectRunningConsole();
    if (running) {
      log.warn(`Killing running console (pid ${running.pid}, port ${running.port})...`);
      try {
        process.kill(running.pid, 'SIGTERM');
        // 给 2 秒优雅退出
        await new Promise((r) => setTimeout(r, 2000));
      } catch {
        /* 进程已死 */
      }
    }
    releaseLock();
    log.ok('Lock cleaned');
    return;
  }

  // 检查已有实例
  const existing = detectRunningConsole();
  if (existing) {
    log.info(`SPS Console already running: http://localhost:${existing.port}`);
    log.info(`  pid ${existing.pid} · started ${existing.startedAt}`);
    log.info(`  run \`sps console --kill\` to stop it`);
    return;
  }

  // 解析 flags
  const dev = flags.dev === true;
  const noOpen = flags['no-open'] === true;
  const flagHost = typeof flags.host === 'string' ? (flags.host as string) : '127.0.0.1';
  const flagPort = typeof flags.port === 'string'
    ? Number.parseInt(flags.port as string, 10)
    : flags.port === true
      ? DEFAULT_PORT
      : DEFAULT_PORT;

  // 选端口
  let port: number;
  try {
    port = await pickPort(flagPort, 10, flagHost);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  // 启 server
  let handle;
  try {
    handle = await startConsoleServer({
      port,
      host: flagHost,
      dev,
      version: VERSION,
      log,
    });
  } catch (err) {
    log.error(`Failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  // acquire lock
  acquireLock(process.pid, port, VERSION);

  // 优雅退出：
  //   - 首次 signal → 尝试优雅关闭，3 秒内没关完就强退
  //   - 第二次 signal → 立即强退（130）
  let shutdownCalled = false;
  let sigintCount = 0;
  const FORCE_TIMEOUT_MS = 3000;

  const shutdown = async (signal: string): Promise<void> => {
    if (shutdownCalled) return;
    shutdownCalled = true;
    log.info(`\nReceived ${signal}, shutting down... (press Ctrl+C again to force)`);
    const forceTimer = setTimeout(() => {
      log.warn(`Shutdown timeout (${FORCE_TIMEOUT_MS}ms), forcing exit`);
      releaseLock();
      process.exit(1);
    }, FORCE_TIMEOUT_MS);
    try {
      await handle.close();
    } catch (err) {
      log.warn(`Error during shutdown: ${err instanceof Error ? err.message : String(err)}`);
    }
    clearTimeout(forceTimer);
    releaseLock();
    process.exit(0);
  };

  process.on('SIGINT', () => {
    sigintCount++;
    if (sigintCount === 1) {
      void shutdown('SIGINT');
    } else {
      log.warn('Force exit');
      releaseLock();
      process.exit(130);
    }
  });
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // 打印 banner
  const url = `http://localhost:${port}`;
  console.log('');
  console.log('  ┌───────────────────────────────────────────────┐');
  console.log('  │  SPS Console is ready                          │');
  console.log('  │                                                │');
  console.log(`  │  Local:   ${url.padEnd(36)} │`);
  console.log(`  │  Version: ${VERSION.padEnd(36)} │`);
  console.log(`  │  Mode:    ${(dev ? 'dev (vite proxy)' : 'prod').padEnd(36)} │`);
  console.log('  │                                                │');
  console.log('  │  Press Ctrl+C to stop.                         │');
  console.log('  └───────────────────────────────────────────────┘');
  console.log('');

  // 打开浏览器
  if (!noOpen) {
    try {
      const openMod = await import('open');
      await openMod.default(url);
    } catch (err) {
      log.info(`(could not auto-open browser: ${err instanceof Error ? err.message : String(err)})`);
      log.info(`  open manually: ${url}`);
    }
  }

  // 保持进程活
  await new Promise<void>(() => {
    /* block forever until SIGINT */
  });
}
