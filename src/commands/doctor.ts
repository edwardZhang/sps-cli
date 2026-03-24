import { existsSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ProjectContext } from '../core/context.js';
import { checkPathExists } from '../core/paths.js';
import { readState, writeState } from '../core/state.js';
import { Logger } from '../core/logger.js';
import type { CheckResult, CommandResult } from '../models/types.js';

interface DoctorFlags {
  json?: boolean;
  fix?: boolean;
  'skip-remote'?: boolean;
  [key: string]: boolean | undefined;
}

/**
 * conf fields that CLI providers require.
 * Each entry maps the canonical CLI field → fallback .jarvis.env field name.
 * If the canonical field is missing but the fallback exists, --fix can add a mapping.
 */
const CLI_CONF_FIELDS: { field: string; fallback: string; section: string }[] = [
  { field: 'PLANE_API_URL', fallback: 'PLANE_URL', section: 'Plane' },
  { field: 'PLANE_API_KEY', fallback: 'PLANE_API_KEY', section: 'Plane' },
  { field: 'PLANE_WORKSPACE_SLUG', fallback: 'PLANE_WORKSPACE_SLUG', section: 'Plane' },
  { field: 'MATRIX_ACCESS_TOKEN', fallback: 'MATRIX_TOKEN', section: 'Matrix' },
];

