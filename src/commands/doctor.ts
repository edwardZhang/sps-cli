/**
 * @module        doctor
 * @description   环境诊断命令，检查项目配置、依赖和运行状态是否正常
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-19
 * @updated       2026-04-03
 *
 * @role          command
 * @layer         command
 * @boundedContext system
 *
 * @trigger       sps doctor <project> [--fix] [--json]
 * @inputs        项目名、--fix/--json/--skip-remote/--reset-state 标志
 * @outputs       诊断结果列表（pass/warn/fail）
 * @workflow      1. 检查配置字段 → 2. 验证路径 → 3. 检查远程连接 → 4. 可选自动修复
 */
import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveGitlabProjectId } from '../core/config.js';
import { ProjectContext } from '../core/context.js';
import { Logger } from '../core/logger.js';
import { checkPathExists } from '../core/paths.js';
import { RuntimeStore } from '../core/runtimeStore.js';
import type { RuntimeState } from '../core/state.js';
import { createIdleWorkerSlot, writeState } from '../core/state.js';
import type { CheckResult, CommandResult } from '../models/types.js';

// ─── Template Dir resolution (mirrors projectInit.ts) ────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
function findTemplateDir(): string {
  const npmPath = resolve(__dirname, '..', '..', 'project-template');
  if (existsSync(npmPath)) return npmPath;
  const srcPath = resolve(__dirname, '..', '..', '..', 'project-template');
  if (existsSync(srcPath)) return srcPath;
  const HOME = process.env.HOME || '/home/coral';
  const legacyPath = resolve(HOME, 'jarvis-skills', 'coding-work-flow', 'project-template');
  if (existsSync(legacyPath)) return legacyPath;
  return npmPath;
}
const TEMPLATE_DIR = findTemplateDir();

interface DoctorFlags {
  json?: boolean;
  fix?: boolean;
  'skip-remote'?: boolean;
  'reset-state'?: boolean;
  [key: string]: boolean | undefined;
}

/**
 * conf fields that CLI providers require.
 * Each entry maps the canonical CLI field → fallback ~/.coral/env field name.
 * If the canonical field is missing but the fallback exists, --fix can add a mapping.
 */
/**
 * CLI conf fields that must be present (from global env or project conf).
 * These are checked in the merged config (global + project).
 */
const CLI_CONF_FIELDS: { field: string; fallback: string; section: string }[] = [
  { field: 'PLANE_URL', fallback: 'PLANE_API_URL', section: 'Plane' },
  { field: 'PLANE_API_KEY', fallback: 'PLANE_API_KEY', section: 'Plane' },
  { field: 'PLANE_WORKSPACE_SLUG', fallback: 'PLANE_WORKSPACE_SLUG', section: 'Plane' },
  { field: 'MATRIX_ACCESS_TOKEN', fallback: 'MATRIX_ACCESS_TOKEN', section: 'Matrix' },
];

