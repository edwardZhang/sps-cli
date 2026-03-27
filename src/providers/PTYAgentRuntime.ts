/**
 * PTYAgentRuntime — implements AgentRuntime using PTY sessions instead of tmux.
 *
 * Uses PTYSessionManager for direct pseudoterminal control, providing:
 * - Real-time stream output (no polling)
 * - Direct stdin injection (no tmux send-keys indirection)
 * - Event-driven state detection (no pane text parsing)
 */
import type { ProjectContext } from '../core/context.js';
import { readACPState, writeACPState } from '../core/acpState.js';
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';
import type {
  ACPState,
  ACPSessionRecord,
  ACPTool,
  PendingInput,
} from '../models/acp.js';
import { PTYSessionManager, type SessionInfo } from '../manager/pty-session-manager.js';
import type { Notifier } from '../interfaces/Notifier.js';
import type { WaitingInputEvent } from '../manager/pty-session.js';

function now(): string {
  return new Date().toISOString();
}

function previewPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

// Shared singleton per tick process
let sharedManager: PTYSessionManager | null = null;

export function getSharedPTYManager(): PTYSessionManager {
  if (!sharedManager) {
    sharedManager = new PTYSessionManager();
  }
  return sharedManager;
}

export class PTYAgentRuntime implements AgentRuntime {
  private readonly manager: PTYSessionManager;
  private notifier: Notifier | null = null;

  constructor(
    private readonly ctx: ProjectContext,
    manager?: PTYSessionManager,
    notifier?: Notifier | null,
  ) {
    this.manager = manager || getSharedPTYManager();
    this.notifier = notifier || null;
  }

  /** Set notifier for waiting_input push notifications */
  setNotifier(notifier: Notifier | null): void {
    this.notifier = notifier;
  }

  async ensureSession(slot: string, tool?: ACPTool, cwdOverride?: string): Promise<ACPSessionRecord> {
    const normalizedSlot = this.normalizeSlot(slot);
    const selectedTool = tool || this.defaultTool();
    const cwd = cwdOverride || this.ctx.paths.repoDir;

    const session = await this.manager.ensureSession({
      project: this.ctx.projectName,
      slot: normalizedSlot,
      tool: selectedTool,
      cwd,
      logsDir: this.ctx.paths.logsDir,
    });

    // Hook waiting-input events for persistence + notification
    const ptySession = this.manager.getSession(this.ctx.projectName, normalizedSlot);
    if (ptySession) {
      ptySession.removeAllListeners('waiting-input');
      ptySession.on('waiting-input', (event: WaitingInputEvent) => {
        this.handleWaitingInput(normalizedSlot, event);
      });
      // Clear pending when state leaves waiting_input
      ptySession.on('state-change', (newState: string) => {
        if (newState !== 'waiting_input') {
          this.clearPendingInput(normalizedSlot);
        }
      });
    }

    const record = this.buildSessionRecord(normalizedSlot, session, selectedTool, cwd);

    // Persist to acp-state.json
    const state = readACPState(this.ctx.paths.acpStateFile);
    state.sessions[normalizedSlot] = record;
    state.updatedAt = now();
    state.updatedBy = 'pty-ensure';
    writeACPState(this.ctx.paths.acpStateFile, state, state.updatedBy);

    return record;
  }

  async startRun(slot: string, prompt: string, tool?: ACPTool, cwdOverride?: string): Promise<ACPSessionRecord> {
    const normalizedSlot = this.normalizeSlot(slot);
    const selectedTool = tool || this.defaultTool();
    const cwd = cwdOverride || this.ctx.paths.repoDir;

    // Ensure session exists first
    let session = this.manager.getSession(this.ctx.projectName, normalizedSlot);
    if (!session || !session.isAlive()) {
      await this.ensureSession(slot, selectedTool, cwd);
      session = this.manager.getSession(this.ctx.projectName, normalizedSlot);
    }

    if (!session) throw new Error(`Failed to create session for ${normalizedSlot}`);

    const { runId } = this.manager.startRun(this.ctx.projectName, normalizedSlot, prompt);

    const info = this.manager.inspect(this.ctx.projectName, normalizedSlot)!;
    const record = this.buildSessionRecord(normalizedSlot, info, selectedTool, cwd, {
      runId,
      status: 'submitted',
      promptPreview: previewPrompt(prompt),
      startedAt: now(),
    });

    // Persist
    const state = readACPState(this.ctx.paths.acpStateFile);
    state.sessions[normalizedSlot] = record;
    state.updatedAt = now();
    state.updatedBy = 'pty-start-run';
    writeACPState(this.ctx.paths.acpStateFile, state, state.updatedBy);

    return record;
  }

