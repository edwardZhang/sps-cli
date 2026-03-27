/**
 * sps status — Show running status of all SPS projects.
 *
 * Usage:
 *   sps status           # list all projects with tick/worker status
 *   sps status --json    # JSON output
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProjectConf } from '../core/config.js';
import { readACPState } from '../core/acpState.js';
import { readState } from '../core/state.js';
import { isProcessAlive } from '../core/sessionLiveness.js';
import { summarizeWorkerRuntime } from '../core/workerRuntimeSummary.js';
import { loadRuntimeSnapshot } from '../core/runtimeSnapshot.js';

const HOME = process.env.HOME || '/home/coral';
const PROJECTS_DIR = resolve(HOME, '.coral', 'projects');

interface LockInfo {
  pid: number;
  startedAt: string;
}

interface ProjectStatus {
  project: string;
  tick: 'running' | 'stopped' | 'stale-lock';
  pid: number | null;
  startedAt: string | null;
  workers: { total: number; active: number; idle: number; stale: number; merging: number; working: number };
  activeCards: number;
  pipelineQueue: number;
}

async function getProjectStatus(project: string): Promise<ProjectStatus> {
  const projectDir = resolve(PROJECTS_DIR, project);
  const lockFile = resolve(projectDir, 'runtime', 'tick.lock');
  const stateFile = resolve(projectDir, 'runtime', 'state.json');
  const acpStateFile = resolve(projectDir, 'runtime', 'acp-state.json');
  const pipelineFile = resolve(projectDir, 'pipeline_order.json');

  // Tick status
  let tick: ProjectStatus['tick'] = 'stopped';
  let pid: number | null = null;
  let startedAt: string | null = null;

  if (existsSync(lockFile)) {
    try {
      const lock: LockInfo = JSON.parse(readFileSync(lockFile, 'utf-8'));
      pid = lock.pid;
      startedAt = lock.startedAt;
      tick = isProcessAlive(lock.pid) ? 'running' : 'stale-lock';
    } catch {
      tick = 'stale-lock';
    }
  }

  // Worker status — verify PIDs are actually alive
  let workers = { total: 0, active: 0, idle: 0, stale: 0, merging: 0, working: 0 };
  let activeCards = 0;
  try {
    const snapshot = await loadRuntimeSnapshot(project);
    workers = summarizeWorkerRuntime(snapshot.state, snapshot.acpState);
    activeCards = Object.keys(snapshot.state.activeCards).length;
  } catch {
    if (existsSync(stateFile)) {
      try {
        const maxWorkers = loadProjectConf(project).MAX_CONCURRENT_WORKERS;
        const state = readState(stateFile, maxWorkers);
        const acpState = readACPState(acpStateFile);
        workers = summarizeWorkerRuntime(state, acpState);
        activeCards = Object.keys(state.activeCards).length;
      } catch { /* corrupt state */ }
    }
  }

  // Pipeline queue
  let pipelineQueue = 0;
  if (existsSync(pipelineFile)) {
    try {
      const queue = JSON.parse(readFileSync(pipelineFile, 'utf-8'));
      pipelineQueue = Array.isArray(queue) ? queue.length : 0;
    } catch { /* corrupt */ }
  }

  return { project, tick, pid, startedAt, workers, activeCards, pipelineQueue };
}

export async function executeStatus(flags: Record<string, boolean>): Promise<void> {
  if (!existsSync(PROJECTS_DIR)) {
    console.error('No projects found. Run: sps setup && sps project init <name>');
    process.exit(1);
  }

  const projects = readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(resolve(PROJECTS_DIR, d.name, 'conf')))
    .map(d => d.name)
    .sort();

  if (projects.length === 0) {
    console.error('No projects found. Run: sps project init <name>');
    process.exit(1);
  }

  const statuses = await Promise.all(projects.map(getProjectStatus));

  if (flags.json) {
    console.log(JSON.stringify(statuses, null, 2));
    return;
  }

  // Table output
  const running = statuses.filter(s => s.tick === 'running').length;
  const total = statuses.length;

  console.log(`\n  SPS Status — ${running}/${total} projects running\n`);
  console.log(
    '  ' +
    'Project'.padEnd(22) +
    'Tick'.padEnd(14) +
    'PID'.padEnd(10) +
    'Workers'.padEnd(14) +
    'Cards'.padEnd(8) +
    'Queue'.padEnd(8) +
    'Started'
  );
  console.log('  ' + '─'.repeat(90));

  for (const s of statuses) {
    const tickIcon =
      s.tick === 'running' ? '\x1b[32m● running\x1b[0m' :
      s.tick === 'stale-lock' ? '\x1b[33m⚠ stale\x1b[0m' :
      '\x1b[90m○ stopped\x1b[0m';

    const pidStr = s.pid ? String(s.pid) : '—';
    const workersStr = s.workers.total > 0
      ? s.workers.merging > 0
        ? `${s.workers.active} active, ${s.workers.merging} merging`
        : s.workers.stale > 0
          ? `${s.workers.active} active, ${s.workers.stale} stale`
          : `${s.workers.active}/${s.workers.total} active`
      : '—';
    const cardsStr = s.activeCards > 0 ? String(s.activeCards) : '—';
    const queueStr = s.pipelineQueue > 0 ? String(s.pipelineQueue) : '—';
    const startedStr = s.startedAt
      ? new Date(s.startedAt).toLocaleString('zh-CN', { hour12: false })
      : '—';

    // Use raw string length for padding (strip ANSI codes for alignment)
    const tickPadded = tickIcon + ' '.repeat(Math.max(0, 14 - s.tick.length - 2));

    console.log(
      '  ' +
      s.project.padEnd(22) +
      tickPadded +
      pidStr.padEnd(10) +
      workersStr.padEnd(14) +
      cardsStr.padEnd(8) +
      queueStr.padEnd(8) +
      startedStr
    );
  }

  console.log();
}
