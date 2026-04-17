/**
 * @module        sessionCleanup
 * @description   启动时清理 ACP 孤儿 session，防止 sps tick 崩溃后残留的 shim+claude 进程堆积
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-04-17
 * @updated       2026-04-17
 *
 * @role          core
 * @layer         core
 * @boundedContext session-lifecycle
 *
 * @trigger       sps tick 启动时调用一次，在 WorkerManager.recover 之前
 * @inputs        ProjectContext, Logger
 * @outputs       { cleaned: number, killed: number }
 * @workflow      读 state.sessions → 对每个 worker-* slot 检查 pid → 活则 kill → 清状态
 */
import { execFileSync } from 'node:child_process';
import { isProcessAlive, killProcessGroup } from '../providers/outputParser.js';
import type { ProjectContext } from './context.js';
import type { Logger } from './logger.js';
import { RuntimeStore } from './runtimeStore.js';

export interface OrphanCleanupResult {
  /** Number of session records removed from state.json */
  cleaned: number;
  /** Number of orphan processes killed */
  killed: number;
}

/**
 * Kill descendants of a PID using pgrep -P recursively. Best effort — ignores failures.
 * Used as a safety net after killProcessGroup, since orphan processes may no longer
 * be in their original process group (adopted by init).
 */
function killDescendantsRecursive(parentPid: number, signal: NodeJS.Signals = 'SIGTERM'): void {
  let children: number[] = [];
  try {
    const out = execFileSync('pgrep', ['-P', String(parentPid)], { encoding: 'utf-8', timeout: 2000 });
    children = out.trim().split('\n').map(n => parseInt(n, 10)).filter(n => n > 0);
  } catch {
    return;
  }
  for (const childPid of children) {
    try { process.kill(childPid, signal); } catch { /* already dead */ }
    killDescendantsRecursive(childPid, signal);
  }
}

/**
 * Scan state.json for ACP sessions on pipeline slots (worker-*). If the recorded
 * pid is still alive, kill the process (+ its descendants) — the new sps tick
 * instance cannot reattach to a stdio-connected shim, so any survivor is an
 * orphan. Clear all worker-* session records regardless of pid liveness.
 *
 * Preserves harness-mode sessions (slot prefix `session-`).
 */
export async function cleanupOrphanAcpSessions(
  ctx: ProjectContext,
  log: Logger,
): Promise<OrphanCleanupResult> {
  const store = new RuntimeStore(ctx);
  const state = store.readState();
  const sessions = state.sessions ?? {};

  const pipelineSlots: string[] = [];
  const liveOrphans: Array<{ slot: string; pid: number }> = [];

  for (const [slot, session] of Object.entries(sessions)) {
    if (!slot.startsWith('worker-')) continue;
    pipelineSlots.push(slot);
    if (session.pid && isProcessAlive(session.pid)) {
      liveOrphans.push({ slot, pid: session.pid });
    }
  }

  // Kill live orphans
  for (const { slot, pid } of liveOrphans) {
    log.warn(`Orphan ACP session detected: slot=${slot} pid=${pid} — killing`);
    try {
      // killProcessGroup handles SIGTERM → wait → SIGKILL for the process group
      await killProcessGroup(pid, 3_000);
      // Safety net: kill any remaining descendants (orphans adopted by init
      // may not be in the original process group anymore)
      killDescendantsRecursive(pid, 'SIGKILL');
    } catch (err) {
      log.error(`Failed to kill orphan pid=${pid}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Clear all pipeline session records (regardless of pid liveness).
  // The new AcpSdkAdapter has a fresh in-memory session Map and cannot
  // reattach to old stdio, so old records are all stale.
  if (pipelineSlots.length > 0) {
    store.updateState('orphan-session-cleanup', (draft) => {
      for (const slot of pipelineSlots) {
        delete draft.sessions[slot];
      }
    });
  }

  return {
    cleaned: pipelineSlots.length,
    killed: liveOrphans.length,
  };
}
