import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { sourceCombinedConf as sourceCombinedConfImpl, sourceShellConf } from './shellEnv.js';

/** Cache for resolved GitLab project IDs to avoid repeated API calls */
const gitlabIdCache = new Map<string, string>();

export interface RawConfig {
  [key: string]: string;
}

export interface ProjectConfig {
  // Project basics
  PROJECT_NAME: string;
  PROJECT_DIR?: string;

  // GitLab
  GITLAB_PROJECT: string;
  GITLAB_PROJECT_ID: string;
  GITLAB_MERGE_BRANCH: string;

  // PM backend
  PM_TOOL: 'trello' | 'plane' | 'markdown';

  // Pipeline
  PIPELINE_LABEL?: string;
  MR_MODE: 'none' | 'create';

  // Worker
  WORKER_TOOL: 'claude' | 'codex';
  WORKER_TRANSPORT: 'acp-sdk';
  MAX_CONCURRENT_WORKERS: number;
  WORKER_RESTART_LIMIT: number;
  MAX_ACTIONS_PER_TICK: number;
  ACP_AGENT?: 'claude' | 'codex';

  // Worker health
  WORKER_LAUNCH_TIMEOUT_S: number;
  WORKER_IDLE_TIMEOUT_M: number;

  // Timeouts & policies
  INPROGRESS_TIMEOUT_HOURS: number;
  MONITOR_AUTO_QA: boolean;
  CONFLICT_DEFAULT: 'serial' | 'parallel';
  TICK_LOCK_TIMEOUT_MINUTES: number;

  // Paths (overridable)
  WORKTREE_DIR?: string;

  // Raw values (for PM-specific fields like TRELLO_BOARD_ID, PLANE_STATE_*, etc.)
  raw: RawConfig;
}

/**
 * Resolve the worker transport for SPS workflow execution.
 * Always returns 'acp-sdk' — the only supported transport.
 * Legacy 'acp' alias is mapped to 'acp-sdk'.
 */
export function resolveWorkflowTransport(_config: ProjectConfig): 'acp-sdk' {
  return 'acp-sdk';
}

const REQUIRED_FIELDS = [
  'PROJECT_NAME',
  'GITLAB_PROJECT',
  'GITLAB_MERGE_BRANCH',
] as const;

export function loadGlobalEnv(): RawConfig {
  const envPath = resolve(process.env.HOME || '~', '.coral', 'env');
  if (!existsSync(envPath)) return {};
  return sourceShellConf(envPath);
}

export function loadProjectConf(projectName: string): ProjectConfig {
  const confPath = resolve(
    process.env.HOME || '~',
    '.coral',
    'projects',
    projectName,
    'conf'
  );

  if (!existsSync(confPath)) {
    throw new Error(`Project conf not found: ${confPath}`);
  }

  // Source global env + project conf together in one bash context
  // so that conf can reference variables from ~/.coral/env (e.g., ${PLANE_URL})
  const envPath = resolve(process.env.HOME || '~', '.coral', 'env');
  const raw = sourceCombinedConfImpl([envPath, confPath]);

  // Strip unreplaced template placeholders (__FOO__) — treat as empty
  for (const key of Object.keys(raw)) {
    if (raw[key] && /^__[A-Z_]+__$/.test(raw[key])) {
      raw[key] = '';
    }
  }

  return {
    PROJECT_NAME: raw.PROJECT_NAME || projectName,
    PROJECT_DIR: raw.PROJECT_DIR,

    GITLAB_PROJECT: raw.GITLAB_PROJECT || '',
    GITLAB_PROJECT_ID: raw.GITLAB_PROJECT_ID || '',
    GITLAB_MERGE_BRANCH: raw.GITLAB_MERGE_BRANCH || 'develop',

    PM_TOOL: (raw.PM_TOOL as ProjectConfig['PM_TOOL']) || 'trello',

    PIPELINE_LABEL: raw.PIPELINE_LABEL,
    MR_MODE: (raw.MR_MODE as ProjectConfig['MR_MODE']) || 'none',

    WORKER_TOOL: (raw.WORKER_TOOL as ProjectConfig['WORKER_TOOL']) || 'claude',
    WORKER_TRANSPORT: (raw.WORKER_TRANSPORT as ProjectConfig['WORKER_TRANSPORT']) || 'acp-sdk',
    MAX_CONCURRENT_WORKERS: parseInt(raw.MAX_CONCURRENT_WORKERS || '3', 10),
    WORKER_RESTART_LIMIT: parseInt(raw.WORKER_RESTART_LIMIT || '2', 10),
    MAX_ACTIONS_PER_TICK: parseInt(raw.MAX_ACTIONS_PER_TICK || '1', 10),
    ACP_AGENT: raw.ACP_AGENT as ProjectConfig['ACP_AGENT'] | undefined,

    WORKER_LAUNCH_TIMEOUT_S: parseInt(raw.WORKER_LAUNCH_TIMEOUT_S || '300', 10),
    WORKER_IDLE_TIMEOUT_M: parseInt(raw.WORKER_IDLE_TIMEOUT_M || '15', 10),

    INPROGRESS_TIMEOUT_HOURS: parseInt(raw.INPROGRESS_TIMEOUT_HOURS || '8', 10),
    MONITOR_AUTO_QA: raw.MONITOR_AUTO_QA === 'true',
    CONFLICT_DEFAULT: (raw.CONFLICT_DEFAULT as 'serial' | 'parallel') || 'serial',
    TICK_LOCK_TIMEOUT_MINUTES: parseInt(raw.TICK_LOCK_TIMEOUT_MINUTES || '30', 10),

    WORKTREE_DIR: raw.WORKTREE_DIR,

    raw,
  };
}

export function validateConfig(config: ProjectConfig): { field: string; message: string }[] {
  const errors: { field: string; message: string }[] = [];
  for (const field of REQUIRED_FIELDS) {
    if (!config[field]) {
      errors.push({ field, message: `Required field ${field} is missing or empty` });
    }
  }
  return errors;
}

/**
 * Resolve GITLAB_PROJECT_ID from GITLAB_PROJECT path via GitLab API.
 * Called lazily when the ID is needed but not configured.
 * Results are cached per GITLAB_PROJECT path.
 */
export function resolveGitlabProjectId(config: ProjectConfig): string {
  // If already set, return as-is
  if (config.GITLAB_PROJECT_ID) return config.GITLAB_PROJECT_ID;

  const gitlabProject = config.GITLAB_PROJECT;
  if (!gitlabProject) return '';

  // Check cache
  const cached = gitlabIdCache.get(gitlabProject);
  if (cached) return cached;

  const gitlabUrl = config.raw.GITLAB_URL || '';
  const gitlabToken = config.raw.GITLAB_TOKEN || '';
  if (!gitlabUrl || !gitlabToken) return '';

  try {
    const encoded = encodeURIComponent(gitlabProject);
    const output = execSync(
      `curl -sf -H "PRIVATE-TOKEN: ${gitlabToken}" "${gitlabUrl}/api/v4/projects/${encoded}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 10_000 },
    );
    const data = JSON.parse(output);
    const id = String(data.id || '');
    if (id) {
      // Cache and backfill into config
      gitlabIdCache.set(gitlabProject, id);
      config.GITLAB_PROJECT_ID = id;
      config.raw.GITLAB_PROJECT_ID = id;
    }
    return id;
  } catch {
    return '';
  }
}
