/**
 * sps stop — Stop a running tick process for one or all projects.
 *
 * Usage:
 *   sps stop <project>       # stop tick for a specific project
 *   sps stop --all           # stop ticks for all projects
 */
import { existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '../core/logger.js';

const HOME = process.env.HOME || '/home/coral';

interface LockInfo {
  pid: number;
  startedAt: string;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function discoverProjects(): string[] {
  const projectsDir = resolve(HOME, '.coral', 'projects');
  if (!existsSync(projectsDir)) return [];
  try {
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(resolve(projectsDir, d.name, 'conf')))
      .map(d => d.name)
      .sort();
  } catch {
    return [];
  }
}

function stopProject(project: string, log: Logger): boolean {
  const lockFile = resolve(HOME, '.coral', 'projects', project, 'runtime', 'tick.lock');

  if (!existsSync(lockFile)) {
    log.info(`No running tick for ${project}`);
    return false;
  }

  let lock: LockInfo;
  try {
    lock = JSON.parse(readFileSync(lockFile, 'utf-8'));
  } catch {
    log.warn(`Corrupt lock file for ${project}, removing`);
    try { unlinkSync(lockFile); } catch { /* ignore */ }
    return false;
  }

  if (!isPidAlive(lock.pid)) {
    log.warn(`Stale lock for ${project} (pid ${lock.pid} is dead), cleaning up`);
    try { unlinkSync(lockFile); } catch { /* ignore */ }
    return false;
  }

  // Kill the process tree: SIGTERM first, then SIGKILL if needed
  const startedAt = lock.startedAt;
  log.info(`Stopping ${project} tick (pid ${lock.pid}, started ${startedAt})`);

  try {
    // Send SIGTERM to the process group (negative PID) to kill child workers too
    try {
      process.kill(-lock.pid, 'SIGTERM');
    } catch {
      // Process group kill may fail; fall back to direct kill
      process.kill(lock.pid, 'SIGTERM');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Failed to send SIGTERM to pid ${lock.pid}: ${msg}`);
    return false;
  }

  // Wait briefly, then force kill if still alive
  let killed = false;
  for (let i = 0; i < 10; i++) {
    if (!isPidAlive(lock.pid)) {
      killed = true;
      break;
    }
    // Busy-wait ~200ms
    const start = Date.now();
    while (Date.now() - start < 200) { /* spin */ }
  }

  if (!killed) {
    log.warn(`pid ${lock.pid} still alive after SIGTERM, sending SIGKILL`);
    try {
      try { process.kill(-lock.pid, 'SIGKILL'); } catch { process.kill(lock.pid, 'SIGKILL'); }
    } catch { /* best effort */ }
  }

  // Clean up lock file
  try { unlinkSync(lockFile); } catch { /* ignore */ }

  log.ok(`Stopped ${project} tick (pid ${lock.pid})`);
  return true;
}

export async function executeStop(
  projects: string[],
  flags: Record<string, boolean>,
): Promise<void> {
  const log = new Logger('stop', '');

  if (flags.all) {
    projects = discoverProjects();
  }

  if (projects.length === 0) {
    console.error('Usage: sps stop <project> [--all]');
    process.exit(2);
  }

  let stopped = 0;
  for (const project of projects) {
    const projectLog = new Logger('stop', project);
    if (stopProject(project, projectLog)) {
      stopped++;
    }
  }

  if (stopped === 0) {
    log.info('No running ticks found');
  } else {
    log.ok(`Stopped ${stopped} tick(s)`);
  }
}
