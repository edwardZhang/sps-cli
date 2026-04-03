import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const HOME = process.env.HOME || '/home/coral';

export interface ProjectPaths {
  /** ~/.coral/projects/<project>/ */
  instanceDir: string;
  /** ~/.coral/projects/<project>/conf */
  confFile: string;
  /** ~/.coral/projects/<project>/logs/ */
  logsDir: string;
  /** ~/.coral/projects/<project>/runtime/ */
  runtimeDir: string;
  /** ~/.coral/projects/<project>/runtime/state.json */
  stateFile: string;
  /** ~/.coral/projects/<project>/runtime/acp-state.json */
  acpStateFile: string;
  /** ~/.coral/projects/<project>/runtime/tick.lock */
  tickLockFile: string;
  /** ~/.coral/projects/<project>/pm_meta/ */
  pmMetaDir: string;
  /** ~/.coral/projects/<project>/pipeline_order.json */
  pipelineOrderFile: string;
  /** Business repo directory (configurable via PROJECT_DIR, default: ~/projects/<project>/) */
  repoDir: string;
  /** Worktree root (configurable via WORKTREE_DIR, default: ~/.coral/worktrees/<project>/) */
  worktreeRoot: string;
}

export interface PathOverrides {
  /** Override business repo path (from conf PROJECT_DIR) */
  projectDir?: string;
  /** Override worktree root path (from conf WORKTREE_DIR) */
  worktreeDir?: string;
}

export function resolveProjectPaths(projectName: string, overrides?: PathOverrides): ProjectPaths {
  const instanceDir = resolve(HOME, '.coral', 'projects', projectName);
  const runtimeDir = resolve(instanceDir, 'runtime');

  const repoDir = overrides?.projectDir
    ? resolve(overrides.projectDir)
    : resolve(HOME, 'projects', projectName);

  const worktreeRoot = overrides?.worktreeDir
    ? resolve(overrides.worktreeDir, projectName)
    : resolve(HOME, '.coral', 'worktrees', projectName);

  return {
    instanceDir,
    confFile: resolve(instanceDir, 'conf'),
    logsDir: resolve(instanceDir, 'logs'),
    runtimeDir,
    stateFile: resolve(runtimeDir, 'state.json'),
    acpStateFile: resolve(runtimeDir, 'acp-state.json'),
    tickLockFile: resolve(runtimeDir, 'tick.lock'),
    pmMetaDir: resolve(instanceDir, 'pm_meta'),
    pipelineOrderFile: resolve(instanceDir, 'pipeline_order.json'),
    repoDir,
    worktreeRoot,
  };
}

export function resolveWorktreePath(projectName: string, seq: string | number, worktreeDir?: string): string {
  const root = worktreeDir
    ? resolve(worktreeDir, projectName)
    : resolve(HOME, '.coral', 'worktrees', projectName);
  return resolve(root, String(seq));
}

export function resolveWorkerCardFile(projectName: string, slot: number): string {
  return resolve(HOME, '.coral', 'projects', projectName, `worker-${slot}.card`);
}

export interface SessionPaths {
  /** ~/.coral/sessions/ */
  stateDir: string;
  /** ~/.coral/sessions/logs/ */
  logsDir: string;
  /** ~/.coral/sessions/state.json */
  stateFile: string;
}

export function resolveSessionPaths(): SessionPaths {
  const stateDir = resolve(HOME, '.coral', 'sessions');
  return {
    stateDir,
    logsDir: resolve(stateDir, 'logs'),
    stateFile: resolve(stateDir, 'state.json'),
  };
}

export function checkPathExists(path: string): boolean {
  return existsSync(path);
}
