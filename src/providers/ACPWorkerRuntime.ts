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

  async ensureSession(slot: string, tool?: ACPTool): Promise<ACPSessionRecord> {
    const state = readACPState(this.ctx.paths.acpStateFile);
    const normalizedSlot = this.normalizeSlot(slot);
    const selectedTool = tool || this.defaultTool();
    const existing = state.sessions[normalizedSlot];
    const sessionName = existing?.sessionName || this.buildSessionName(normalizedSlot);
    const cwd = existing?.cwd || this.ctx.paths.repoDir;

    const result = await this.client.ensureSession({
      sessionName,
      tool: selectedTool,
      cwd,
      resetExisting: !existing,
    });

    const session = this.upsertSession(state, normalizedSlot, {
      slot: normalizedSlot,
      tool: selectedTool,
      sessionId: result.sessionId,
      sessionName,
      cwd,
      status: result.sessionState === 'ready'
        ? (existing?.currentRun ? 'active' : 'idle')
        : 'launching',
      sessionState: result.sessionState,
      currentRun: existing?.currentRun || null,
      createdAt: existing?.createdAt || now(),
      updatedAt: now(),
      lastSeenAt: result.lastSeenAt,
      lastPaneText: result.paneText,
    });

    writeACPState(this.ctx.paths.acpStateFile, state, 'acp-ensure-session');
    return session;
  }

  async startRun(slot: string, prompt: string, tool?: ACPTool): Promise<ACPSessionRecord> {
    const normalizedSlot = this.normalizeSlot(slot);
    const state = readACPState(this.ctx.paths.acpStateFile);
    const session = await this.ensureSession(normalizedSlot, tool);
    if (session.sessionState !== 'ready') {
      throw new Error(`ACP session ${session.sessionId} is not ready (state=${session.sessionState})`);
    }
    const freshState = readACPState(this.ctx.paths.acpStateFile);
    const existing = freshState.sessions[normalizedSlot] || session;

    if (existing.currentRun && !['completed', 'failed', 'cancelled', 'lost'].includes(existing.currentRun.status)) {
      throw new Error(`Slot ${normalizedSlot} already has an active run (${existing.currentRun.runId})`);
    }

    const result = await this.client.startRun({
      sessionName: existing.sessionName,
      tool: existing.tool,
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

    const updated = this.upsertSession(freshState, normalizedSlot, {
      ...existing,
      status: this.slotStatusFromRun(result.runState),
      sessionState: result.runState === 'completed' ? 'ready' : 'busy',
      currentRun: run,
      updatedAt: now(),
      lastSeenAt: result.lastSeenAt,
      lastPaneText: result.paneText,
    });

    writeACPState(this.ctx.paths.acpStateFile, freshState, 'acp-start-run');
    return updated;
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
}
