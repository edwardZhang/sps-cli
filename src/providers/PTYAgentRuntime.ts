/**
 * PTYAgentRuntime — implements AgentRuntime using PTY sessions instead of tmux.
 *
 * Uses PTYSessionManager for direct pseudoterminal control, providing:
 * - Real-time stream output (no polling)
 * - Direct stdin injection (no tmux send-keys indirection)
 * - Event-driven state detection (no pane text parsing)
 */
import type { ProjectContext } from '../core/context.js';
import { RuntimeStore } from '../core/runtimeStore.js';
import { drainPTYControl } from '../core/ptyControl.js';
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

function outputAgeMs(lastOutputAt: string | null | undefined): number {
  if (!lastOutputAt) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(lastOutputAt);
  if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY;
  return Date.now() - parsed;
}

function hasPromptReturned(buffer: string): boolean {
  const tail = buffer
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(-8);
  return tail.some(line =>
    /^[›❯>]\s/.test(line) ||
    (/OpenAI Codex/i.test(line) && /(\/review|\/model|% left)/i.test(line)),
  );
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
  private readonly runtimeStore: RuntimeStore;
  private notifier: Notifier | null = null;
  private controlLoopStarted = false;
  private controlDrainInFlight = false;

  constructor(
    private readonly ctx: ProjectContext,
    manager?: PTYSessionManager,
    notifier?: Notifier | null,
  ) {
    this.manager = manager || getSharedPTYManager();
    this.runtimeStore = new RuntimeStore(ctx);
    this.notifier = notifier || null;
    this.startControlLoop();
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
        if (newState !== 'waiting_input' && newState !== 'needs_confirmation') {
          this.clearPendingInput(normalizedSlot);
        }
      });
    }

    const record = this.buildSessionRecord(normalizedSlot, session, selectedTool, cwd);

    // Persist to acp-state.json
    this.runtimeStore.updateACPState('pty-ensure', (state) => {
      state.sessions[normalizedSlot] = record;
    });

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

    await this.applyQueuedControlCommands();
    const { runId } = await this.manager.startRun(this.ctx.projectName, normalizedSlot, prompt);

    const info = this.manager.inspect(this.ctx.projectName, normalizedSlot)!;
    const record = this.buildSessionRecord(normalizedSlot, info, selectedTool, cwd, {
      runId,
      status: info.stalledReason ? 'stalled_submit' : 'submitted',
      promptPreview: previewPrompt(prompt),
      startedAt: now(),
    });

    // Persist
    this.runtimeStore.updateACPState('pty-start-run', (state) => {
      state.sessions[normalizedSlot] = record;
    });

    return record;
  }

  async resumeRun(slot: string, prompt: string): Promise<ACPSessionRecord> {
    const normalizedSlot = this.normalizeSlot(slot);
    const session = this.manager.getSession(this.ctx.projectName, normalizedSlot);
    if (!session || !session.isAlive()) {
      throw new Error(`No live PTY session for ${normalizedSlot}`);
    }

    await this.applyQueuedControlCommands();
    const { runId } = await this.manager.resumeRun(this.ctx.projectName, normalizedSlot, prompt);

    const info = this.manager.inspect(this.ctx.projectName, normalizedSlot)!;
    const tool = session.tool as ACPTool;
    const record = this.buildSessionRecord(normalizedSlot, info, tool, session.cwd, {
      runId,
      status: info.stalledReason ? 'stalled_submit' : 'submitted',
      promptPreview: previewPrompt(prompt),
      startedAt: now(),
    });

    this.runtimeStore.updateACPState('pty-resume-run', (state) => {
      state.sessions[normalizedSlot] = record;
    });

    return record;
  }

  async inspect(slot?: string): Promise<ACPState> {
    await this.applyQueuedControlCommands();
    const state = this.runtimeStore.readACPState();

    if (slot) {
      const normalizedSlot = this.normalizeSlot(slot);
      const info = await this.manager.maintainSession(this.ctx.projectName, normalizedSlot);
      if (info) {
        this.syncSessionRecord(state, normalizedSlot, info);
      }
    } else {
      // Inspect all slots
      for (const [slotName, record] of Object.entries(state.sessions)) {
        const info = await this.manager.maintainSession(this.ctx.projectName, slotName);
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

    this.runtimeStore.updateACPState('pty-inspect', (draft) => {
      draft.sessions = state.sessions;
    });

    return state;
  }

  async stopSession(slot: string): Promise<void> {
    const normalizedSlot = this.normalizeSlot(slot);
    this.manager.killSession(this.ctx.projectName, normalizedSlot);

    this.runtimeStore.updateACPState('pty-stop', (state) => {
      if (state.sessions[normalizedSlot]) {
        state.sessions[normalizedSlot].sessionState = 'offline';
        state.sessions[normalizedSlot].status = 'idle';
        state.sessions[normalizedSlot].updatedAt = now();
      }
    });
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
      this.runtimeStore.updateACPState('pty-waiting-input', (state) => {
        if (state.sessions[slot]) {
          state.sessions[slot].pendingInput = pending;
          state.sessions[slot].updatedAt = now();
          if (state.sessions[slot].currentRun) {
            state.sessions[slot].currentRun!.status = event.type === 'input' ? 'waiting_input' : 'needs_confirmation';
            state.sessions[slot].currentRun!.updatedAt = now();
          }
        }
      });
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
      this.runtimeStore.updateACPState('pty-clear-input', (state) => {
        if (state.sessions[slot]?.pendingInput) {
          state.sessions[slot].pendingInput = null;
          state.sessions[slot].updatedAt = now();
        }
      });
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
    const lastOutputAt = isSessionInfo ? (info as SessionInfo).lastOutputAt : null;
    const submitAttempts = isSessionInfo ? (info as SessionInfo).submitAttempts : 0;
    const stalledReason = isSessionInfo ? (info as SessionInfo).stalledReason : null;
    const promptPreview = run?.promptPreview ?? (isSessionInfo ? (info as SessionInfo).promptPreview : null);
    const executionEvidence = isSessionInfo ? (info as SessionInfo).executionEvidence : false;

    const hasRun = !!run;
    const sessionState: ACPSessionRecord['sessionState'] =
      !alive ? 'offline' :
      state === 'needs_confirmation' ? 'needs_confirmation' :
      hasRun ? 'busy' :
      state === 'busy' || state === 'waiting_input' ? 'busy' :
      state === 'ready' ? 'ready' :
      'booting';

    const slotStatus: ACPSessionRecord['status'] =
      hasRun || stalledReason ? 'active' :
      state === 'busy' ? 'active' :
      state === 'waiting_input' || state === 'needs_confirmation' ? 'active' :
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
        promptPreview: promptPreview || run.promptPreview,
        startedAt: run.startedAt,
        updatedAt: now(),
        completedAt: null,
      } : null,
      pendingInput: null,
      createdAt: now(),
      updatedAt: now(),
      lastSeenAt: now(),
      lastOutputAt,
      submitAttempts,
      stalledReason,
      lastPaneText: buffer,
    };
  }

  private syncSessionRecord(state: ACPState, slotName: string, info: SessionInfo): void {
    const existing = state.sessions[slotName];
    if (!existing) return;

    const prevSessionState = existing.sessionState;
    const prevRunStatus = existing.currentRun?.status ?? null;
    const hadActiveRun = !!existing.currentRun && (
      prevRunStatus === 'submitted' ||
      prevRunStatus === 'running' ||
      prevRunStatus === 'waiting_input' ||
      prevRunStatus === 'needs_confirmation' ||
      prevRunStatus === 'stalled_submit'
    );
    const outputSettled = outputAgeMs(info.lastOutputAt) > 1_500;
    const promptReturned = hasPromptReturned(info.buffer);

    existing.pid = info.pid;
    existing.lastSeenAt = now();
    existing.lastOutputAt = info.lastOutputAt;
    existing.submitAttempts = info.submitAttempts;
    existing.stalledReason = info.stalledReason;
    existing.lastPaneText = info.buffer;
    existing.updatedAt = now();

    let nextRunStatus = prevRunStatus;
    if (existing.currentRun) {
      if (info.state === 'needs_confirmation') {
        nextRunStatus = 'needs_confirmation';
      } else if (info.state === 'waiting_input') {
        nextRunStatus = 'waiting_input';
      } else if (info.stalledReason && !info.executionEvidence) {
        nextRunStatus = 'stalled_submit';
      } else if (
        hadActiveRun &&
        outputSettled &&
        promptReturned &&
        (!info.stalledReason || info.executionEvidence) &&
        (
          info.state === 'ready' ||
          prevSessionState === 'busy' ||
          prevSessionState === 'needs_confirmation' ||
          prevRunStatus === 'submitted' ||
          prevRunStatus === 'running' ||
          prevRunStatus === 'waiting_input' ||
          prevRunStatus === 'needs_confirmation' ||
          prevRunStatus === 'stalled_submit'
        )
      ) {
        nextRunStatus = 'completed';
      } else if (
        hadActiveRun &&
        (
          info.state === 'busy' ||
          info.executionEvidence ||
          !outputSettled
        )
      ) {
        nextRunStatus = 'running';
      }

      if (nextRunStatus && nextRunStatus !== prevRunStatus) {
        existing.currentRun.status = nextRunStatus as typeof existing.currentRun.status;
        existing.currentRun.updatedAt = now();
        if (nextRunStatus === 'completed') {
          existing.currentRun.completedAt = now();
        }
      }
    }

    const runIsActive =
      nextRunStatus === 'submitted' ||
      nextRunStatus === 'running' ||
      nextRunStatus === 'waiting_input' ||
      nextRunStatus === 'needs_confirmation' ||
      nextRunStatus === 'stalled_submit';

    const nextSessionState = info.alive
      ? (
        nextRunStatus === 'completed' ? 'ready' :
        info.state === 'needs_confirmation' ? 'needs_confirmation' :
        info.state === 'busy' || info.state === 'waiting_input' || runIsActive ? 'busy' :
        info.state === 'ready' ? 'ready' :
        'booting'
      )
      : 'offline';

    const nextSlotStatus = nextRunStatus === 'completed'
      ? 'idle'
      : runIsActive || info.state === 'busy' || info.state === 'waiting_input' || info.state === 'needs_confirmation'
      ? 'active'
      : 'idle';

    existing.sessionState = nextSessionState;
    existing.status = nextSlotStatus;
  }

  private async applyQueuedControlCommands(): Promise<void> {
    if (this.controlDrainInFlight) return;
    this.controlDrainInFlight = true;
    try {
    const commands = drainPTYControl(this.ctx);
    if (commands.length === 0) return;

    const appliedAt = now();
    const appliedSlots = new Set<string>();

    for (const command of commands) {
      const session = this.manager.getSession(this.ctx.projectName, command.slot);
      if (!session || !session.isAlive()) continue;

      if (command.type === 'reject') {
        session.reject();
      } else if (command.type === 'confirm') {
        session.confirm();
      } else {
        this.manager.respond(this.ctx.projectName, command.slot, command.response);
      }
      appliedSlots.add(command.slot);
    }

    if (appliedSlots.size === 0) return;

    this.runtimeStore.updateACPState('pty-control-apply', (state) => {
      for (const slot of appliedSlots) {
        const session = state.sessions[slot];
        if (!session) continue;
        session.pendingInput = null;
        session.updatedAt = appliedAt;
        if (session.currentRun && (
          session.currentRun.status === 'waiting_input' ||
          session.currentRun.status === 'needs_confirmation'
        )) {
          session.currentRun.status = 'running';
          session.currentRun.updatedAt = appliedAt;
        }
      }
    });
    } finally {
      this.controlDrainInFlight = false;
    }
  }

  private startControlLoop(): void {
    if (this.controlLoopStarted) return;
    this.controlLoopStarted = true;
    const timer = setInterval(() => {
      void this.applyQueuedControlCommands();
    }, 1_000);
    timer.unref();
  }
}
