import { existsSync, readFileSync } from 'node:fs';
import { ProjectContext } from './context.js';
import { readACPState } from './acpState.js';
import { readState, type RuntimeState } from './state.js';
import { isProcessAlive } from './sessionLiveness.js';
import type { ACPState } from '../models/acp.js';
import { createTaskBackend } from '../providers/registry.js';
import { RuntimeCoordinator } from '../manager/runtime-coordinator.js';

export interface ProjectRuntimeSnapshot {
  ctx: ProjectContext;
  tickRunning: boolean;
  state: RuntimeState;
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
    return {
      ctx,
      tickRunning,
      state: readState(ctx.paths.stateFile, ctx.maxWorkers),
      acpState: readACPState(ctx.paths.acpStateFile),
    };
  }

  const taskBackend = createTaskBackend(ctx.config);
  const coordinator = new RuntimeCoordinator(ctx, taskBackend);
  const projected = await coordinator.buildRuntimeProjection();
  return {
    ctx,
    tickRunning,
    state: projected.state,
    acpState: projected.acpState,
  };
}