  async resumeRun(slot: string, prompt: string): Promise<ACPSessionRecord> {
    const normalizedSlot = this.normalizeSlot(slot);
    const session = this.manager.getSession(this.ctx.projectName, normalizedSlot);
    if (!session || !session.isAlive()) {
      throw new Error(`No live PTY session for ${normalizedSlot}`);
    }

    const { runId } = this.manager.resumeRun(this.ctx.projectName, normalizedSlot, prompt);

    const info = this.manager.inspect(this.ctx.projectName, normalizedSlot)!;
    const tool = session.tool as ACPTool;
    const record = this.buildSessionRecord(normalizedSlot, info, tool, session.cwd, {
      runId,
      status: 'submitted',
      promptPreview: previewPrompt(prompt),
      startedAt: now(),
    });

    const state = readACPState(this.ctx.paths.acpStateFile);
    state.sessions[normalizedSlot] = record;
    state.updatedAt = now();
    state.updatedBy = 'pty-resume-run';
    writeACPState(this.ctx.paths.acpStateFile, state, state.updatedBy);

    return record;
  }

  async inspect(slot?: string): Promise<ACPState> {
    const state = readACPState(this.ctx.paths.acpStateFile);

    if (slot) {
      const normalizedSlot = this.normalizeSlot(slot);
      const info = this.manager.inspect(this.ctx.projectName, normalizedSlot);
      if (info) {
        this.syncSessionRecord(state, normalizedSlot, info);
      }
    } else {
      // Inspect all slots
      for (const [slotName, record] of Object.entries(state.sessions)) {
        const info = this.manager.inspect(this.ctx.projectName, slotName);
        if (info) {
          this.syncSessionRecord(state, slotName, info);
        } else {
          // Session gone — mark offline
          record.sessionState = 'offline';
          record.status = 'idle';
          record.updatedAt = now();
        }
      }
    }

    state.updatedAt = now();
    state.updatedBy = 'pty-inspect';
    writeACPState(this.ctx.paths.acpStateFile, state, state.updatedBy);

    return state;
  }

  async stopSession(slot: string): Promise<void> {
    const normalizedSlot = this.normalizeSlot(slot);
    this.manager.killSession(this.ctx.projectName, normalizedSlot);

    const state = readACPState(this.ctx.paths.acpStateFile);
    if (state.sessions[normalizedSlot]) {
      state.sessions[normalizedSlot].sessionState = 'offline';
      state.sessions[normalizedSlot].status = 'idle';
      state.sessions[normalizedSlot].updatedAt = now();
    }
    state.updatedAt = now();
    state.updatedBy = 'pty-stop';
    writeACPState(this.ctx.paths.acpStateFile, state, state.updatedBy);
  }

  /**
   * Wait for the current run on a slot to complete.
   */
  async waitForRunComplete(slot: string, timeoutMs?: number): Promise<{ status: string; runId: string | null }> {
    const normalizedSlot = this.normalizeSlot(slot);
    return this.manager.waitForRunComplete(this.ctx.projectName, normalizedSlot, timeoutMs);
  }

  /**
   * Send a response to a waiting_input prompt.
   */
  respond(slot: string, response: string): void {
    const normalizedSlot = this.normalizeSlot(slot);
    this.manager.respond(this.ctx.projectName, normalizedSlot, response);
  }

  /**
   * Get the underlying PTYSessionManager (for direct access if needed).
   */
  getManager(): PTYSessionManager {
    return this.manager;
  }

  // ─── Waiting Input Handling ─────────────────────────────────

  private handleWaitingInput(slot: string, event: WaitingInputEvent): void {
    const pending: PendingInput = {
      type: event.type,
      prompt: event.prompt,
      options: event.options,
      dangerous: event.dangerous,
      timestamp: event.timestamp,
    };

    // Persist to acp-state.json
    try {
      const state = readACPState(this.ctx.paths.acpStateFile);
      if (state.sessions[slot]) {
        state.sessions[slot].pendingInput = pending;
        state.sessions[slot].updatedAt = now();
        if (state.sessions[slot].currentRun) {
          state.sessions[slot].currentRun!.status = 'waiting_input';
          state.sessions[slot].currentRun!.updatedAt = now();
        }
      }
      writeACPState(this.ctx.paths.acpStateFile, state, 'pty-waiting-input');
    } catch { /* best effort */ }

    // Log + Notify
    const dangerTag = event.dangerous ? ' DANGEROUS' : '';
    const msg = `[${this.ctx.projectName}] ${slot} waiting for input${dangerTag}: ${event.prompt}`;
    process.stderr.write(`[pty-runtime] ${msg}\n`);

    if (this.notifier) {
      if (event.dangerous) {
        this.notifier.sendWarning(msg).catch(() => {});
      } else {
        this.notifier.send(msg, 'warning').catch(() => {});
      }
    }
  }

