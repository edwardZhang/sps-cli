import { basename } from 'node:path';
import type { ProjectContext } from '../core/context.js';
import { readACPState, writeACPState } from '../core/acpState.js';
import type { AgentRuntime } from '../interfaces/AgentRuntime.js';
import type { ACPClient } from '../interfaces/ACPClient.js';
import type {
  ACPRunRecord,
  ACPState,
  ACPSessionRecord,
  ACPSessionStatus,
  ACPSlotStatus,
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
  constructor(
    private readonly ctx: ProjectContext,
    private readonly client: ACPClient = new LocalACPClient(),
  ) {}

  async ensureSession(slot: string, tool?: ACPTool, cwdOverride?: string): Promise<ACPSessionRecord> {
    const state = readACPState(this.ctx.paths.acpStateFile);
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
    });

    const session = this.upsertSession(state, normalizedSlot, {
      slot: normalizedSlot,
      tool: selectedTool,
      sessionId: result.sessionId,
      sessionName,
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

    writeACPState(this.ctx.paths.acpStateFile, state, 'acp-ensure-session');
    return session;
  }

  async startRun(slot: string, prompt: string, tool?: ACPTool, cwdOverride?: string): Promise<ACPSessionRecord> {
    const normalizedSlot = this.normalizeSlot(slot);
    const state = readACPState(this.ctx.paths.acpStateFile);
    const session = await this.ensureSession(normalizedSlot, tool, cwdOverride);
    if (session.sessionState !== 'ready') {
      throw new Error(`ACP session ${session.sessionId} is not ready (state=${session.sessionState})`);
    }
    const freshState = readACPState(this.ctx.paths.acpStateFile);
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
    const state = readACPState(this.ctx.paths.acpStateFile);
    const slots = slot ? [this.normalizeSlot(slot)] : Object.keys(state.sessions);

    for (const slotName of slots) {
      const session = state.sessions[slotName];
      if (!session) continue;

      const sessionInfo = await this.client.inspectSession({
        sessionName: session.sessionName,
        tool: session.tool,
      });

      let nextStatus: ACPSlotStatus = session.status;
      let currentRun = session.currentRun;
      let paneText = sessionInfo.paneText;

      if (session.currentRun && !(sessionInfo.sessionState === 'offline' && isTerminalRunStatus(session.currentRun.status))) {
        const runInfo = await this.client.inspectRun({
          sessionName: session.sessionName,
          tool: session.tool,
          activeRun: true,
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
        lastPaneText: paneText,
      pendingInput: null,
      };
    }

    writeACPState(this.ctx.paths.acpStateFile, state, 'acp-inspect');
    return state;
  }

  async stopSession(slot: string): Promise<void> {
    const normalizedSlot = this.normalizeSlot(slot);
    const state = readACPState(this.ctx.paths.acpStateFile);
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

    writeACPState(this.ctx.paths.acpStateFile, state, 'acp-stop-session');
  }

  private normalizeSlot(slot: string): string {
    if (/^worker-\d+$/.test(slot)) return slot;
    if (/^\d+$/.test(slot)) return `worker-${slot}`;
    throw new Error(`Invalid slot: ${slot}. Use worker-N or N`);
  }

  private defaultTool(): ACPTool {
    return (this.ctx.config.ACP_AGENT || this.ctx.config.WORKER_TOOL) as ACPTool;
  }

  private buildSessionName(slot: string): string {
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

    writeACPState(this.ctx.paths.acpStateFile, state, updatedBy);
    return updated;
  }
}