export async function executeDoctor(project: string, flags: DoctorFlags): Promise<void> {
  const checks: CheckResult[] = [];
  const fixes: string[] = [];
  const _log = new Logger('doctor', project);
  const doFix = !!flags.fix;

  // 0a. Global env file exists
  const HOME = process.env.HOME || '/home/coral';
  const globalEnvPath = resolve(HOME, '.coral', 'env');
  if (existsSync(globalEnvPath)) {
    checks.push({ name: 'global-env', status: 'pass', message: globalEnvPath });
  } else {
    checks.push({ name: 'global-env', status: 'fail', message: `${globalEnvPath} not found — run: sps setup` });
  }

  // 0b. Key global env vars
  const globalVarsToCheck = ['GITLAB_URL', 'GITLAB_TOKEN'];
  const missingGlobalVars = globalVarsToCheck.filter(v => !process.env[v]);
  if (missingGlobalVars.length === 0) {
    checks.push({ name: 'global-env-vars', status: 'pass', message: 'GITLAB_URL and GITLAB_TOKEN set' });
  } else {
    checks.push({
      name: 'global-env-vars',
      status: 'warn',
      message: `Missing env vars: ${missingGlobalVars.join(', ')} — run: source ~/.coral/env`,
    });
  }

  // 1. Load ProjectContext
  let ctx: ProjectContext;
  let runtimeStore: RuntimeStore;
  try {
    ctx = ProjectContext.load(project);
    runtimeStore = new RuntimeStore(ctx);
    checks.push({ name: 'conf-load', status: 'pass', message: `Loaded ${ctx.paths.confFile}` });
  } catch (err) {
    checks.push({ name: 'conf-load', status: 'fail', message: String(err) });
    outputResult(project, checks, fixes, flags);
    process.exit(1);
  }

  // 2. Validate required fields
  const validation = ctx.validate();
  if (validation.ok) {
    checks.push({ name: 'conf-fields', status: 'pass', message: 'All required fields present' });
  } else {
    for (const e of validation.errors) {
      checks.push({ name: 'conf-fields', status: 'fail', message: `${e.field}: ${e.message}` });
    }
  }

  // 3. Instance directory structure
  const dirChecks: [string, string][] = [
    [ctx.paths.instanceDir, 'instance-dir'],
    [ctx.paths.logsDir, 'logs-dir'],
    [ctx.paths.runtimeDir, 'runtime-dir'],
    [ctx.paths.pmMetaDir, 'pm-meta-dir'],
  ];
  for (const [path, name] of dirChecks) {
    if (checkPathExists(path)) {
      checks.push({ name, status: 'pass', message: path });
    } else if (doFix) {
      mkdirSync(path, { recursive: true });
      checks.push({ name, status: 'pass', message: `Created: ${path}` });
      fixes.push(`Created directory: ${path}`);
    } else {
      checks.push({ name, status: 'warn', message: `Missing: ${path} (use --fix to create)` });
    }
  }

  // 4. Repo directory
  if (checkPathExists(ctx.paths.repoDir)) {
    const isGit = checkPathExists(`${ctx.paths.repoDir}/.git`);
    checks.push({
      name: 'repo-dir',
      status: isGit ? 'pass' : 'warn',
      message: isGit ? ctx.paths.repoDir : `${ctx.paths.repoDir} exists but is not a git repo`,
    });
  } else {
    checks.push({ name: 'repo-dir', status: 'warn', message: `Repo dir not found: ${ctx.paths.repoDir}` });
  }

  // 4.5 Worker rules files (CLAUDE.md, AGENTS.md)
  const isGitRepo = checkPathExists(`${ctx.paths.repoDir}/.git`);
  if (checkPathExists(ctx.paths.repoDir) && isGitRepo) {
    checkWorkerRulesFiles(ctx, checks, fixes, doFix, false);
  } else {
    checks.push({ name: 'worker-rules', status: 'skip', message: 'Repo not available, skipping worker rules check' });
  }

  // 4.7 Skills — check ~/.coral/skills/ for installed system skills
  const skillsDir = resolve(HOME, '.coral', 'skills');
  if (!existsSync(skillsDir)) {
    checks.push({ name: 'skills', status: 'warn', message: `${skillsDir} not found — run: sps setup` });
  } else {
    const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(resolve(skillsDir, d.name, 'SKILL.md')));
    checks.push({ name: 'skills', status: 'pass', message: `${skillDirs.length} skill(s) installed in ${skillsDir}` });
  }

  // 5. state.json
  if (checkPathExists(ctx.paths.stateFile)) {
    try {
      const state = runtimeStore.readState();
      checks.push({
        name: 'state-json',
        status: 'pass',
        message: `generation=${state.generation}, workers=${Object.keys(state.workers).length}, activeCards=${Object.keys(state.activeCards).length}`,
      });
    } catch {
      checks.push({ name: 'state-json', status: 'fail', message: 'state.json exists but is corrupt' });
    }
  } else if (doFix) {
    const state = runtimeStore.readState(); // creates default
    runtimeStore.updateState('doctor-init', () => {});
    checks.push({ name: 'state-json', status: 'pass', message: `Initialized with ${Object.keys(state.workers).length} worker slots` });
    fixes.push('Initialized state.json');
  } else {
    checks.push({ name: 'state-json', status: 'skip', message: 'state.json not found (use --fix to initialize)' });
  }

  // 6. pipeline_order.json
  if (ctx.paths.pipelineOrderFile && checkPathExists(ctx.paths.pipelineOrderFile)) {
    checks.push({ name: 'pipeline-order', status: 'pass', message: ctx.paths.pipelineOrderFile });
  } else if (doFix) {
    writeFileSync(ctx.paths.pipelineOrderFile, '[]\n');
    checks.push({ name: 'pipeline-order', status: 'pass', message: `Created: ${ctx.paths.pipelineOrderFile}` });
    fixes.push('Created empty pipeline_order.json');
  } else {
    checks.push({ name: 'pipeline-order', status: 'skip', message: 'pipeline_order.json not found (use --fix to create)' });
  }

  // 7. CLI provider conf fields (PLANE_API_URL, MATRIX_ACCESS_TOKEN, etc.)
  if (ctx.pmTool === 'plane') {
    checkCliConfFields(ctx, checks, fixes, doFix);
  }

  // 8. Remote checks (optional)
  if (!flags['skip-remote']) {
    // GitLab connectivity
    // Uses curl -sk to tolerate self-signed certificates common in self-hosted GitLab.
    const gitlabUrl = ctx.config.raw.GITLAB_URL;
    const gitlabToken = ctx.config.raw.GITLAB_TOKEN;
    if (gitlabUrl && gitlabToken) {
      try {
        const httpCode = execSync(
          `curl -sk -o /dev/null -w '%{http_code}' -H "PRIVATE-TOKEN: ${gitlabToken}" "${gitlabUrl}/api/v4/projects/${encodeURIComponent(resolveGitlabProjectId(ctx.config) || ctx.config.GITLAB_PROJECT)}"`,
          { timeout: 15000, encoding: 'utf-8' }
        ).trim();
        const code = parseInt(httpCode, 10);
        if (code >= 200 && code < 400) {
          checks.push({ name: 'gitlab', status: 'pass', message: `Connected to ${gitlabUrl} (HTTP ${code})` });
        } else {
          checks.push({ name: 'gitlab', status: 'fail', message: `GitLab returned HTTP ${code} at ${gitlabUrl}` });
        }
      } catch (err) {
        const stderr = (err as { stderr?: string }).stderr ?? '';
        const hint = stderr.includes('resolve') ? ' (DNS resolution failed)'
          : stderr.includes('connect') ? ' (connection refused)'
          : stderr.includes('timeout') ? ' (connection timed out)'
          : '';
        checks.push({ name: 'gitlab', status: 'fail', message: `Cannot reach GitLab at ${gitlabUrl}${hint}` });
      }
    } else {
      checks.push({ name: 'gitlab', status: 'skip', message: 'GITLAB_URL or GITLAB_TOKEN not configured' });
    }

    // Plane connectivity (only if PM_TOOL=plane and API fields present)
    if (ctx.pmTool === 'plane') {
      const planeUrl = ctx.config.raw.PLANE_API_URL || ctx.config.raw.PLANE_URL;
      const planeKey = ctx.config.raw.PLANE_API_KEY;
      const planeWorkspace = ctx.config.raw.PLANE_WORKSPACE_SLUG;
      const planeProjectId = ctx.config.raw.PLANE_PROJECT_ID;
      if (planeUrl && planeKey && planeWorkspace && planeProjectId) {
        try {
          const apiUrl = `${planeUrl}/api/v1/workspaces/${planeWorkspace}/projects/${planeProjectId}/`;
          const httpCode = execSync(
            `curl -sk -o /dev/null -w '%{http_code}' -H "X-API-Key: ${planeKey}" "${apiUrl}"`,
            { timeout: 15000, encoding: 'utf-8' }
          ).trim();
          const code = parseInt(httpCode, 10);
          if (code >= 200 && code < 400) {
            checks.push({ name: 'plane', status: 'pass', message: `Connected to ${planeUrl} (HTTP ${code})` });
          } else {
            checks.push({ name: 'plane', status: 'fail', message: `Plane returned HTTP ${code} at ${planeUrl}` });
          }
        } catch {
          checks.push({ name: 'plane', status: 'fail', message: `Cannot reach Plane at ${planeUrl}` });
        }
      } else {
        checks.push({ name: 'plane', status: 'skip', message: 'Plane API fields incomplete (PLANE_URL / PLANE_API_KEY / PLANE_WORKSPACE_SLUG — set in ~/.coral/env)' });
      }
    }

    // 8.5 PM backend state/list validation (requires remote access)
    await checkPmStates(ctx, checks, fixes, doFix);
  }

  // 9. Worker tool — claude is the only supported CLI
  try {
    execSync('which claude', { encoding: 'utf-8', timeout: 5000 });
    checks.push({ name: 'worker-tool', status: 'pass', message: 'claude found in PATH' });
  } catch {
    checks.push({ name: 'worker-tool', status: 'warn', message: 'claude not found in PATH' });
  }

  // 10. Worker transport check
  const transport = ctx.config.WORKER_TRANSPORT;
  checks.push({ name: 'worker-transport', status: 'pass', message: `WORKER_TRANSPORT=${transport}` });

  // ── State reset ────────────────────────────────────────────────
  if (flags['reset-state']) {
    const stateFile = ctx.paths.stateFile;
    const maxWorkers = ctx.maxWorkers;

    // Read current state to preserve version/generation
    let generation = 0;
    if (existsSync(stateFile)) {
      try {
        const old = JSON.parse(readFileSync(stateFile, 'utf-8'));
        generation = (old.generation ?? 0) + 1;
      } catch { /* corrupt, start fresh */ }
    }

    // Create clean state with correct worker count
    const clean: RuntimeState = {
      version: 1,
      generation,
      updatedAt: new Date().toISOString(),
      updatedBy: 'doctor-reset',
      workers: {},
      activeCards: {},
      leases: {},
      worktreeEvidence: {},
      worktreeCleanup: [],
      sessions: {},
      integrationQueues: {},
      pendingPMActions: [],
    };

    // Initialize worker slots based on MAX_CONCURRENT_WORKERS
    for (let i = 1; i <= maxWorkers; i++) {
      clean.workers[`worker-${i}`] = createIdleWorkerSlot();
    }

    writeState(stateFile, clean, 'doctor-reset');

    checks.push({
      name: 'state-reset',
      status: 'pass',
      message: `State reset: ${maxWorkers} worker slots, cleared activeCards/leases/queues/pendingPMActions`,
    });
    fixes.push('Reset runtime state to clean defaults');
  }

  outputResult(project, checks, fixes, flags);

  const hasFail = checks.some(c => c.status === 'fail');
  process.exit(hasFail ? 1 : 0);
}