  private clearPendingInput(slot: string): void {
    try {
      const state = readACPState(this.ctx.paths.acpStateFile);
      if (state.sessions[slot]?.pendingInput) {
        state.sessions[slot].pendingInput = null;
        state.sessions[slot].updatedAt = now();
        writeACPState(this.ctx.paths.acpStateFile, state, 'pty-clear-input');
      }
    } catch { /* best effort */ }
  }

  // ─── Internal ─────────────────────────────────────────────

  private normalizeSlot(slot: string): string {
    return slot.startsWith('worker-') ? slot : `worker-${slot}`;
  }

  private defaultTool(): ACPTool {
    return (this.ctx.config.raw.ACP_AGENT || this.ctx.config.WORKER_TOOL || 'claude') as ACPTool;
  }

  private buildSessionRecord(
    slot: string,
    info: SessionInfo | { getState(): string; pid: number; sessionId: string; isAlive(): boolean; getRunId(): string | null; getBuffer(n: number): string; tool: string; cwd: string },
    tool: ACPTool,
    cwd: string,
    run?: { runId: string; status: string; promptPreview: string; startedAt: string },
  ): ACPSessionRecord {
    const isSessionInfo = 'state' in info;
    const state = isSessionInfo ? (info as SessionInfo).state : (info as any).getState();
    const pid = isSessionInfo ? (info as SessionInfo).pid : (info as any).pid;
    const sessionId = isSessionInfo ? (info as SessionInfo).sessionId : (info as any).sessionId;
    const alive = isSessionInfo ? (info as SessionInfo).alive : (info as any).isAlive();
    const buffer = isSessionInfo ? (info as SessionInfo).buffer : (info as any).getBuffer(30);

    const hasRun = !!run;
    const sessionState: ACPSessionRecord['sessionState'] =
      !alive ? 'offline' :
      hasRun ? 'busy' :
      state === 'busy' || state === 'waiting_input' ? 'busy' :
      state === 'ready' ? 'ready' :
      'booting';

    const slotStatus: ACPSessionRecord['status'] =
      hasRun ? 'active' :
      state === 'busy' ? 'active' :
      state === 'waiting_input' ? 'active' :
      'idle';

    return {
      slot,
      tool,
      sessionId,
      sessionName: sessionId,
      pid,
      cwd,
      status: slotStatus,
      sessionState,
      currentRun: run ? {
        runId: run.runId,
        status: run.status as any,
        promptPreview: run.promptPreview,
        startedAt: run.startedAt,
        updatedAt: now(),
        completedAt: null,
      } : null,
      pendingInput: null,
      createdAt: now(),
      updatedAt: now(),
      lastSeenAt: now(),
      lastPaneText: buffer,
    };
  }

  private syncSessionRecord(state: ACPState, slotName: string, info: SessionInfo): void {
    const existing = state.sessions[slotName];
    if (!existing) return;

    const prevSessionState = existing.sessionState;
    const prevRunStatus = existing.currentRun?.status ?? null;
    const nextSessionState = info.alive
      ? (info.state === 'busy' || info.state === 'waiting_input' ? 'busy' : info.state === 'ready' ? 'ready' : 'booting')
      : 'offline';
    const nextSlotStatus = info.state === 'busy' || info.state === 'waiting_input' ? 'active' : 'idle';

    existing.sessionState = nextSessionState;
    existing.status = nextSlotStatus;
    existing.pid = info.pid;
    existing.lastSeenAt = now();
    existing.lastPaneText = info.buffer;
    existing.updatedAt = now();

    if (existing.currentRun) {
      if (info.state === 'waiting_input') {
        existing.currentRun.status = 'waiting_input';
        existing.currentRun.updatedAt = now();
        return;
      }

      if (info.state === 'busy' && (
        prevRunStatus === 'submitted' ||
        prevRunStatus === 'running' ||
        prevRunStatus === 'waiting_input'
      )) {
        existing.currentRun.status = 'running';
        existing.currentRun.updatedAt = now();
        return;
      }

      if (
        info.state === 'ready' &&
        nextSlotStatus === 'idle' &&
        (prevSessionState === 'busy' || prevRunStatus === 'running' || prevRunStatus === 'waiting_input') &&
        prevRunStatus !== 'completed'
      ) {
        existing.currentRun.status = 'completed';
        existing.currentRun.completedAt = now();
        existing.currentRun.updatedAt = now();
      }
    }
  }
}
