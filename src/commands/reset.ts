/**
 * sps reset — Reset cards for re-execution.
 *
 * Usage:
 *   sps reset <project>              # reset all non-Done cards
 *   sps reset <project> --all        # reset ALL cards including Done
 *   sps reset <project> --card 5     # reset specific card(s)
 *   sps reset <project> --card 5,6,7
 *
 * Each reset performs 5 steps:
 *   1. Stop tick (kill process, remove lock)
 *   2. Clean state.json (leases, activeCards, worker slots, queues)
 *   3. Remove worktrees + git branches
 *   4. Move cards back to Planning
 *   5. Report summary
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProjectConf } from '../core/config.js';
import { Logger } from '../core/logger.js';
import { resolveWorktreePath } from '../core/paths.js';
import { createIdleWorkerSlot, readState, writeState } from '../core/state.js';
import { createTaskBackend } from '../providers/registry.js';

const HOME = process.env.HOME || '/home/coral';

// ─── Helpers ──────────────────────────────────────────────────────

function isPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function stopTick(project: string, log: Logger): void {
  const lockFile = resolve(HOME, '.coral', 'projects', project, 'runtime', 'tick.lock');
  if (!existsSync(lockFile)) return;

  try {
    const lock = JSON.parse(readFileSync(lockFile, 'utf-8'));
    if (isPidAlive(lock.pid)) {
      log.info(`Stopping tick (pid ${lock.pid})`);
      try { process.kill(-lock.pid, 'SIGTERM'); } catch {
        try { process.kill(lock.pid, 'SIGTERM'); } catch { /* ignore */ }
      }
      // Wait up to 3 seconds for graceful shutdown
      for (let i = 0; i < 15; i++) {
        if (!isPidAlive(lock.pid)) break;
        const start = Date.now();
        while (Date.now() - start < 200) { /* spin */ }
      }
      if (isPidAlive(lock.pid)) {
        try { process.kill(-lock.pid, 'SIGKILL'); } catch {
          try { process.kill(lock.pid, 'SIGKILL'); } catch { /* ignore */ }
        }
      }
      log.ok('Tick stopped');
    }
  } catch { /* corrupt lock */ }

  try { unlinkSync(lockFile); } catch { /* ignore */ }
}

function killWorkerPid(pid: number): void {
  if (!pid || pid <= 0) return;
  if (!isPidAlive(pid)) return;
  try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
  // Brief wait
  for (let i = 0; i < 5; i++) {
    if (!isPidAlive(pid)) return;
    const start = Date.now();
    while (Date.now() - start < 200) { /* spin */ }
  }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
}

