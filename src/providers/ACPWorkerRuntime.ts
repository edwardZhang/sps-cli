
import type { ProjectContext } from '../core/context.js';
import { RuntimeStore } from '../core/runtimeStore.js';
import type { ACPClient } from '../interfaces/ACPClient.js';
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';
import type {
  ACPRunRecord,
  ACPSessionRecord,
  ACPSlotStatus,
  ACPState,
  ACPTool,
} from '../models/acp.js';
import { LocalACPClient } from './LocalACPClient.js';

function now(): string {
  return new Date().toISOString();
}

function previewPrompt(prompt: string): string {
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}...` : oneLine;
}

function isTerminalRunStatus(status: ACPRunRecord['status']): boolean {
  return ['completed', 'failed', 'cancelled', 'lost'].includes(status);
}

export class ACPWorkerRuntime implements AgentRuntime {
  private readonly runtimeStore: RuntimeStore;

  constructor(
    private readonly ctx: ProjectContext,
    private readonly client: ACPClient = new LocalACPClient(),
  ) {
    this.runtimeStore = new RuntimeStore(ctx);
  }

  async ensureSession(
    slot: string,
    tool?: ACPTool,
    cwdOverride?: string,
    opts?: {
      mcpServers?: import('../interfaces/ACPClient.js').McpServerConfig[];
      extraEnv?: Record<string, string>;
    },
  ): Promise<ACPSessionRecord> {
    const state = this.runtimeStore.readACPState();
    const normalizedSlot = this.normalizeSlot(slot);
    const selectedTool = tool || this.defaultTool();
    const existing = state.sessions[normalizedSlot];
    const sessionName = existing?.sessionName || this.buildSessionName(normalizedSlot);
    const cwd = cwdOverride || existing?.cwd || this.ctx.paths.repoDir;
    const resetExisting = !existing || (!!cwdOverride && existing.cwd !== cwdOverride);
    const retainedRun = resetExisting ? null : (existing?.currentRun || null);

    const result = await this.client.ensureSession({
      sessionName,
      tool: selectedTool,
      cwd,
      resetExisting,
      logsDir: this.ctx.paths.logsDir,
      mcpServers: opts?.mcpServers,
      extraEnv: opts?.extraEnv,
    });

    const session = this.upsertSession(state, normalizedSlot, {
      slot: normalizedSlot,
      tool: selectedTool,
      sessionId: result.sessionId,
      sessionName,
      pid: result.pid ?? existing?.pid ?? null,
      cwd,
      status: result.sessionState === 'ready'
        ? (retainedRun ? 'active' : 'idle')
        : 'launching',
      sessionState: result.sessionState,
      currentRun: retainedRun,
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
      lastSeenAt: result.lastSeenAt,
      lastPaneText: result.paneText,
      pendingInput: null,
    });

    this.runtimeStore.updateACPState('acp-ensure-session', (draft) => {
      draft.sessions[normalizedSlot] = session;
    });
    return session;
  }

  async startRun(
    slot: string,
    prompt: string,
    tool?: ACPTool,
    cwdOverride?: string,
    opts?: { extraEnv?: Record<string, string> },
  ): Promise<ACPSessionRecord> {
    const normalizedSlot = this.normalizeSlot(slot);
    const _state = this.runtimeStore.readACPState();
    const session = await this.ensureSession(normalizedSlot, tool, cwdOverride, { extraEnv: opts?.extraEnv });
    if (session.sessionState !== 'ready') {
      throw new Error(`ACP session ${session.sessionId} is not ready (state=${session.sessionState})`);
    }
    const freshState = this.runtimeStore.readACPState();
    const existing = freshState.sessions[normalizedSlot] || session;
    return this.launchRun(freshState, normalizedSlot, existing, prompt, 'acp-start-run');
  }

  async resumeRun(slot: string, prompt: string): Promise<ACPSessionRecord> {
    const normalizedSlot = this.normalizeSlot(slot);
    const inspected = await this.inspect(normalizedSlot);
    const existing = inspected.sessions[normalizedSlot];
    if (!existing) {
      throw new Error(`ACP session not found for slot ${normalizedSlot}`);
    }
    if (existing.sessionState === 'offline') {
      throw new Error(`ACP session ${existing.sessionId} is offline`);
    }
    if (existing.sessionState !== 'ready') {
      throw new Error(`ACP session ${existing.sessionId} is not ready for resume (state=${existing.sessionState})`);
    }
    return this.launchRun(inspected, normalizedSlot, existing, prompt, 'acp-resume-run');
  }

  async inspect(slot?: string): Promise<ACPState> {
    const state = this.runtimeStore.readACPState();
    const slots = slot ? [this.normalizeSlot(slot)] : Object.keys(state.sessions);

    for (const slotName of slots) {
      const session = state.sessions[slotName];
      if (!session) continue;

      const sessionInfo = await this.client.inspectSession({
        sessionName: session.sessionName,
        tool: session.tool,
        pid: session.pid,
      });

      let nextStatus: ACPSlotStatus = session.status;
      let currentRun = session.currentRun;
      let paneText = sessionInfo.paneText;

      if (session.currentRun && !(sessionInfo.sessionState === 'offline' && isTerminalRunStatus(session.currentRun.status))) {
        const runInfo = await this.client.inspectRun({
          sessionName: session.sessionName,
          tool: session.tool,
          activeRun: true,
          pid: session.pid,
        });
        paneText = runInfo.paneText || paneText;
        if (runInfo.runState) {
          currentRun = {
            ...session.currentRun,
            status: runInfo.runState,
            updatedAt: now(),
            completedAt: runInfo.runState === 'completed' ? (session.currentRun.completedAt || now()) : session.currentRun.completedAt,
          };
          nextStatus = this.slotStatusFromRun(runInfo.runState);
        }
      } else if (sessionInfo.sessionState === 'ready') {
        nextStatus = 'idle';
      } else if (sessionInfo.sessionState === 'offline') {
        nextStatus = 'offline';
      } else {
        nextStatus = 'launching';
      }

      state.sessions[slotName] = {
        ...session,
        status: nextStatus,
        sessionState: sessionInfo.sessionState,
        currentRun,
        updatedAt: now(),
        lastSeenAt: sessionInfo.lastSeenAt,
        lastOutputAt: paneText ? now() : session.lastOutputAt,
        lastPaneText: paneText,
        pendingInput: null,
      };
    }

    this.runtimeStore.updateACPState('acp-inspect', (draft) => {
      draft.sessions = state.sessions;
    });
    return state;
  }

  async stopSession(slot: string): Promise<void> {
    const normalizedSlot = this.normalizeSlot(slot);
    const state = this.runtimeStore.readACPState();
    const session = state.sessions[normalizedSlot];
    if (!session) {
      throw new Error(`ACP session not found for slot ${normalizedSlot}`);
    }

    await this.client.stopSession({
      sessionName: session.sessionName,
      tool: session.tool,
    });

    state.sessions[normalizedSlot] = {
      ...session,
      status: 'offline',
      sessionState: 'offline',
      currentRun: session.currentRun
        ? {
            ...session.currentRun,
            status: session.currentRun.status === 'completed' ? 'completed' : 'cancelled',
            updatedAt: now(),
            completedAt: session.currentRun.completedAt || now(),
          }
        : null,
      updatedAt: now(),
      lastSeenAt: now(),
      lastPaneText: '',
      pendingInput: null,
    };

    this.runtimeStore.updateACPState('acp-stop-session', (draft) => {
      draft.sessions[normalizedSlot] = state.sessions[normalizedSlot];
    });
  }

  private normalizeSlot(slot: string): string {
    if (/^worker-\d+$/.test(slot)) return slot;
    if (/^\d+$/.test(slot)) return `worker-${slot}`;
    if (/^session-/.test(slot)) return slot;  // harness mode session namespace
    throw new Error(`Invalid slot: ${slot}. Use worker-N, N, or session-<name>`);
  }

  private defaultTool(): ACPTool {
    return 'claude';
  }

  subscribe(slot: string, listener: import('../interfaces/ACPClient.js').AccumulatorListener): () => void {
    const normalizedSlot = this.normalizeSlot(slot);
    const sessionName = this.buildSessionName(normalizedSlot);
    return this.client.subscribe(sessionName, listener);
  }

  async cancelRun(slot: string): Promise<void> {
    const normalizedSlot = this.normalizeSlot(slot);
    const sessionName = this.buildSessionName(normalizedSlot);
    return this.client.cancelRun(sessionName);
  }

  private buildSessionName(slot: string): string {
    if (slot.startsWith('session-')) return `sps-${slot}`;
    return `sps-acp-${this.ctx.projectName}-${slot}`;
  }

  private slotStatusFromRun(status: ACPRunRecord['status']): ACPSlotStatus {
    switch (status) {
      case 'completed':
      case 'cancelled':
      case 'failed':
      case 'lost':
        return 'idle';
      default:
        return 'active';
    }
  }

  private upsertSession(
    state: ACPState,
    slot: string,
    session: ACPSessionRecord,
  ): ACPSessionRecord {
    state.sessions[slot] = session;
    return session;
  }

  private async launchRun(
    state: ACPState,
    slot: string,
    session: ACPSessionRecord,
    prompt: string,
    updatedBy: string,
  ): Promise<ACPSessionRecord> {
    if (session.currentRun && !isTerminalRunStatus(session.currentRun.status)) {
      throw new Error(`Slot ${slot} already has an active run (${session.currentRun.runId})`);
    }

    const result = await this.client.startRun({
      sessionName: session.sessionName,
      tool: session.tool,
      prompt,
    });

    const run: ACPRunRecord = {
      runId: result.runId,
      status: result.runState,
      promptPreview: previewPrompt(prompt),
      startedAt: now(),
      updatedAt: now(),
      completedAt: result.runState === 'completed' ? now() : null,
    };

    const updated = this.upsertSession(state, slot, {
      ...session,
      status: this.slotStatusFromRun(result.runState),
      sessionState: result.runState === 'completed' ? 'ready' : 'busy',
      currentRun: run,
      updatedAt: now(),
      lastSeenAt: result.lastSeenAt,
      lastPaneText: result.paneText,
      pendingInput: null,
    });

    this.runtimeStore.updateACPState(updatedBy, (draft) => {
      draft.sessions[slot] = updated;
    });
    return updated;
  }
}
