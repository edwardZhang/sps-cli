import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const HOME = process.env.HOME || '/home/coral';

export interface ProjectPaths {
  /** ~/.projects/<project>/ */
  instanceDir: string;
  /** ~/.projects/<project>/conf */
  confFile: string;
  /** ~/.projects/<project>/logs/ */
  logsDir: string;
  /** ~/.projects/<project>/runtime/ */
  runtimeDir: string;
  /** ~/.projects/<project>/runtime/state.json */
  stateFile: string;
  /** ~/.projects/<project>/runtime/tick.lock */
  tickLockFile: string;
  /** ~/.projects/<project>/pm_meta/ */
  pmMetaDir: string;
  /** ~/.projects/<project>/pipeline_order.json */
  pipelineOrderFile: string;
  /** ~/projects/<project>/ (business repo) */
  repoDir: string;
  /** ~/.openclaw/workspace/worktrees/<project>/ */
  worktreeRoot: string;
}

export function resolveProjectPaths(projectName: string): ProjectPaths {
  const instanceDir = resolve(HOME, '.projects', projectName);
  const runtimeDir = resolve(instanceDir, 'runtime');

  return {
    instanceDir,
    confFile: resolve(instanceDir, 'conf'),
    logsDir: resolve(instanceDir, 'logs'),
    runtimeDir,
    stateFile: resolve(runtimeDir, 'state.json'),
    tickLockFile: resolve(runtimeDir, 'tick.lock'),
    pmMetaDir: resolve(instanceDir, 'pm_meta'),
    pipelineOrderFile: resolve(instanceDir, 'pipeline_order.json'),
    repoDir: resolve(HOME, 'projects', projectName),
    worktreeRoot: resolve(HOME, '.openclaw', 'workspace', 'worktrees', projectName),
  };
}

export function resolveWorktreePath(projectName: string, seq: string | number): string {
  return resolve(HOME, '.openclaw', 'workspace', 'worktrees', projectName, String(seq));
}

export function resolveWorkerCardFile(projectName: string, slot: number): string {
  return resolve(HOME, '.projects', projectName, `worker-${slot}.card`);
}

export function checkPathExists(path: string): boolean {
  return existsSync(path);
}