/**
 * Check CLI-required conf fields. If missing and --fix, append mapping lines to conf.
 */
function checkCliConfFields(
  ctx: ProjectContext,
  checks: CheckResult[],
  fixes: string[],
  doFix: boolean,
): void {
  const missing: typeof CLI_CONF_FIELDS = [];

  for (const entry of CLI_CONF_FIELDS) {
    const hasField = !!ctx.config.raw[entry.field];
    if (!hasField) {
      // Check if fallback exists in the loaded env
      const hasFallback = !!ctx.config.raw[entry.fallback];
      if (hasFallback) {
        missing.push(entry);
      } else {
        checks.push({
          name: `conf-${entry.field}`,
          status: 'warn',
          message: `${entry.field} not set and fallback ${entry.fallback} not found in env`,
        });
      }
    }
  }

  if (missing.length === 0) {
    checks.push({ name: 'conf-cli-fields', status: 'pass', message: 'All CLI provider fields present' });
    return;
  }

  if (doFix) {
    // Append mapping lines to conf
    const lines: string[] = [
      '',
      '# ── CLI 兼容映射（auto-generated by doctor --fix）────────────',
    ];
    for (const entry of missing) {
      if (entry.field === entry.fallback) {
        // Same name — just re-export
        lines.push(`export ${entry.field}="\${${entry.fallback}}"`);
      } else {
        lines.push(`export ${entry.field}="\${${entry.fallback}}"`);
      }
    }
    appendFileSync(ctx.paths.confFile, lines.join('\n') + '\n');
    checks.push({
      name: 'conf-cli-fields',
      status: 'pass',
      message: `Added ${missing.length} CLI mapping(s) to conf`,
    });
    fixes.push(`Appended ${missing.length} CLI field mapping(s) to ${ctx.paths.confFile}`);
  } else {
    for (const entry of missing) {
      checks.push({
        name: `conf-${entry.field}`,
        status: 'warn',
        message: `${entry.field} missing (fallback ${entry.fallback} exists — use --fix to add mapping)`,
      });
    }
  }
}