export async function executeDoctor(project: string, flags: DoctorFlags): Promise<void> {
  const checks: CheckResult[] = [];
  const fixes: string[] = [];
  const log = new Logger('doctor', project);
  const doFix = !!flags.fix;

  // 1. Load ProjectContext
  let ctx: ProjectContext;
  try {
    ctx = ProjectContext.load(project);
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

  // 4.5 Worker rules files (CLAUDE.md, AGENTS.md, .gitignore entry)
  const isGitRepo = checkPathExists(`${ctx.paths.repoDir}/.git`);
  if (checkPathExists(ctx.paths.repoDir) && isGitRepo) {
    checkWorkerRulesFiles(ctx, checks, fixes, doFix);
  } else {
    checks.push({ name: 'worker-rules', status: 'skip', message: 'Repo not available, skipping worker rules check' });
  }

  // 5. state.json
  if (checkPathExists(ctx.paths.stateFile)) {
    try {
      const state = readState(ctx.paths.stateFile, ctx.maxWorkers);
      checks.push({
        name: 'state-json',
        status: 'pass',
        message: `generation=${state.generation}, workers=${Object.keys(state.workers).length}, activeCards=${Object.keys(state.activeCards).length}`,
      });
    } catch {
      checks.push({ name: 'state-json', status: 'fail', message: 'state.json exists but is corrupt' });
    }
  } else if (doFix) {
    const state = readState(ctx.paths.stateFile, ctx.maxWorkers); // creates default
    writeState(ctx.paths.stateFile, state, 'doctor-init');
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
    const gitlabUrl = ctx.config.raw.GITLAB_URL;
    const gitlabToken = ctx.config.raw.GITLAB_TOKEN;
    if (gitlabUrl && gitlabToken) {
      try {
        execSync(
          `curl -sf -o /dev/null -w '%{http_code}' -H "PRIVATE-TOKEN: ${gitlabToken}" "${gitlabUrl}/api/v4/projects/${ctx.config.GITLAB_PROJECT_ID}"`,
          { timeout: 10000, encoding: 'utf-8' }
        );
        checks.push({ name: 'gitlab', status: 'pass', message: `Connected to ${gitlabUrl}` });
      } catch {
        checks.push({ name: 'gitlab', status: 'fail', message: `Cannot reach GitLab at ${gitlabUrl}` });
      }
    } else {
      checks.push({ name: 'gitlab', status: 'skip', message: 'GITLAB_URL or GITLAB_TOKEN not configured' });
    }

    // Plane connectivity (only if PM_TOOL=plane and API fields present)
    if (ctx.pmTool === 'plane') {
      const planeUrl = ctx.config.raw.PLANE_API_URL;
      const planeKey = ctx.config.raw.PLANE_API_KEY;
      const planeWorkspace = ctx.config.raw.PLANE_WORKSPACE_SLUG;
      const planeProjectId = ctx.config.raw.PLANE_PROJECT_ID;
      if (planeUrl && planeKey && planeWorkspace && planeProjectId) {
        try {
          const apiUrl = `${planeUrl}/api/v1/workspaces/${planeWorkspace}/projects/${planeProjectId}/`;
          execSync(
            `curl -sf -o /dev/null -w '%{http_code}' -H "X-API-Key: ${planeKey}" "${apiUrl}"`,
            { timeout: 10000, encoding: 'utf-8' }
          );
          checks.push({ name: 'plane', status: 'pass', message: `Connected to ${planeUrl}` });
        } catch {
          checks.push({ name: 'plane', status: 'fail', message: `Cannot reach Plane at ${planeUrl}` });
        }
      } else {
        checks.push({ name: 'plane', status: 'skip', message: 'Plane API fields incomplete (PLANE_API_URL / PLANE_API_KEY / PLANE_WORKSPACE_SLUG)' });
      }
    }
  }

  // 9. Worker tool
  const tool = ctx.workerTool;
  try {
    execSync(`which ${tool}`, { encoding: 'utf-8', timeout: 5000 });
    checks.push({ name: 'worker-tool', status: 'pass', message: `${tool} found in PATH` });
  } catch {
    checks.push({ name: 'worker-tool', status: 'warn', message: `${tool} not found in PATH` });
  }

  // 10. tmux
  try {
    execSync('which tmux', { encoding: 'utf-8', timeout: 5000 });
    checks.push({ name: 'tmux', status: 'pass', message: 'tmux available' });
  } catch {
    checks.push({ name: 'tmux', status: 'fail', message: 'tmux not found' });
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
 * This file is committed to the repo and inherited by all worktrees.
 * Task-specific info (seq, branch) goes in .jarvis_task_prompt.txt instead.
 */
function generateWorkerRules(ctx: ProjectContext): string {
  return `# Worker Rules (auto-generated by sps doctor --fix)
#
# This file defines rules for AI workers (Claude Code / Codex) operating
# in this repository. It is committed to the repo so that all worktrees
# inherit these rules automatically.
#
# You may edit this file to add project-specific coding standards,
# architecture constraints, testing requirements, etc.
# SPS will NOT overwrite this file once it exists.

## Scope
- ONLY work in the current working directory
- Do NOT read or modify files outside this directory
- Do NOT explore the system, home directory, or other projects

## Workflow
1. Read the task prompt from .jarvis_task_prompt.txt
2. Implement the changes in this directory
3. Self-test your changes
4. git add, commit, and push to your feature branch
5. Create a Merge Request targeting ${ctx.mergeBranch}
6. Output "done" when finished

## Commit Rules
- Commit frequently (every meaningful change)
- Push after each commit
- Use conventional commit messages (feat:, fix:, refactor:, etc.)

## MR Creation
- Use git push first, then create MR via GitLab API:
  curl -s -X POST -H "PRIVATE-TOKEN: $GITLAB_TOKEN" -H "Content-Type: application/json" \\
    "$GITLAB_URL/api/v4/projects/${ctx.config.GITLAB_PROJECT_ID}/merge_requests" \\
    -d '{"source_branch":"<your-branch>","target_branch":"${ctx.mergeBranch}","title":"feat: <title>"}'

## Forbidden
- No PLAN.md, TODO.md, TASKLIST.md, ROADMAP.md, NOTES.md
- No local planning files of any kind
- No changes outside task scope
- Do NOT explore ~/.projects or other system directories

## Project-Specific Rules
# Add your project's coding standards, architecture constraints,
# testing requirements, and other conventions below:
#
# Examples:
#   - Language: TypeScript strict mode
#   - Test framework: vitest, 80%+ coverage required
#   - Architecture: src/modules/<domain>/ structure
#   - Linting: eslint + prettier, must pass before commit
`;
}

/**
 * Check whether CLAUDE.md, AGENTS.md, and .gitignore entries exist in the repo.
 * If --fix, generate missing files and commit them.
 */
function checkWorkerRulesFiles(
  ctx: ProjectContext,
  checks: CheckResult[],
  fixes: string[],
  doFix: boolean,
): void {
  const repoDir = ctx.paths.repoDir;
  const claudeMd = resolve(repoDir, 'CLAUDE.md');
  const agentsMd = resolve(repoDir, 'AGENTS.md');
  const gitignorePath = resolve(repoDir, '.gitignore');
  const taskPromptEntry = '.jarvis_task_prompt.txt';

  // Check CLAUDE.md
  const hasClaudeMd = existsSync(claudeMd);
  const hasAgentsMd = existsSync(agentsMd);

  if (hasClaudeMd && hasAgentsMd) {
    checks.push({ name: 'worker-rules', status: 'pass', message: 'CLAUDE.md and AGENTS.md present in repo' });
  } else if (doFix) {
    const content = generateWorkerRules(ctx);
    const created: string[] = [];

    if (!hasClaudeMd) {
      writeFileSync(claudeMd, content);
      created.push('CLAUDE.md');
    }
    if (!hasAgentsMd) {
      writeFileSync(agentsMd, content);
      created.push('AGENTS.md');
    }

    // Ensure .gitignore has .jarvis_task_prompt.txt
    let gitignoreUpdated = false;
    if (existsSync(gitignorePath)) {
      const gitignoreContent = readFileSync(gitignorePath, 'utf-8');
      if (!gitignoreContent.includes(taskPromptEntry)) {
        appendFileSync(gitignorePath, `\n# SPS task prompt (per-worktree, not committed)\n${taskPromptEntry}\n`);
        gitignoreUpdated = true;
      }
    } else {
      writeFileSync(gitignorePath, `# SPS task prompt (per-worktree, not committed)\n${taskPromptEntry}\n`);
      gitignoreUpdated = true;
    }
    if (gitignoreUpdated) created.push('.gitignore');

    // Git add + commit
    if (created.length > 0) {
      try {
        const filesToAdd = [];
        if (!hasClaudeMd) filesToAdd.push('CLAUDE.md');
        if (!hasAgentsMd) filesToAdd.push('AGENTS.md');
        if (gitignoreUpdated) filesToAdd.push('.gitignore');

        execSync(`git add ${filesToAdd.join(' ')}`, { cwd: repoDir, timeout: 5000 });
        execSync(
          `git commit -m "chore: add worker rules (CLAUDE.md, AGENTS.md)"`,
          { cwd: repoDir, timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        fixes.push(`Created ${created.join(', ')} in repo and committed`);
        checks.push({ name: 'worker-rules', status: 'pass', message: `Generated and committed: ${created.join(', ')}` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        checks.push({ name: 'worker-rules', status: 'warn', message: `Files created but commit failed: ${msg}` });
        fixes.push(`Created ${created.join(', ')} (commit failed, please commit manually)`);
      }
    }
  } else {
    const missing = [!hasClaudeMd && 'CLAUDE.md', !hasAgentsMd && 'AGENTS.md'].filter(Boolean);
    checks.push({
      name: 'worker-rules',
      status: 'warn',
      message: `Missing ${missing.join(', ')} in repo (use --fix to generate)`,
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
