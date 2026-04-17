/**
 * @module        reset
 * @description   重置命令，清理卡片状态、Worker 和 worktree 以便重新执行
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-30
 * @updated       2026-04-03
 *
 * @role          command
 * @layer         command
 * @boundedContext system
 *
 * @trigger       sps reset <project> [--all] [--card N]
 * @inputs        项目名、--all/--card 标志
 * @outputs       重置操作摘要
 * @workflow      1. 停止 tick 进程 → 2. 清理 state.json → 3. 删除 worktree 和分支 → 4. 卡片回退到 Planning
 */
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadProjectConf } from '../core/config.js';
import { Logger } from '../core/logger.js';
import { createIdleWorkerSlot, readState, writeState } from '../core/state.js';
import { createTaskBackend } from '../providers/registry.js';

const HOME = process.env.HOME || '/home/coral';

// ─── Helpers ──────────────────────────────────────────────────────

import { isProcessAlive as isPidAlive } from '../providers/outputParser.js';

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
  const _repoDir = config.PROJECT_DIR || resolve(HOME, 'projects', project);
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

  // ── Step 3: Move cards to Planning ──────────────────────────────
  log.info('Step 3: Moving cards to Planning...');
  const taskBackend = createTaskBackend(config);
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

      // Clean auxiliary labels (best effort)
      const auxLabels = ['STALE-RUNTIME', 'NEEDS-FIX', 'BLOCKED', 'CLAIMED', 'CONFLICT', 'WAITING-CONFIRMATION'];
      // Also clean all COMPLETED-<stage> labels so the card genuinely starts over
      const completedLabels = card.labels.filter(l => l.startsWith('COMPLETED-'));
      for (const label of [...auxLabels, ...completedLabels]) {
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

  // ── Step 4: Report ──────────────────────────────────────────────
  console.error('');
  log.ok(`Reset complete for ${project}:`);
  log.info(`  Cards reset:     ${targetSeqs.size}`);
  log.info(`  Workers killed:  ${killedWorkers}`);
  log.info(`  Leases cleared:  ${clearedLeases}`);
  log.info(`  Cards → Planning:  ${movedCards}`);
  console.error('');
  log.info(`Run: sps tick ${project}`);
}