/**
 * Generate project-level CLAUDE.md content.
 *
 * Reads the canonical template from `<TEMPLATE_DIR>/.claude/CLAUDE.md` so the
 * content stays in sync with `sps project init`. Falls back to a minimal
 * inline default if the template is missing (shouldn't happen in a well-built
 * npm package, but keeps doctor --fix non-fatal).
 */
function generateWorkerRules(_ctx: ProjectContext): string {
  const templatePath = resolve(TEMPLATE_DIR, '.claude', 'CLAUDE.md');
  if (existsSync(templatePath)) {
    return readFileSync(templatePath, 'utf-8');
  }
  return `# Worker Rules (auto-generated by sps doctor --fix)

## Scope
- ONLY work in the current working directory
- Do NOT read or modify files outside this directory

## Project-Specific Rules
# Add your project's coding standards here.
`;
}

/**
 * Check whether CLAUDE.md, AGENTS.md, and .gitignore entries exist in the repo.
 * If --fix, generate missing files and commit them.
 */
/**
 * Default .claude/settings.json content.
 *
 * Reads the canonical template from `<TEMPLATE_DIR>/.claude/settings.json` so
 * it stays in sync with `sps project init`. Falls back to a minimal inline
 * default if the template is missing.
 */
function generateClaudeHookSettings(): string {
  const templatePath = resolve(TEMPLATE_DIR, '.claude', 'settings.json');
  if (existsSync(templatePath)) {
    return readFileSync(templatePath, 'utf-8');
  }
  return `${JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: 'bash "$CLAUDE_PROJECT_DIR"/.claude/hooks/stop.sh' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'sps hook user-prompt-submit' }] }],
    },
  }, null, 2)}\n`;
}

