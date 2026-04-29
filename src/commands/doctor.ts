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
import type { CheckResult, CommandResult } from '../shared/types.js';

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

  // v0.51.9: pipeline_order.json 已废弃（卡按 seq 排序）。
  // 老项目里如果存在该文件，--fix 会顺手删掉；不存在就跳过。
  if (ctx.paths.pipelineOrderFile && checkPathExists(ctx.paths.pipelineOrderFile)) {
    if (doFix) {
      try {
        const { rmSync } = await import('node:fs');
        rmSync(ctx.paths.pipelineOrderFile, { force: true });
        checks.push({ name: 'pipeline-order', status: 'pass', message: 'Removed legacy pipeline_order.json (deprecated v0.51.9)' });
        fixes.push('Removed legacy pipeline_order.json');
      } catch (err) {
        checks.push({ name: 'pipeline-order', status: 'warn', message: `Failed to remove legacy file: ${err instanceof Error ? err.message : String(err)}` });
      }
    } else {
      checks.push({ name: 'pipeline-order', status: 'warn', message: 'Legacy pipeline_order.json found (deprecated v0.51.9; use --fix to remove)' });
    }
  } else {
    checks.push({ name: 'pipeline-order', status: 'pass', message: 'No pipeline_order.json (deprecated v0.51.9)' });
  }

  // v0.42.0: Plane/Trello removed. Markdown backend has no remote PM state to validate.

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

    // v0.42.0: Plane/Trello connectivity checks removed (markdown only).
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
