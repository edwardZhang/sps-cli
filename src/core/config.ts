import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { execSync } from 'node:child_process';

/** Cache for resolved GitLab project IDs to avoid repeated API calls */
const gitlabIdCache = new Map<string, string>();

export interface RawConfig {
  [key: string]: string;
}

/**
 * Parse a shell conf file (KEY=value / export KEY=value) into a plain object.
 * Does NOT execute the file — only extracts simple assignments.
 * For complex interpolations ($HOME etc.), falls back to sourcing via bash.
 */
function parseShellConf(filePath: string): RawConfig {
  const result: RawConfig = {};
  const content = readFileSync(filePath, 'utf-8');

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Match: export KEY="value" | export KEY='value' | export KEY=value | KEY=value
    const match = trimmed.match(
      /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=["']?(.*?)["']?\s*$/
    );
    if (match) {
      result[match[1]] = match[2];
    }
  }
  return result;
}

/**
 * Source a shell file via bash and capture all exported variables.
 * More reliable than regex parsing for files with $HOME, ${VAR} etc.
 */
function sourceShellConf(filePath: string): RawConfig {
  try {
    const output = execSync(
      `bash -c 'set -a; source "${filePath}" 2>/dev/null; env'`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    const result: RawConfig = {};
    for (const line of output.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        result[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    return result;
  } catch {
    // Fallback to regex parsing
    return parseShellConf(filePath);
  }
}

/**
 * Source global env + project conf in a single bash context,
 * so conf can reference variables from .jarvis.env (e.g., ${PLANE_URL}).
 */
function sourceCombinedConf(envPath: string, confPath: string): RawConfig {
  const sources: string[] = [];
  if (existsSync(envPath)) sources.push(`source "${envPath}" 2>/dev/null`);
  sources.push(`source "${confPath}" 2>/dev/null`);

  try {
    const output = execSync(
      `bash -c 'set -a; ${sources.join('; ')}; env'`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    const result: RawConfig = {};
    for (const line of output.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        result[line.slice(0, idx)] = line.slice(idx + 1);
      }
    }
    return result;
  } catch {
    // Fallback: load separately and merge
    const globalEnv = existsSync(envPath) ? sourceShellConf(envPath) : {};
    const projectRaw = sourceShellConf(confPath);
    return { ...globalEnv, ...projectRaw };
  }
}

export interface ProjectConfig {
  // Project basics
  PROJECT_NAME: string;
  PROJECT_DISPLAY: string;
  PROJECT_DIR?: string;

  // GitLab
  GITLAB_PROJECT: string;
  GITLAB_PROJECT_ID: string;
  GITLAB_MERGE_BRANCH: string;
  GITLAB_RELEASE_BRANCH: string;

  // PM backend
  PM_TOOL: 'trello' | 'plane' | 'markdown';

  // Pipeline
  PIPELINE_LABEL?: string;
  PIPELINE_ORDER_FILE?: string;
  CI_MODE: 'gitlab' | 'local' | 'none';
  MR_MODE: 'none' | 'create';

  // Worker
  WORKER_TOOL: 'claude' | 'codex';
  WORKER_MODE: 'print' | 'interactive';
  MAX_CONCURRENT_WORKERS: number;
  WORKER_RESTART_LIMIT: number;
  AUTOFIX_ATTEMPTS: number;
  WORKER_SESSION_REUSE: boolean;
  MAX_ACTIONS_PER_TICK: number;

  // Worker health
  WORKER_LAUNCH_TIMEOUT_S: number;
  WORKER_IDLE_TIMEOUT_M: number;

  // Timeouts & policies
  INPROGRESS_TIMEOUT_HOURS: number;
  MONITOR_AUTO_QA: boolean;
  CONFLICT_DEFAULT: 'serial' | 'parallel';
  TICK_LOCK_TIMEOUT_MINUTES: number;
  NEEDS_FIX_MAX_RETRIES: number;
  WORKTREE_RETAIN_HOURS: number;

  // Paths (overridable)
  WORKTREE_DIR?: string;

  // Deploy
  DEPLOY_ENABLED: boolean;
  DEPLOY_SCRIPT?: string;

  // Raw values (for PM-specific fields like TRELLO_BOARD_ID, PLANE_STATE_*, etc.)
  raw: RawConfig;
}

const REQUIRED_FIELDS = [
  'PROJECT_NAME',
  'GITLAB_PROJECT',
  'GITLAB_MERGE_BRANCH',
] as const;

export function loadGlobalEnv(): RawConfig {
  const envPath = resolve(process.env.HOME || '~', '.jarvis.env');
  if (!existsSync(envPath)) return {};
  return sourceShellConf(envPath);
}

export function loadProjectConf(projectName: string): ProjectConfig {
  const confPath = resolve(
    process.env.HOME || '~',
    '.projects',
    projectName,
    'conf'
  );

  if (!existsSync(confPath)) {
    throw new Error(`Project conf not found: ${confPath}`);
  }

  // Source global env + project conf together in one bash context
  // so that conf can reference variables from .jarvis.env (e.g., ${PLANE_URL})
  const envPath = resolve(process.env.HOME || '~', '.jarvis.env');
  const raw = sourceCombinedConf(envPath, confPath);

  // Strip unreplaced template placeholders (__FOO__) — treat as empty
  for (const key of Object.keys(raw)) {
    if (raw[key] && /^__[A-Z_]+__$/.test(raw[key])) {
      raw[key] = '';
    }
  }

  return {
    PROJECT_NAME: raw.PROJECT_NAME || projectName,
    PROJECT_DISPLAY: raw.PROJECT_DISPLAY || raw.PROJECT_NAME || projectName,
    PROJECT_DIR: raw.PROJECT_DIR,

    GITLAB_PROJECT: raw.GITLAB_PROJECT || '',
    GITLAB_PROJECT_ID: raw.GITLAB_PROJECT_ID || '',
    GITLAB_MERGE_BRANCH: raw.GITLAB_MERGE_BRANCH || 'develop',
    GITLAB_RELEASE_BRANCH: raw.GITLAB_RELEASE_BRANCH || 'main',

    PM_TOOL: (raw.PM_TOOL as ProjectConfig['PM_TOOL']) || 'trello',

    PIPELINE_LABEL: raw.PIPELINE_LABEL,
    PIPELINE_ORDER_FILE: raw.PIPELINE_ORDER_FILE,
    CI_MODE: (raw.CI_MODE as ProjectConfig['CI_MODE']) || 'none',
    MR_MODE: (raw.MR_MODE as ProjectConfig['MR_MODE']) || 'none',

    WORKER_TOOL: (raw.WORKER_TOOL as ProjectConfig['WORKER_TOOL']) || 'claude',
    WORKER_MODE: (raw.WORKER_MODE as ProjectConfig['WORKER_MODE']) || 'print',
    MAX_CONCURRENT_WORKERS: parseInt(raw.MAX_CONCURRENT_WORKERS || '3', 10),
    WORKER_RESTART_LIMIT: parseInt(raw.WORKER_RESTART_LIMIT || '2', 10),
    AUTOFIX_ATTEMPTS: parseInt(raw.AUTOFIX_ATTEMPTS || '2', 10),
    WORKER_SESSION_REUSE: raw.WORKER_SESSION_REUSE !== 'false',
    MAX_ACTIONS_PER_TICK: parseInt(raw.MAX_ACTIONS_PER_TICK || '1', 10),

    WORKER_LAUNCH_TIMEOUT_S: parseInt(raw.WORKER_LAUNCH_TIMEOUT_S || '120', 10),
    WORKER_IDLE_TIMEOUT_M: parseInt(raw.WORKER_IDLE_TIMEOUT_M || '15', 10),

    INPROGRESS_TIMEOUT_HOURS: parseInt(raw.INPROGRESS_TIMEOUT_HOURS || '8', 10),
    MONITOR_AUTO_QA: raw.MONITOR_AUTO_QA === 'true',
    CONFLICT_DEFAULT: (raw.CONFLICT_DEFAULT as 'serial' | 'parallel') || 'serial',
    TICK_LOCK_TIMEOUT_MINUTES: parseInt(raw.TICK_LOCK_TIMEOUT_MINUTES || '30', 10),
    NEEDS_FIX_MAX_RETRIES: parseInt(raw.NEEDS_FIX_MAX_RETRIES || '3', 10),
    WORKTREE_RETAIN_HOURS: parseInt(raw.WORKTREE_RETAIN_HOURS || '24', 10),

    WORKTREE_DIR: raw.WORKTREE_DIR,

    DEPLOY_ENABLED: raw.DEPLOY_ENABLED === 'true',
    DEPLOY_SCRIPT: raw.DEPLOY_SCRIPT,

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
