import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import type { ProjectContext } from '../core/context.js';
import { resolveWorktreePath } from '../core/paths.js';
import { RuntimeStore } from '../core/runtimeStore.js';
import {
  getPersistedRunStatus,
  hasPersistedActiveRun,
  isPersistedSessionAlive,
} from '../core/sessionLiveness.js';
import {
  createIdleWorkerSlot,
  type RuntimeState,
  type TaskLease,
  type TaskLeasePhase,
  type WorkerSlotState,
  type WorktreeEvidence,
  type WorktreeEvidenceStatus,
} from '../core/state.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import type { ACPRunStatus, ACPSessionRecord } from '../models/acp.js';
import type { Card, CardState } from '../models/types.js';
import {
  branchPushed,
  isProcessAlive as isProcAlive,
} from '../providers/outputParser.js';

const TERMINAL_RUN_STATUSES = new Set<ACPRunStatus>(['completed', 'failed', 'cancelled', 'lost']);

export interface RuntimeRebuildResult {
  state: RuntimeState;
  updated: boolean;
}

type Candidate = {
  seq: string;
  card: Card | null;
  slotName: string | null;
  slot: WorkerSlotState | null;
  session: ACPSessionRecord | null;
  branch: string | null;
  worktree: string | null;
  priorActiveStartedAt: string | null;
  priorRetryCount: number;
  priorLease: TaskLease | null;
};

export class RuntimeCoordinator {
  constructor(private readonly ctx: ProjectContext, private readonly taskBackend: TaskBackend) {}

  async buildRuntimeProjection(): Promise<RuntimeRebuildResult> {
    return this.computeRuntimeProjection(false, 'runtime-coordinator');
  }

  async rebuildRuntimeProjection(updatedBy = 'runtime-coordinator'): Promise<RuntimeRebuildResult> {
    return this.computeRuntimeProjection(true, updatedBy);
  }

  private async computeRuntimeProjection(persist: boolean, updatedBy: string): Promise<RuntimeRebuildResult> {
    const store = new RuntimeStore(this.ctx);
    const state = store.readState();
    const cards = await this.taskBackend.listAll();
    const cardsBySeq = new Map(cards.map((card) => [card.seq, card]));

    const normalizedSessions = this.normalizeSessions(state);
    const nextState = structuredClone(state) as RuntimeState;
    nextState.leases = {};
    nextState.worktreeEvidence = {};
    nextState.activeCards = {};

    const nextWorkers: Record<string, WorkerSlotState> = {};
    for (let i = 1; i <= this.ctx.maxWorkers; i++) {
      nextWorkers[`worker-${i}`] = createIdleWorkerSlot();
    }

    const seqs = this.collectCandidateSeqs(state, cards);
    const slotLookup = this.buildSlotLookup(state);

    for (const seq of seqs) {
      const card = cardsBySeq.get(seq) || null;
      const slotName = slotLookup.get(seq) ?? state.leases[seq]?.slot ?? null;
      const slot = slotName ? state.workers[slotName] || null : null;
      const session = slotName ? normalizedSessions[slotName] || null : null;
      const priorLease = state.leases[seq] || null;
      const worktree = priorLease?.worktree || slot?.worktree || resolveWorktreePath(this.ctx.projectName, seq, this.ctx.config.WORKTREE_DIR);
      const branch = priorLease?.branch || slot?.branch || this.inspectBranchHint(worktree) || null;
      const candidate: Candidate = {
        seq,
        card,
        slotName,
        slot,
        session,
        branch,
        worktree,
        priorActiveStartedAt: state.activeCards[seq]?.startedAt || null,
        priorRetryCount: state.activeCards[seq]?.retryCount ?? state.leases[seq]?.retryCount ?? 0,
        priorLease,
      };

      const evidence = this.inspectWorktreeEvidence(seq, branch, worktree);
      nextState.worktreeEvidence[seq] = evidence;

      const lease = this.deriveLease(candidate, evidence);
      if (!lease) continue;
      nextState.leases[seq] = lease;

      if (slotName && this.isLiveLeaseOwner(candidate, lease)) {
        nextWorkers[slotName] = this.projectWorkerSlot(slotName, candidate, lease);
      }

      const activeCard = this.projectActiveCard(candidate, lease, state);
      if (activeCard) nextState.activeCards[seq] = activeCard;
    }

    nextState.workers = nextWorkers;
    nextState.sessions = normalizedSessions;
    const changed =
      JSON.stringify(state.workers) !== JSON.stringify(nextState.workers) ||
      JSON.stringify(state.activeCards) !== JSON.stringify(nextState.activeCards) ||
      JSON.stringify(state.leases) !== JSON.stringify(nextState.leases) ||
      JSON.stringify(state.worktreeEvidence) !== JSON.stringify(nextState.worktreeEvidence) ||
      JSON.stringify(state.sessions) !== JSON.stringify(normalizedSessions);

    if (persist && changed) {
      store.updateState(updatedBy, (runtimeState) => {
        runtimeState.workers = nextState.workers;
        runtimeState.activeCards = nextState.activeCards;
        runtimeState.leases = nextState.leases;
        runtimeState.worktreeEvidence = nextState.worktreeEvidence;
        runtimeState.worktreeCleanup = nextState.worktreeCleanup;
        runtimeState.sessions = normalizedSessions;
      });
    }

    return { state: nextState, updated: changed };
  }

