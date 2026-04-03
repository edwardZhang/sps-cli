/**
 * Daemon control commands for `sps agent daemon start/stop/status`.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DaemonClient, getDaemonSocketPath } from '../daemon/daemonClient.js';

const DIM = '\x1b[90m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

const HOME = process.env.HOME || '/home/coral';
const PID_FILE = resolve(HOME, '.coral', 'sessions', 'daemon.pid');

export async function executeDaemonCommand(subcommand: string): Promise<void> {
  switch (subcommand) {
    case 'start':
      await daemonStart();
      break;
    case 'stop':
      await daemonStop();
      break;
    case 'status':
      await daemonStatus();
      break;
    default:
      console.error('Usage: sps agent daemon <start|stop|status>');
      process.exit(2);
  }
}

async function daemonStart(): Promise<void> {
  const client = new DaemonClient();
  if (await client.isRunning()) {
    console.log(`${DIM}Daemon already running${RESET}`);
    return;
  }

  // Find the compiled daemon entry point
  const daemonScript = resolve(
    import.meta.url.replace('file://', '').replace(/\/commands\/agentDaemon\.js$/, ''),
    'daemon', 'sessionDaemon.js',
  );

  if (!existsSync(daemonScript)) {
    console.error(`${RED}Daemon script not found: ${daemonScript}${RESET}`);
    process.exit(1);
  }

  // Spawn daemon as detached background process
  const logFile = resolve(HOME, '.coral', 'sessions', 'logs', 'daemon.log');
  const out = await import('node:fs').then(fs => fs.openSync(logFile, 'a'));
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env },
  });
  child.unref();

  // Wait for daemon to be reachable
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await client.isRunning()) {
      console.log(`${GREEN}Daemon started (pid ${child.pid})${RESET}`);
      return;
    }
  }

  console.error(`${RED}Daemon failed to start within 10s${RESET}`);
  process.exit(1);
}

async function daemonStop(): Promise<void> {
  const client = new DaemonClient();
  if (!(await client.isRunning())) {
    console.log(`${DIM}Daemon not running${RESET}`);
    return;
  }

  await client.shutdown();

  // Wait for daemon to exit
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (!(await client.isRunning())) {
      console.log(`${GREEN}Daemon stopped${RESET}`);
      return;
    }
  }

  // Force kill via PID file
  if (existsSync(PID_FILE)) {
    try {
      const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
      process.kill(pid, 'SIGKILL');
      console.log(`${GREEN}Daemon killed (pid ${pid})${RESET}`);
    } catch { /* already dead */ }
  }
}

async function daemonStatus(): Promise<void> {
  const client = new DaemonClient();
  if (await client.isRunning()) {
    let pidInfo = '';
    if (existsSync(PID_FILE)) {
      pidInfo = ` (pid ${readFileSync(PID_FILE, 'utf-8').trim()})`;
    }
    console.log(`${GREEN}Daemon running${pidInfo}${RESET}`);

    // Show sessions
    try {
      const state = await client.inspect();
      const sessions = Object.entries(state.sessions ?? {});
      if (sessions.length > 0) {
        console.log(`\n  Sessions:`);
        for (const [name, session] of sessions) {
          const run = session.currentRun;
          const info = run ? `${run.status}` : 'idle';
          console.log(`    ${name} — ${session.tool} — ${info}`);
        }
      }
    } catch { /* noop */ }
  } else {
    console.log(`${DIM}Daemon not running${RESET}`);
  }
}

/** Ensure daemon is running, start if not. Returns true if daemon is available. */
export async function ensureDaemon(): Promise<boolean> {
  const client = new DaemonClient();
  if (await client.isRunning()) return true;

  process.stderr.write(`${DIM}Starting daemon...${RESET}\n`);
  await daemonStart();
  return await client.isRunning();
}