function checkWorkerRulesFiles(
  ctx: ProjectContext,
  checks: CheckResult[],
  fixes: string[],
  doFix: boolean,
  gitignoreModified: boolean = false,
): void {
  const repoDir = ctx.paths.repoDir;
  const claudeMd = resolve(repoDir, 'CLAUDE.md');
  const claudeSettings = resolve(repoDir, '.claude', 'settings.json');

  const hasClaudeMd = existsSync(claudeMd);
  const hasClaudeSettings = existsSync(claudeSettings);
  const requiredFile = 'CLAUDE.md';
  const hasRequired = hasClaudeMd && hasClaudeSettings;
  const presentFiles = [
    hasClaudeMd && 'CLAUDE.md',
    hasClaudeSettings && '.claude/settings.json',
  ].filter(Boolean) as string[];

  if (hasRequired && !gitignoreModified) {
    checks.push({ name: 'worker-rules', status: 'pass', message: `${presentFiles.join(' and ')} present in repo` });
  } else if (hasRequired && gitignoreModified && doFix) {
    try {
      execSync('git add .gitignore', { cwd: repoDir, timeout: 5000 });
      execSync(
        'git commit -m "chore: add .sps/ to .gitignore"',
        { cwd: repoDir, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      checks.push({ name: 'worker-rules', status: 'pass', message: `${presentFiles.join(' and ')} present; committed .gitignore update` });
    } catch {
      checks.push({ name: 'worker-rules', status: 'pass', message: `${presentFiles.join(' and ')} present (.gitignore update needs manual commit)` });
    }
  } else if (doFix) {
    const content = generateWorkerRules(ctx);
    const created: string[] = [];

    if (!hasClaudeMd) {
      writeFileSync(claudeMd, content);
      created.push('CLAUDE.md');
    }

    if (!hasClaudeSettings) {
      mkdirSync(resolve(repoDir, '.claude'), { recursive: true });
      writeFileSync(claudeSettings, generateClaudeHookSettings());
      created.push('.claude/settings.json');
    }

    // Install the hook script referenced by settings.json. Without this, the
    // Stop hook command `bash $CLAUDE_PROJECT_DIR/.claude/hooks/stop.sh` fails.
    const stopHookSrc = resolve(TEMPLATE_DIR, '.claude', 'hooks', 'stop.sh');
    const stopHookDst = resolve(repoDir, '.claude', 'hooks', 'stop.sh');
    if (!existsSync(stopHookDst) && existsSync(stopHookSrc)) {
      mkdirSync(resolve(repoDir, '.claude', 'hooks'), { recursive: true });
      writeFileSync(stopHookDst, readFileSync(stopHookSrc, 'utf-8'));
      try { execSync(`chmod +x "${stopHookDst}"`, { timeout: 2000 }); } catch { /* non-fatal */ }
      created.push('.claude/hooks/stop.sh');
    }

    if (created.length > 0 || gitignoreModified) {
      try {
        const filesToAdd = [...created];
        if (gitignoreModified) filesToAdd.push('.gitignore');

        execSync(`git add ${filesToAdd.join(' ')}`, { cwd: repoDir, timeout: 5000 });
        const commitFiles = gitignoreModified ? [...created, '.gitignore'] : created;
        execSync(
          `git commit -m "chore: add worker rules and SPS gitignore (${commitFiles.join(', ')})"`,
          { cwd: repoDir, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        fixes.push(`Created ${commitFiles.join(', ')} in repo and committed`);
        checks.push({ name: 'worker-rules', status: 'pass', message: `Generated and committed: ${commitFiles.join(', ')}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        checks.push({ name: 'worker-rules', status: 'warn', message: `Files created but commit failed: ${msg}` });
        fixes.push(`Created ${created.join(', ')} (commit failed, please commit manually)`);
      }
    }
  } else {
    checks.push({
      name: 'worker-rules',
      status: 'warn',
      message: `Missing ${requiredFile} in repo (use --fix to generate)`,
    });
  }
}

// ─── PM State/List Validation ─────────────────────────────────────

/** SPS required states and their default Plane group mapping. */
const SPS_STATES: { name: string; confField: string; planeGroup: string }[] = [
  { name: 'Planning',   confField: 'PLANE_STATE_PLANNING',   planeGroup: 'backlog' },
  { name: 'Backlog',    confField: 'PLANE_STATE_BACKLOG',    planeGroup: 'backlog' },
  { name: 'Todo',       confField: 'PLANE_STATE_TODO',       planeGroup: 'unstarted' },
  { name: 'Inprogress', confField: 'PLANE_STATE_INPROGRESS', planeGroup: 'started' },
  { name: 'QA',         confField: 'PLANE_STATE_QA',         planeGroup: 'started' },
  { name: 'Done',       confField: 'PLANE_STATE_DONE',       planeGroup: 'completed' },
];

const TRELLO_STATES: { name: string; confField: string }[] = [
  { name: 'Planning',   confField: 'TRELLO_LIST_PLANNING' },
  { name: 'Backlog',    confField: 'TRELLO_LIST_BACKLOG' },
  { name: 'Todo',       confField: 'TRELLO_LIST_TODO' },
  { name: 'Inprogress', confField: 'TRELLO_LIST_INPROGRESS' },
  { name: 'QA',         confField: 'TRELLO_LIST_QA' },
  { name: 'Done',       confField: 'TRELLO_LIST_DONE' },
];

/** curl-based HTTP GET that returns parsed JSON. Works on Node < 18. */
function curlGet<T>(url: string, headers: Record<string, string> = {}): T {
  const headerArgs = Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
  const output = execSync(
    ['curl', '-sk', '--fail-with-body', '-o', '-', ...headerArgs, url]
      .map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' '),
    { encoding: 'utf-8', timeout: 15000 },
  );
  return JSON.parse(output) as T;
}

/** curl-based HTTP POST that returns parsed JSON. Works on Node < 18. */
function curlPost<T>(url: string, body: unknown, headers: Record<string, string> = {}): T {
  const headerArgs = Object.entries(headers).flatMap(([k, v]) => ['-H', `${k}: ${v}`]);
  const jsonBody = JSON.stringify(body);
  const output = execSync(
    ['curl', '-sk', '--fail-with-body', '-o', '-', '-X', 'POST',
     ...headerArgs, '-H', 'Content-Type: application/json',
     '-d', jsonBody, url]
      .map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' '),
    { encoding: 'utf-8', timeout: 15000 },
  );
  return JSON.parse(output) as T;
}

async function checkPmStates(
  ctx: ProjectContext,
  checks: CheckResult[],
  fixes: string[],
  doFix: boolean,
): Promise<void> {
  if (ctx.pmTool === 'plane') {
    checkPlaneStates(ctx, checks, fixes, doFix);
  } else if (ctx.pmTool === 'trello') {
    checkTrelloLists(ctx, checks, fixes, doFix);
  }
  // markdown: no remote state to validate
}

function checkPlaneStates(
  ctx: ProjectContext,
  checks: CheckResult[],
  fixes: string[],
  doFix: boolean,
): void {
  const raw = ctx.config.raw;
  const apiUrl = raw.PLANE_API_URL || raw.PLANE_URL;
  const apiKey = raw.PLANE_API_KEY;
  const workspace = raw.PLANE_WORKSPACE_SLUG;
  const projectId = raw.PLANE_PROJECT_ID;

  if (!apiUrl || !apiKey || !workspace || !projectId) {
    checks.push({ name: 'pm-states', status: 'skip', message: 'Plane API fields incomplete' });
    return;
  }

  interface PlaneState { id: string; name: string; group: string }
  const baseUrl = `${apiUrl}/api/v1/workspaces/${workspace}/projects/${projectId}`;

  let existingStates: PlaneState[];
  try {
    const data = curlGet<{ results: PlaneState[] }>(`${baseUrl}/states/`, { 'X-API-Key': apiKey });
    existingStates = data.results;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: 'pm-states', status: 'fail', message: `Cannot fetch Plane states: ${msg}` });
    return;
  }

  const missing: typeof SPS_STATES = [];
  const confUpdates: string[] = [];

  for (const req of SPS_STATES) {
    const confValue = raw[req.confField];
    if (confValue && confValue !== `__${req.confField}__`) {
      const found = existingStates.find((s) => s.id === confValue);
      if (found) continue;
      checks.push({ name: 'pm-states', status: 'warn', message: `${req.confField}=${confValue} not found in Plane (stale UUID?)` });
      missing.push(req);
    } else {
      const byName = existingStates.find((s) => s.name.toLowerCase() === req.name.toLowerCase());
      if (byName) {
        if (doFix) {
          confUpdates.push(`export ${req.confField}="${byName.id}"`);
        } else {
          checks.push({ name: 'pm-states', status: 'warn', message: `${req.name} exists in Plane (${byName.id}) but ${req.confField} not set in conf (use --fix)` });
        }
        continue;
      }
      missing.push(req);
    }
  }

  // Auto-create missing states in Plane if --fix
  if (missing.length > 0) {
    if (doFix) {
      for (const req of missing) {
        try {
          const created = curlPost<PlaneState>(
            `${baseUrl}/states/`,
            { name: req.name, group: req.planeGroup, color: '#6B7280' },
            { 'X-API-Key': apiKey },
          );
          confUpdates.push(`export ${req.confField}="${created.id}"`);
          checks.push({ name: 'pm-states', status: 'pass', message: `Created Plane state "${req.name}" (${created.id})` });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          checks.push({ name: 'pm-states', status: 'fail', message: `Failed to create Plane state "${req.name}": ${msg}` });
        }
      }
    } else {
      const names = missing.map((m) => m.name).join(', ');
      checks.push({ name: 'pm-states', status: 'warn', message: `Missing Plane states: ${names} (use --fix to auto-create)` });
    }
  }

  // Write conf updates
  if (confUpdates.length > 0 && doFix) {
    writeConfUpdates(ctx.paths.confFile, confUpdates, 'Plane State UUIDs', 'pm-states', checks, fixes);
  }

  if (missing.length === 0 && confUpdates.length === 0) {
    checks.push({ name: 'pm-states', status: 'pass', message: 'All 6 Plane states configured and valid' });
  }
}

function checkTrelloLists(
  ctx: ProjectContext,
  checks: CheckResult[],
  fixes: string[],
  doFix: boolean,
): void {
  const raw = ctx.config.raw;
  const apiKey = raw.TRELLO_API_KEY;
  const apiToken = raw.TRELLO_TOKEN;
  const boardId = raw.TRELLO_BOARD_ID;

  if (!apiKey || !apiToken || !boardId) {
    checks.push({ name: 'pm-lists', status: 'skip', message: 'Trello API fields incomplete' });
    return;
  }

  interface TrelloList { id: string; name: string; closed: boolean }
  let existingLists: TrelloList[];
  try {
    existingLists = curlGet<TrelloList[]>(
      `https://api.trello.com/1/boards/${boardId}/lists?key=${apiKey}&token=${apiToken}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: 'pm-lists', status: 'fail', message: `Cannot fetch Trello lists: ${msg}` });
    return;
  }

  const openLists = existingLists.filter((l) => !l.closed);
  const missing: typeof TRELLO_STATES = [];
  const confUpdates: string[] = [];

  for (const req of TRELLO_STATES) {
    const confValue = raw[req.confField];
    if (confValue && confValue !== `__${req.confField}__`) {
      const found = openLists.find((l) => l.id === confValue);
      if (found) continue;
      checks.push({ name: 'pm-lists', status: 'warn', message: `${req.confField}=${confValue} not found in Trello (stale ID?)` });
      missing.push(req);
    } else {
      const byName = openLists.find((l) => l.name.toLowerCase() === req.name.toLowerCase());
      if (byName) {
        if (doFix) {
          confUpdates.push(`export ${req.confField}="${byName.id}"`);
        } else {
          checks.push({ name: 'pm-lists', status: 'warn', message: `${req.name} exists in Trello (${byName.id}) but ${req.confField} not set (use --fix)` });
        }
        continue;
      }
      missing.push(req);
    }
  }

  if (missing.length > 0) {
    if (doFix) {
      for (const req of missing) {
        try {
          const created = curlPost<TrelloList>(
            `https://api.trello.com/1/lists?key=${apiKey}&token=${apiToken}`,
            { name: req.name, idBoard: boardId },
          );
          confUpdates.push(`export ${req.confField}="${created.id}"`);
          checks.push({ name: 'pm-lists', status: 'pass', message: `Created Trello list "${req.name}" (${created.id})` });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          checks.push({ name: 'pm-lists', status: 'fail', message: `Failed to create Trello list "${req.name}": ${msg}` });
        }
      }
    } else {
      const names = missing.map((m) => m.name).join(', ');
      checks.push({ name: 'pm-lists', status: 'warn', message: `Missing Trello lists: ${names} (use --fix to auto-create)` });
    }
  }

  if (confUpdates.length > 0 && doFix) {
    writeConfUpdates(ctx.paths.confFile, confUpdates, 'Trello List IDs', 'pm-lists', checks, fixes);
  }

  if (missing.length === 0 && confUpdates.length === 0) {
    checks.push({ name: 'pm-lists', status: 'pass', message: 'All 6 Trello lists configured and valid' });
  }
}

/** Write conf updates: replace existing fields in-place, append new ones. */
function writeConfUpdates(
  confFile: string,
  updates: string[],
  section: string,
  checkName: string,
  checks: CheckResult[],
  fixes: string[],
): void {
  try {
    let confContent = readFileSync(confFile, 'utf-8');
    const appendLines: string[] = [];
    for (const update of updates) {
      const field = update.match(/export (\w+)=/)?.[1];
      if (!field) continue;
      if (confContent.includes(`${field}=`)) {
        confContent = confContent.replace(new RegExp(`^(export )?${field}=.*$`, 'm'), update);
      } else {
        appendLines.push(update);
      }
    }
    writeFileSync(confFile, confContent);
    if (appendLines.length > 0) {
      appendFileSync(confFile, `\n# ── ${section} (auto-configured by doctor --fix) ──\n${appendLines.join('\n')}\n`);
    }
    fixes.push(`Updated ${updates.length} ${section} in conf`);
    checks.push({ name: checkName, status: 'pass', message: `Configured ${updates.length} ${section}` });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({ name: checkName, status: 'fail', message: `Failed to update conf: ${msg}` });
  }
}

function outputResult(
  project: string,
  checks: CheckResult[],
  fixes: string[],
  flags: DoctorFlags,
): void {
  if (flags.json) {
    const result: CommandResult = {
      project,
      component: 'doctor',
      status: checks.some(c => c.status === 'fail') ? 'fail' : 'ok',
      exitCode: checks.some(c => c.status === 'fail') ? 1 : 0,
      actions: [],
      recommendedActions: [],
      details: { checks, fixes },
    };
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`\n  Project: ${project}\n`);
    for (const check of checks) {
      const icon = check.status === 'pass' ? '\x1b[32m✓\x1b[0m'
        : check.status === 'fail' ? '\x1b[31m✗\x1b[0m'
        : check.status === 'warn' ? '\x1b[33m⚠\x1b[0m'
        : '\x1b[90m-\x1b[0m';
      console.log(`  ${icon} ${check.name.padEnd(18)} ${check.message}`);
    }
    if (fixes.length > 0) {
      console.log(`\n  Fixed ${fixes.length} issue(s):`);
      for (const fix of fixes) {
        console.log(`    ✓ ${fix}`);
      }
    }
    console.log();
  }
}