  private collectCandidateSeqs(state: RuntimeState, cards: Card[]): string[] {
    const seqs = new Set<string>();
    for (const card of cards) seqs.add(card.seq);
    for (const seq of Object.keys(state.activeCards)) seqs.add(seq);
    for (const seq of Object.keys(state.leases || {})) seqs.add(seq);

    if (existsSync(this.ctx.paths.worktreeRoot)) {
      for (const entry of readdirSync(this.ctx.paths.worktreeRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && /^\d+$/.test(entry.name)) {
          seqs.add(entry.name);
        }
      }
    }

    return Array.from(seqs).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  }

  private buildSlotLookup(state: RuntimeState): Map<string, string> {
    const lookup = new Map<string, string>();
    for (const [slotName, slot] of Object.entries(state.workers)) {
      if (slot.seq != null) lookup.set(String(slot.seq), slotName);
    }
    for (const [seq, active] of Object.entries(state.activeCards)) {
      if (active.worker) lookup.set(seq, active.worker);
    }
    for (const [seq, lease] of Object.entries(state.leases || {})) {
      if (lease.slot) lookup.set(seq, lease.slot);
    }
    return lookup;
  }

  private normalizeSessions(state: RuntimeState): Record<string, ACPSessionRecord> {
    const nextSessions: Record<string, ACPSessionRecord> = { ...state.sessions };

    for (const [slotName, session] of Object.entries(state.sessions)) {
      const slot = state.workers[slotName];
      if (!slot) continue;
      if (isPersistedSessionAlive(slot, session)) continue;

      const nextRun =
        session.currentRun && !TERMINAL_RUN_STATUSES.has(session.currentRun.status)
          ? {
              ...session.currentRun,
              status: 'lost' as const,
              updatedAt: new Date().toISOString(),
              completedAt: session.currentRun.completedAt || new Date().toISOString(),
            }
          : session.currentRun;

      nextSessions[slotName] = {
        ...session,
        status: 'offline',
        sessionState: 'offline',
        currentRun: nextRun,
        pendingInput: null,
        updatedAt: new Date().toISOString(),
      };
    }

    return nextSessions;
  }

