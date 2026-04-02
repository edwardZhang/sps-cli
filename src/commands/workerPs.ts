import { ProjectContext } from '../core/context.js';
import { readState, writeState, createIdleWorkerSlot } from '../core/state.js';
import { Logger } from '../core/logger.js';

/**
 * sps worker ps <project>
 * List all worker sessions with their status, seq, pid, runtime.
 */
export async function executeWorkerPs(
  project: string,
  flags: Record<string, boolean>,
): Promise<void> {
  const log = new Logger('worker-ps', project);
  const jsonOutput = !!flags.json;

  let ctx: ProjectContext;
  try {
    ctx = ProjectContext.load(project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Fatal: ${msg}`);
    process.exit(3);
  }

  const state = readState(ctx.paths.stateFile, ctx.maxWorkers);
  const now = Date.now();

  interface WorkerInfo {
    slot: string;
    status: string;
    seq: number | null;
    pid: number | null;
    alive: boolean;
    phase: string | null;
    runtime: string;
    claimedAt: string | null;
    transport: string | null;
    agent: string | null;
  }

  const workers: WorkerInfo[] = [];

  for (const [slotName, slotState] of Object.entries(state.workers)) {
    const pid = slotState.pid ?? null;
    let alive = false;
    if (pid) {
      try { process.kill(pid, 0); alive = true; } catch { /* dead */ }
    }

    // Find lease for this worker
    let leasePhase: string | null = null;
    let leaseSeq: number | null = slotState.seq;
    if (leaseSeq != null) {
      const lease = state.leases[String(leaseSeq)];
      if (lease) leasePhase = lease.phase;
    }

    // Compute runtime
    const claimedAt = slotState.claimedAt;
    let runtime = '-';
    if (claimedAt && slotState.status !== 'idle') {
      const elapsed = now - new Date(claimedAt).getTime();
      const mins = Math.floor(elapsed / 60000);
      const secs = Math.floor((elapsed % 60000) / 1000);
      runtime = mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
    }

    workers.push({
      slot: slotName,
      status: slotState.status,
      seq: leaseSeq,
      pid,
      alive,
      phase: leasePhase,
      runtime,
      claimedAt,
      transport: slotState.transport ?? slotState.mode ?? null,
      agent: slotState.agent ?? null,
    });
  }

  // Also check ACP sessions
  for (const [slotName, session] of Object.entries(state.sessions ?? {})) {
    const existing = workers.find(w => w.slot === slotName);
    if (!existing) continue;

    if (session.pid && !existing.pid) {
      existing.pid = session.pid;
    }
    // Check if session process is actually alive
    if (existing.pid) {
      try { process.kill(existing.pid, 0); existing.alive = true; } catch { existing.alive = false; }
    }
    // Only show session status if process is alive
    if (existing.alive && session.status && existing.status === 'idle'
        && session.status !== 'idle' && session.status !== 'offline') {
      existing.status = `session:${session.status}`;
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(workers, null, 2));
    return;
  }

  // Table output
  const hasActive = workers.some(w => w.status !== 'idle');
  if (!hasActive) {
    console.log(`  ${project}: all ${workers.length} workers idle`);
    return;
  }

  console.log('');
  console.log(`  ${project} — Worker Processes`);
  console.log('');
  console.log('  Slot        Status     Seq    PID       Alive  Phase       Runtime  Agent');
  console.log('  ' + '─'.repeat(78));

  for (const w of workers) {
    const status = w.status.padEnd(10);
    const seq = w.seq != null ? String(w.seq).padEnd(6) : '-'.padEnd(6);
    const pid = w.pid ? String(w.pid).padEnd(9) : '-'.padEnd(9);
    const alive = w.alive ? '✓' : '✗';
    const phase = (w.phase ?? '-').padEnd(11);
    const runtime = w.runtime.padEnd(8);
    const agent = w.agent ?? '-';
    console.log(`  ${w.slot.padEnd(11)} ${status} ${seq} ${pid} ${alive.padEnd(6)} ${phase} ${runtime} ${agent}`);
  }
  console.log('');
}

/**
 * sps worker kill <project> <seq>
 * Kill a specific worker by task seq.
 */
export async function executeWorkerKill(
  project: string,
  seq: string,
  flags: Record<string, boolean>,
): Promise<void> {
  const log = new Logger('worker-kill', project);

  if (!seq) {
    console.error('Usage: sps worker kill <project> <seq>');
    process.exit(2);
  }

  let ctx: ProjectContext;
  try {
    ctx = ProjectContext.load(project);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Fatal: ${msg}`);
    process.exit(3);
  }

  const state = readState(ctx.paths.stateFile, ctx.maxWorkers);

  // Find the worker slot for this seq
  const slotEntry = Object.entries(state.workers).find(
    ([, w]) => w.seq === parseInt(seq, 10) && w.status !== 'idle',
  );

  if (!slotEntry) {
    // Check ACP sessions
    const sessionEntry = Object.entries(state.sessions ?? {}).find(([, s]) => {
      const lease = Object.entries(state.leases).find(([lSeq]) => lSeq === seq);
      return lease && s.pid;
    });

    if (!sessionEntry) {
      console.error(`No active worker found for seq:${seq}`);
      process.exit(1);
    }
  }

  // Collect PIDs to kill
  const pidsToKill: number[] = [];

  // From worker slot
  if (slotEntry) {
    const [, slotState] = slotEntry;
    if (slotState.pid) pidsToKill.push(slotState.pid);
  }

  // From ACP session
  for (const [slotName, session] of Object.entries(state.sessions ?? {})) {
    const slotWorker = state.workers[slotName];
    if (slotWorker?.seq === parseInt(seq, 10) && session.pid) {
      if (!pidsToKill.includes(session.pid)) pidsToKill.push(session.pid);
    }
  }

  if (pidsToKill.length === 0) {
    console.error(`No PID found for seq:${seq}`);
    process.exit(1);
  }

  for (const pid of pidsToKill) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`  Sent SIGTERM to pid ${pid} (seq:${seq})`);
    } catch {
      console.log(`  pid ${pid} already dead`);
    }
  }

  // Wait briefly then check
  await new Promise(r => setTimeout(r, 2000));

  for (const pid of pidsToKill) {
    try {
      process.kill(pid, 0);
      // Still alive — force kill
      process.kill(pid, 'SIGKILL');
      console.log(`  Force killed pid ${pid} (SIGKILL)`);
    } catch {
      // Dead — good
    }
  }

  // Clean up state.json: reset slot to idle, remove lease and activeCard
  const freshState = readState(ctx.paths.stateFile, ctx.maxWorkers);
  let cleaned = false;

  for (const [slotName, w] of Object.entries(freshState.workers)) {
    if (w.seq === parseInt(seq, 10) && w.status !== 'idle') {
      freshState.workers[slotName] = createIdleWorkerSlot();
      cleaned = true;
    }
  }
  delete freshState.activeCards[seq];
  // Clean up ACP session for this slot
  for (const [slotName, w] of Object.entries(freshState.workers)) {
    if (w.seq === parseInt(seq, 10) || (slotEntry && slotEntry[0] === slotName)) {
      const session = freshState.sessions?.[slotName];
      if (session) {
        session.status = 'offline' as any;
        session.currentRun = null;
      }
    }
  }
  if (freshState.leases[seq]) {
    freshState.leases[seq].phase = 'suspended';
    freshState.leases[seq].slot = null;
    freshState.leases[seq].sessionId = null;
    freshState.leases[seq].runId = null;
    freshState.leases[seq].lastTransitionAt = new Date().toISOString();
    cleaned = true;
  }

  if (cleaned) {
    writeState(ctx.paths.stateFile, freshState, 'worker-kill');
  }

  console.log(`  Worker seq:${seq} killed`);
}
