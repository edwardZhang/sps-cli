import { existsSync, readFileSync } from 'node:fs';
import { RuntimeCoordinator } from '../manager/runtime-coordinator.js';
import type { ACPState } from '../models/acp.js';
import { createTaskBackend } from '../providers/registry.js';
import { ProjectContext } from './context.js';
import { isProcessAlive } from './sessionLiveness.js';
import { type RuntimeState, readState } from './state.js';

export interface ProjectRuntimeSnapshot {
  ctx: ProjectContext;
  tickRunning: boolean;
  state: RuntimeState;
  /** @deprecated Use state.sessions instead. Compat view backed by state.sessions. */
  acpState: ACPState;
}

export interface LoadRuntimeSnapshotOptions {
  projectWhenTickStopped?: boolean;
}

function detectTickRunning(ctx: ProjectContext): boolean {
  if (!existsSync(ctx.paths.tickLockFile)) return false;
  try {
    const lock = JSON.parse(readFileSync(ctx.paths.tickLockFile, 'utf-8')) as { pid?: number };
    return !!(lock.pid && isProcessAlive(lock.pid));
  } catch {
    return false;
  }
}

export async function loadRuntimeSnapshot(
  projectName: string,
  options: LoadRuntimeSnapshotOptions = {},
): Promise<ProjectRuntimeSnapshot> {
  const ctx = ProjectContext.load(projectName);
  const tickRunning = detectTickRunning(ctx);
  const projectWhenTickStopped = options.projectWhenTickStopped ?? true;

  if (tickRunning || !projectWhenTickStopped) {
    const state = readState(ctx.paths.stateFile, ctx.maxWorkers);
    return {
      ctx,
      tickRunning,
      state,
      acpState: { version: state.version, updatedAt: state.updatedAt, updatedBy: state.updatedBy, sessions: state.sessions },
    };
  }

  const taskBackend = createTaskBackend(ctx.config);
  const coordinator = new RuntimeCoordinator(ctx, taskBackend);
  const { state: projectedState } = await coordinator.buildRuntimeProjection();
  return {
    ctx,
    tickRunning,
    state: projectedState,
    acpState: { version: projectedState.version, updatedAt: projectedState.updatedAt, updatedBy: projectedState.updatedBy, sessions: projectedState.sessions },
  };
}