  private inspectBranchHint(worktree: string | null): string | null {
    if (!worktree || !existsSync(worktree)) return null;
    try {
      const output = execFileSync(
        'git',
        ['-C', worktree, 'rev-parse', '--abbrev-ref', 'HEAD'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
      ).trim();
      return output && output !== 'HEAD' ? output : null;
    } catch {
      return null;
    }
  }

  private inspectWorktreeEvidence(seq: string, branch: string | null, worktree: string | null): WorktreeEvidence {
    const now = new Date().toISOString();
    const evidence: WorktreeEvidence = {
      seq: parseInt(seq, 10),
      branch,
      worktree,
      worktreeExists: !!(worktree && existsSync(worktree)),
      branchExists: false,
      gitStatus: 'missing',
      pushed: false,
      mergedToBase: false,
      aheadOfBase: 0,
      behindBase: 0,
      lastCheckedAt: now,
    };

    if (branch) {
      evidence.branchExists = this.branchExists(branch);
    }

    if (!evidence.worktreeExists || !worktree) return evidence;

    evidence.branch = branch || this.inspectBranchHint(worktree);
    if (evidence.branch && !evidence.branchExists) {
      evidence.branchExists = this.branchExists(evidence.branch);
    }

    evidence.gitStatus = this.inspectGitStatus(worktree);

    if (evidence.branch) {
      evidence.pushed = branchPushed(worktree, evidence.branch);
      const ahead = this.branchAheadOfBase(worktree, evidence.branch);
      evidence.aheadOfBase = Math.max(ahead, 0);
      evidence.behindBase = this.branchBehindBase(worktree, evidence.branch);
      evidence.mergedToBase = this.isMergedToBase(worktree, evidence.branch);
    }

    return evidence;
  }

  private branchExists(branch: string): boolean {
    try {
      execFileSync(
        'git',
        ['-C', this.ctx.paths.repoDir, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
        { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  private inspectGitStatus(worktree: string): WorktreeEvidenceStatus {
    try {
      const conflicts = execFileSync(
        'git',
        ['-C', worktree, 'diff', '--name-only', '--diff-filter=U'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
      ).trim();
      if (conflicts) return 'conflict';
    } catch {
      // ignore
    }

    if (this.hasGitRef(worktree, 'REBASE_HEAD')) return 'rebase';
    if (this.hasGitRef(worktree, 'MERGE_HEAD')) return 'merge';

    try {
      const output = execFileSync(
        'git',
        ['-C', worktree, 'status', '--porcelain'],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
      ).trim();
      return output ? 'dirty' : 'clean';
    } catch {
      return 'missing';
    }
  }

  private hasGitRef(worktree: string, ref: string): boolean {
    try {
      execFileSync(
        'git',
        ['-C', worktree, 'rev-parse', '-q', '--verify', ref],
        { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  private branchBehindBase(worktree: string, branch: string): number {
    try {
      const output = execFileSync(
        'git',
        ['-C', worktree, 'rev-list', '--left-right', '--count', `${branch}...origin/${this.ctx.config.GITLAB_MERGE_BRANCH}`],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
      ).trim();
      const [, behind] = output.split(/\s+/).map((value) => parseInt(value, 10) || 0);
      return behind || 0;
    } catch {
      return 0;
    }
  }

  private branchAheadOfBase(worktree: string, branch: string): number {
    try {
      const output = execFileSync(
        'git',
        ['-C', worktree, 'rev-list', '--left-right', '--count', `${branch}...origin/${this.ctx.config.GITLAB_MERGE_BRANCH}`],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 },
      ).trim();
      const [ahead] = output.split(/\s+/).map((value) => parseInt(value, 10) || 0);
      return ahead || 0;
    } catch {
      return 0;
    }
  }

  private isMergedToBase(worktree: string, branch: string): boolean {
    try {
      execFileSync(
        'git',
        ['-C', worktree, 'merge-base', '--is-ancestor', branch, `origin/${this.ctx.config.GITLAB_MERGE_BRANCH}`],
        { stdio: ['ignore', 'ignore', 'ignore'], timeout: 5000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  private deriveLease(candidate: Candidate, evidence: WorktreeEvidence): TaskLease | null {
    const pmState = candidate.card?.state ?? candidate.priorLease?.pmStateObserved ?? null;
    const liveWorker = this.isLiveWorker(candidate);

    if (pmState === 'Done' && evidence.mergedToBase && !liveWorker) {
      return null;
    }

    const hasTechnicalEvidence =
      evidence.worktreeExists ||
      evidence.branchExists ||
      evidence.gitStatus !== 'missing' ||
      evidence.aheadOfBase > 0 ||
      evidence.pushed ||
      evidence.mergedToBase;

    if (!liveWorker && !hasTechnicalEvidence) {
      return null;
    }

    const phase = this.deriveLeasePhase(pmState, candidate, evidence, liveWorker);
    if (!phase) return null;

    return {
      seq: parseInt(candidate.seq, 10),
      pmStateObserved: pmState,
      phase,
      slot: liveWorker ? candidate.slotName : null,
      branch: evidence.branch || candidate.branch,
      worktree: evidence.worktree || candidate.worktree,
      sessionId: liveWorker ? candidate.session?.sessionId || candidate.slot?.sessionId || null : null,
      runId: liveWorker ? candidate.session?.currentRun?.runId || candidate.slot?.runId || null : null,
      claimedAt: candidate.slot?.claimedAt || candidate.priorLease?.claimedAt || null,
      retryCount: candidate.priorLease?.retryCount ?? candidate.priorRetryCount,
      lastTransitionAt: new Date().toISOString(),
    };
  }

  private deriveLeasePhase(
    pmState: CardState | null,
    candidate: Candidate,
    evidence: WorktreeEvidence,
    liveWorker: boolean,
  ): TaskLeasePhase | null {
    const runStatus = getPersistedRunStatus(candidate.slot || createIdleWorkerSlot(), candidate.session);
    const waitingInput = runStatus === 'waiting_input' || runStatus === 'needs_confirmation' || !!candidate.session?.pendingInput;

    if (liveWorker) {
      if (waitingInput) return 'waiting_confirmation';
      if (candidate.slot?.status === 'merging') return 'merging';
      if (candidate.slot?.status === 'releasing') return 'closing';
      if (candidate.slot?.status === 'resolving' || ['rebase', 'merge', 'conflict'].includes(evidence.gitStatus)) {
        return 'resolving_conflict';
      }
      return 'coding';
    }

    if (pmState === 'Planning' || pmState === 'Backlog' || pmState === 'Todo') {
      return evidence.worktreeExists || evidence.branchExists ? 'suspended' : null;
    }

    if (pmState === 'QA') {
      return evidence.mergedToBase ? 'closing' : 'merging';
    }

    if (pmState === 'Done') {
      return evidence.mergedToBase ? null : 'closing';
    }

    if (pmState === 'Inprogress' || !pmState) {
      if (evidence.mergedToBase) return 'closing';
      if (['rebase', 'merge', 'conflict'].includes(evidence.gitStatus)) return 'resolving_conflict';
      if (evidence.pushed || evidence.aheadOfBase > 0) return 'merging';
      if (evidence.worktreeExists || evidence.branchExists) return 'coding';
    }

    return null;
  }

  private isLiveWorker(candidate: Candidate): boolean {
    if (!candidate.slot) return false;

    if (candidate.slot.transport === 'acp-sdk' || candidate.slot.mode === 'acp' || candidate.slot.mode === 'acp-sdk') {
      return hasPersistedActiveRun(candidate.slot, candidate.session);
    }

    return candidate.slot.status !== 'idle' && isProcAlive(candidate.slot.pid || 0);
  }

  private isLiveLeaseOwner(candidate: Candidate, lease: TaskLease): boolean {
    return !!lease.slot && this.isLiveWorker(candidate);
  }

  private projectWorkerSlot(slotName: string, candidate: Candidate, lease: TaskLease): WorkerSlotState {
    const base = candidate.slot ? { ...candidate.slot } : createIdleWorkerSlot();
    const projectedStatus =
      lease.phase === 'merging'
        ? 'merging'
        : lease.phase === 'resolving_conflict' || lease.phase === 'waiting_confirmation'
          ? 'resolving'
          : lease.phase === 'closing'
            ? 'releasing'
            : 'active';

    return {
      ...createIdleWorkerSlot(),
      ...base,
      status: projectedStatus,
      seq: lease.seq,
      branch: lease.branch,
      worktree: lease.worktree,
      sessionId: lease.sessionId,
      runId: lease.runId,
      sessionState: candidate.session?.sessionState || base.sessionState || null,
      remoteStatus: candidate.session?.currentRun?.status || base.remoteStatus || null,
      lastEventAt: candidate.session?.lastSeenAt || base.lastEventAt || null,
      pid: candidate.session?.pid || base.pid || null,
    };
  }

  private projectActiveCard(candidate: Candidate, lease: TaskLease, state: RuntimeState) {
    if (lease.phase === 'suspended' || lease.phase === 'released') return null;

    const isQaProjection =
      lease.pmStateObserved === 'QA' ||
      lease.phase === 'merging' ||
      lease.phase === 'resolving_conflict' ||
      lease.phase === 'closing';
    const projectedState =
      lease.phase === 'queued' || lease.phase === 'preparing'
        ? 'Todo'
        : isQaProjection
          ? 'QA'
          : 'Inprogress';
    const prior = state.activeCards[candidate.seq];
    return {
      seq: lease.seq,
      state: projectedState,
      worker: lease.slot,
      mrUrl: prior?.mrUrl || null,
      conflictDomains: prior?.conflictDomains || [],
      startedAt: candidate.priorActiveStartedAt || lease.claimedAt || new Date().toISOString(),
      retryCount: lease.retryCount,
    };
  }
}