function removeWorktreeAndBranch(
  repoDir: string, worktreePath: string, branch: string, log: Logger,
): void {
  // Remove worktree
  if (existsSync(worktreePath)) {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: repoDir, timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      rmSync(worktreePath, { recursive: true, force: true });
      try {
        execFileSync('git', ['worktree', 'prune'], {
          cwd: repoDir, timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch { /* non-fatal */ }
    }
    log.ok(`Removed worktree: ${worktreePath}`);
  }

  // Delete local branch (force — may not be merged)
  try {
    execFileSync('git', ['branch', '-D', branch], {
      cwd: repoDir, timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    log.ok(`Deleted branch: ${branch}`);
  } catch { /* branch may not exist */ }

  // Delete remote branch (best effort)
  try {
    execFileSync('git', ['push', 'origin', '--delete', branch], {
      cwd: repoDir, timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    log.debug(`Deleted remote branch: ${branch}`);
  } catch { /* remote branch may not exist */ }
}

function buildBranchName(cardName: string, seq: string): string {
  const slug = cardName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `feature/${seq}-${slug}`;
}

// ─── Main ─────────────────────────────────────────────────────────

export async function executeReset(
  project: string,
  flags: Record<string, boolean>,
  cardArg?: string,
): Promise<void> {
  const log = new Logger('reset', project);

  // Load config
  let config;
  try {
    config = loadProjectConf(project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`Cannot load project: ${msg}`);
    process.exit(1);
  }

  const stateFile = resolve(HOME, '.coral', 'projects', project, 'runtime', 'state.json');
  const repoDir = config.PROJECT_DIR || resolve(HOME, 'projects', project);
  const maxWorkers = config.MAX_CONCURRENT_WORKERS;

  // Determine which seqs to reset
  let targetSeqs: Set<string>;

  if (cardArg) {
    // --card 5 or --card 5,6,7
    targetSeqs = new Set(cardArg.split(',').map(s => s.trim()).filter(Boolean));
    log.info(`Resetting cards: ${[...targetSeqs].join(', ')}`);
  } else {
    // Discover all cards from PM backend
    const taskBackend = createTaskBackend(config);
    const allCards = await taskBackend.listAll();

    if (flags.all) {
      targetSeqs = new Set(allCards.map(c => c.seq));
      log.info(`Resetting ALL ${targetSeqs.size} cards`);
    } else {
      // Only non-Done cards
      const nonDone = allCards.filter(c => c.state !== 'Done');
      targetSeqs = new Set(nonDone.map(c => c.seq));
      if (targetSeqs.size === 0) {
        log.info('All cards are Done — nothing to reset');
        return;
      }
      log.info(`Resetting ${targetSeqs.size} non-Done card(s)`);
    }
  }

  // ── Step 1: Stop tick ───────────────────────────────────────────
  log.info('Step 1: Stopping tick...');
  stopTick(project, log);

  // ── Step 2: Clean state.json ────────────────────────────────────
  log.info('Step 2: Cleaning state...');
  const state = readState(stateFile, maxWorkers);
  let killedWorkers = 0;

  // Kill active worker processes for target seqs
  for (const [slotName, worker] of Object.entries(state.workers)) {
    if (worker.seq !== null && targetSeqs.has(String(worker.seq))) {
      if (worker.pid && worker.pid > 0) {
        killWorkerPid(worker.pid);
        killedWorkers++;
      }
      state.workers[slotName] = createIdleWorkerSlot();
    }
  }

  // Clear leases and activeCards for target seqs
  let clearedLeases = 0;
  for (const seq of targetSeqs) {
    if (state.leases[seq]) { delete state.leases[seq]; clearedLeases++; }
    if (state.activeCards[seq]) delete state.activeCards[seq];
  }

  // Clear integration queue entries for target seqs
  for (const [key, q] of Object.entries(state.integrationQueues)) {
    if (q.active && targetSeqs.has(q.active.taskId)) {
      q.active = null;
    }
    q.waiting = q.waiting.filter(e => !targetSeqs.has(e.taskId));
    if (!q.active && q.waiting.length === 0) {
      delete state.integrationQueues[key];
    }
  }

  // Clear worktreeCleanup entries for target seqs
  state.worktreeCleanup = (state.worktreeCleanup ?? []).filter(
    e => !targetSeqs.has(e.branch.replace(/^feature\/(\d+)-.*$/, '$1')),
  );

  // Clear pendingPMActions for target seqs
  state.pendingPMActions = (state.pendingPMActions ?? []).filter(
    a => !targetSeqs.has(a.taskId),
  );

  // Clear ACP sessions — prevents stale run IDs from blocking new workers
  if (state.sessions) {
    state.sessions = {};
  }

  writeState(stateFile, state, 'reset');
  log.ok(`Cleaned state: ${clearedLeases} lease(s), ${killedWorkers} worker(s) killed`);

  // ── Step 3: Remove worktrees + branches ─────────────────────────
  log.info('Step 3: Cleaning worktrees and branches...');
  const taskBackend = createTaskBackend(config);
  let cleanedWorktrees = 0;

  for (const seq of targetSeqs) {
    const worktreePath = resolveWorktreePath(project, seq, config.WORKTREE_DIR);
    const card = await taskBackend.getBySeq(seq);
    const branchName = card
      ? buildBranchName(card.name, seq)
      : `feature/${seq}-unknown`;

    if (existsSync(worktreePath) || existsSync(repoDir)) {
      removeWorktreeAndBranch(repoDir, worktreePath, branchName, log);
      cleanedWorktrees++;
    }
  }

  // Prune once at the end
  try {
    execFileSync('git', ['worktree', 'prune'], {
      cwd: repoDir, timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch { /* non-fatal */ }

  log.ok(`Cleaned ${cleanedWorktrees} worktree(s)`);

  // ── Step 4: Move cards to Planning ──────────────────────────────
  log.info('Step 4: Moving cards to Planning...');
  let movedCards = 0;

  for (const seq of targetSeqs) {
    try {
      const card = await taskBackend.getBySeq(seq);
      if (!card) {
        log.debug(`seq ${seq}: card not found, skipping`);
        continue;
      }
      if (card.state === 'Planning') {
        log.debug(`seq ${seq}: already in Planning`);
        continue;
      }

      await taskBackend.move(seq, 'Planning');

      // Clean labels (best effort)
      for (const label of ['STALE-RUNTIME', 'NEEDS-FIX', 'BLOCKED', 'CLAIMED', 'CONFLICT', 'WAITING-CONFIRMATION']) {
        if (card.labels.includes(label)) {
          try { await taskBackend.removeLabel(seq, label); } catch { /* best effort */ }
        }
      }

      movedCards++;
      log.ok(`seq ${seq}: ${card.state} → Planning`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`seq ${seq}: failed to move to Planning: ${msg}`);
    }
  }

  log.ok(`Moved ${movedCards} card(s) to Planning`);

  // ── Step 5: Report ──────────────────────────────────────────────
  console.error('');
  log.ok(`Reset complete for ${project}:`);
  log.info(`  Cards reset:     ${targetSeqs.size}`);
  log.info(`  Workers killed:  ${killedWorkers}`);
  log.info(`  Leases cleared:  ${clearedLeases}`);
  log.info(`  Worktrees removed: ${cleanedWorktrees}`);
  log.info(`  Cards → Planning:  ${movedCards}`);
  console.error('');
  log.info(`Run: sps tick ${project}`);
}
