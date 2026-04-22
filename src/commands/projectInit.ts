/**
 * @module        projectInit
 * @description   项目初始化命令，从模板创建项目配置和目录结构
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
 * @trigger       sps init <project> [--force]
 * @inputs        项目名、--force 覆盖标志
 * @outputs       初始化后的项目目录和配置文件
 * @workflow      1. 查找模板目录 → 2. 创建项目目录 → 3. 复制模板文件 → 4. 写入配置
 */
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Logger } from '../core/logger.js';
import { ensureSkillsGitignore, syncAllSkillsToProject } from '../core/skillStore.js';

const HOME = process.env.HOME || '/home/coral';
const __dirname = dirname(fileURLToPath(import.meta.url));

// Look for project-template relative to the package root (works for both npm install and source)
function findTemplateDir(): string {
  // When installed via npm: dist/commands/projectInit.js → ../../project-template
  const npmPath = resolve(__dirname, '..', '..', 'project-template');
  if (existsSync(npmPath)) return npmPath;
  // When running from source repo: src/commands/ → ../../../project-template
  const srcPath = resolve(__dirname, '..', '..', '..', 'project-template');
  if (existsSync(srcPath)) return srcPath;
  // Legacy fallback
  const legacyPath = resolve(HOME, 'jarvis-skills', 'coding-work-flow', 'project-template');
  if (existsSync(legacyPath)) return legacyPath;
  return npmPath; // default, will fail gracefully below
}

const TEMPLATE_DIR = findTemplateDir();

/**
 * Install the bundled `.claude/` preset (hooks, settings, CLAUDE.md skeleton)
 * into the target project repo. Non-destructive: skips any file that already
 * exists, so running `sps project init --force` won't clobber user edits.
 *
 * The template lives at `<TEMPLATE_DIR>/.claude/` and is shipped with the npm
 * package via the `files` field in package.json.
 */
function installClaudePreset(projectDir: string, projectName: string, log: Logger): void {
  const templateClaude = resolve(TEMPLATE_DIR, '.claude');
  if (!existsSync(templateClaude)) {
    log.warn(`Template .claude/ not found at ${templateClaude}, skipping preset install`);
    return;
  }
  if (!existsSync(projectDir)) {
    log.info(`Project repo ${projectDir} does not exist yet — skipping .claude/ install`);
    return;
  }

  const targetClaude = resolve(projectDir, '.claude');
  const preExisted = existsSync(targetClaude);

  // Copy recursively, without clobbering existing files.
  cpSync(templateClaude, targetClaude, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });

  // Materialize settings.local.json from template (substitute __PROJECT__).
  const settingsLocalTmpl = resolve(targetClaude, 'settings.local.json.template');
  const settingsLocal = resolve(targetClaude, 'settings.local.json');
  if (existsSync(settingsLocalTmpl) && !existsSync(settingsLocal)) {
    const content = readFileSync(settingsLocalTmpl, 'utf-8').replace(/__PROJECT__/g, projectName);
    writeFileSync(settingsLocal, content);
  }
  // Remove the template so users don't accidentally edit it thinking it's live.
  if (existsSync(settingsLocalTmpl)) {
    rmSync(settingsLocalTmpl);
  }

  // Ensure hook scripts are executable (cpSync preserves mode, but play safe).
  for (const name of ['stop.sh', 'start.sh']) {
    const hookPath = resolve(targetClaude, 'hooks', name);
    if (existsSync(hookPath)) {
      try { chmodSync(hookPath, 0o755); } catch { /* non-fatal */ }
    }
  }

  // v0.43.0: Link skills from ~/.coral/skills/ to project-level .claude/skills/.
  // 默认 symlink（本机稳定路径，省空间，自动跟随 ~/.coral/skills/ 更新）；
  // symlink 失败（比如 Windows 无权限）回退 cpSync。
  // 已存在的 skill 目录保留——frozen 副本不覆盖。
  installProjectSkills(projectDir, log);

  // Append .claude/ entries to .gitignore (idempotent).
  // settings.local.json: 本地覆盖不进仓库。
  // skills/: symlink 到本机 ~/.coral/，不该入库。
  const gitignore = resolve(projectDir, '.gitignore');
  const entries = ['.claude/settings.local.json'];
  let existing = '';
  if (existsSync(gitignore)) existing = readFileSync(gitignore, 'utf-8');
  for (const entry of entries) {
    if (!existing.split('\n').some(line => line.trim() === entry)) {
      const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
      appendFileSync(gitignore, `${prefix}${entry}\n`);
      existing += `${prefix}${entry}\n`;
    }
  }
  ensureSkillsGitignore(projectDir);

  log.ok(preExisted
    ? `Refreshed .claude/ preset in ${projectDir} (existing files preserved)`
    : `Installed .claude/ preset into ${projectDir}`);
}

/**
 * v0.43.0: Link user-level skills (~/.coral/skills/) into the project's
 * .claude/skills/ directory via symlink (cpSync fallback).
 *
 * Idempotent:
 *  - absent → symlink（或回退 cpSync）
 *  - linked / frozen → 保留
 *
 * 每个 skill 是含 SKILL.md 的目录；目录名对应卡片 `skills:` 字段值
 * （例如 "frontend" → .claude/skills/frontend/ → ~/.coral/skills/frontend/）。
 */
function installProjectSkills(projectDir: string, log: Logger): void {
  try {
    const { linked, copied, kept } = syncAllSkillsToProject(projectDir);
    if (linked + copied + kept === 0) {
      log.info(`No user-level skills at ~/.coral/skills/ — nothing to link`);
      return;
    }
    const parts: string[] = [];
    if (linked > 0) parts.push(`${linked} linked`);
    if (copied > 0) parts.push(`${copied} copied (symlink fallback)`);
    if (kept > 0) parts.push(`${kept} kept`);
    log.ok(`Project skills: ${parts.join(', ')}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Skill install failed (non-fatal): ${msg}`);
  }
}

/**
 * Non-interactive init options. When provided to `executeProjectInit`, skips
 * the readline prompts and uses these values directly. Used by the Console
 * POST /api/projects endpoint so the whole CLI flow can run from a web form.
 */
export interface ProjectInitOpts {
  projectDir: string;
  mergeBranch: string;
  maxWorkers: string;
  gitlabProject?: string;
  gitlabProjectId?: string;
  matrixRoomId?: string;
}

export async function executeProjectInit(
  project: string,
  flags: Record<string, boolean>,
  nonInteractive?: ProjectInitOpts,
): Promise<void> {
  const log = new Logger('project-init', project);

  if (!project) {
    // CLI prints usage & exits; API never reaches here since it validates upfront
    if (nonInteractive) throw new Error('project name required');
    log.error('Usage: sps project init <project>');
    process.exit(2);
  }

  const instanceDir = resolve(HOME, '.coral', 'projects', project);

  if (existsSync(instanceDir) && !flags.force) {
    if (nonInteractive) throw new Error(`Project already exists: ${project}`);
    log.error(`Project directory already exists: ${instanceDir}`);
    log.info('Use --force to overwrite templates (conf will NOT be overwritten)');
    process.exit(1);
  }

  // Create directory structure
  const dirs = [
    instanceDir,
    resolve(instanceDir, 'logs'),
    resolve(instanceDir, 'pm_meta'),
    resolve(instanceDir, 'runtime'),
  ];

  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      log.ok(`Created ${dir}`);
    }
  }

  // Generate conf — interactive if new (and no nonInteractive opts), skip if exists
  const confDst = resolve(instanceDir, 'conf');
  if (!existsSync(confDst) || flags.force) {
    let projectDir: string;
    let mergeBranch: string;
    let maxWorkers: string;
    let gitlabProject: string;
    let gitlabProjectId: string;
    let matrixRoomId: string;

    if (nonInteractive) {
      projectDir = nonInteractive.projectDir;
      mergeBranch = nonInteractive.mergeBranch;
      maxWorkers = nonInteractive.maxWorkers;
      gitlabProject = nonInteractive.gitlabProject ?? '';
      gitlabProjectId = nonInteractive.gitlabProjectId ?? '';
      matrixRoomId = nonInteractive.matrixRoomId ?? '';
    } else {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ask = (question: string, defaultValue?: string): Promise<string> => {
        const suffix = defaultValue ? ` [${defaultValue}]` : '';
        return new Promise((res) => {
          rl.question(`  ${question}${suffix}: `, (answer) => {
            res(answer.trim() || defaultValue || '');
          });
        });
      };

      console.log(`\n  Configure project: ${project}`);
      console.log('  Press Enter to accept default value.\n');

      // Required
      projectDir = await ask('Repository path', resolve(HOME, 'projects', project));
      mergeBranch = await ask('Merge target branch', 'main');
      maxWorkers = await ask('Max concurrent workers', '1');

      // Git remote (optional)
      console.log('\n  ── Git Remote (optional, leave blank to skip) ──');
      gitlabProject = await ask('Git remote project path (e.g. user/repo)', '');
      gitlabProjectId = gitlabProject ? await ask('GitLab project ID (number, blank if GitHub)', '') : '';

      // Notification
      console.log('\n  ── Notifications ──');
      matrixRoomId = await ask('Matrix room ID (blank to use global)', '');

      rl.close();
    }

    // Build conf — only the user's actual values (clean, minimal)
    const confLines: string[] = [
      `# SPS Project Config — ${project}`,
      `# Generated by: sps project init (${new Date().toISOString().slice(0, 10)})`,
      `# Full parameter reference: conf.example`,
      '',
      `export PROJECT_NAME="${project}"`,
      `export PROJECT_DIR="${projectDir}"`,
      '',
    ];
    if (gitlabProject) confLines.push(`export GITLAB_PROJECT="${gitlabProject}"`);
    if (gitlabProjectId) confLines.push(`export GITLAB_PROJECT_ID="${gitlabProjectId}"`);
    confLines.push(`export GITLAB_MERGE_BRANCH="${mergeBranch}"`);
    confLines.push('');
    // v0.42.0: PM_TOOL is always markdown (Plane/Trello removed)
    confLines.push(`export PM_TOOL="markdown"`);
    confLines.push('export PIPELINE_LABEL="AI-PIPELINE"');
    confLines.push('export MR_MODE="none"');
    confLines.push('');
    confLines.push('export WORKER_TRANSPORT="acp-sdk"');
    confLines.push(`export MAX_CONCURRENT_WORKERS=${maxWorkers}`);
    confLines.push('export MAX_ACTIONS_PER_TICK=3');
    confLines.push('');
    confLines.push('export INPROGRESS_TIMEOUT_HOURS=2');
    confLines.push('export MONITOR_AUTO_QA=true');
    confLines.push('export CONFLICT_DEFAULT="serial"');
    if (matrixRoomId) {
      confLines.push('');
      confLines.push(`export MATRIX_ROOM_ID="${matrixRoomId}"`);
    }
    confLines.push('');

    writeFileSync(confDst, confLines.join('\n') + '\n');
    chmodSync(confDst, 0o600);
    log.ok('Generated conf with your settings');
  } else {
    log.info('conf already exists, skipping (use --force to regenerate)');
  }

  // Always write conf.example — full parameter reference (English)
  const confExamplePath = resolve(instanceDir, 'conf.example');
  writeFileSync(confExamplePath, `# ══════════════════════════════════════════════════════════════════
# SPS Project Config — Full Parameter Reference
# ══════════════════════════════════════════════════════════════════
# This file is for reference only. SPS does NOT load it.
# Copy parameters you need into the 'conf' file in the same directory.
# ══════════════════════════════════════════════════════════════════

# ── Project Info (required) ──────────────────────────────────────
# PROJECT_NAME: Unique project identifier used internally by SPS
export PROJECT_NAME="my-project"
# PROJECT_DIR: Local path to the code repository
export PROJECT_DIR="$HOME/projects/my-project"

# ── Git Remote ───────────────────────────────────────────────────
# GITLAB_PROJECT: GitLab/GitHub project path (format: user/repo or group/repo)
#   Used for doctor checks, MR creation, etc. Leave blank to skip GitLab API features.
export GITLAB_PROJECT="user/repo"
# GITLAB_PROJECT_ID: GitLab numeric project ID (GitLab only; leave blank for GitHub)
#   Find it at GitLab > Settings > General
export GITLAB_PROJECT_ID="42"
# GITLAB_MERGE_BRANCH: Target branch for worker code merges
export GITLAB_MERGE_BRANCH="main"

# ── PM Backend ───────────────────────────────────────────────────
# PM_TOOL: Task management backend (v0.42.0+: markdown is the only option)
#   Cards are stored as markdown files under ~/.coral/projects/<name>/cards/<state>/
export PM_TOOL="markdown"

# ── Pipeline Control ────────────────────────────────────────────
# PIPELINE_LABEL: Label that marks a card for pipeline processing (required on each card)
export PIPELINE_LABEL="AI-PIPELINE"
# MR_MODE: Merge request mode
#   - none: Worker pushes directly to target branch (default, recommended)
#   - create: Worker creates a GitLab MR (requires GITLAB_PROJECT_ID)
export MR_MODE="none"

# ── Worker / Agent ───────────────────────────────────────────────
# claude is the only supported CLI. No selector exposed.
# WORKER_TRANSPORT: Worker communication protocol (fixed, do not change)
export WORKER_TRANSPORT="acp-sdk"
# MAX_CONCURRENT_WORKERS: Maximum parallel workers
#   Determines how many cards can be processed simultaneously. Start with 1.
export MAX_CONCURRENT_WORKERS=1
# MAX_ACTIONS_PER_TICK: Max new tasks launched per tick cycle
export MAX_ACTIONS_PER_TICK=3
# DEFAULT_WORKER_SKILLS: Skill profiles loaded by all workers (comma-separated)
#   Can also use skill:xxx labels on individual cards
#   Available: fullstack, frontend, backend, phaser, typescript, reviewer, architect, etc.
# export DEFAULT_WORKER_SKILLS="fullstack"

# ── Timeouts & Policies ─────────────────────────────────────────
# INPROGRESS_TIMEOUT_HOURS: Max hours a worker can stay in Inprogress
#   After timeout, MonitorEngine marks it as STALE-RUNTIME
export INPROGRESS_TIMEOUT_HOURS=2
# WORKER_LAUNCH_TIMEOUT_S: Worker spawn timeout (seconds)
#   If no output after N seconds, spawn is considered failed
# export WORKER_LAUNCH_TIMEOUT_S=120
# WORKER_IDLE_TIMEOUT_M: Worker idle timeout (minutes)
#   If no new output for N minutes, worker is considered stuck
# export WORKER_IDLE_TIMEOUT_M=30
# WORKER_RESTART_LIMIT: Max auto-retry count on worker failure
# export WORKER_RESTART_LIMIT=2
# WORKER_ACK_TIMEOUT_S: ACK probe timeout (seconds)
#   After dispatch, if no STARTED-<stage> label appears within this window,
#   MonitorEngine flags ACK-TIMEOUT (Claude never acknowledged the prompt via
#   its UserPromptSubmit hook). Default 60s (= 2 tick intervals). Raise if your
#   PM backend is slow (network-heavy Plane/Trello).
# export WORKER_ACK_TIMEOUT_S=60
# WORKER_ACK_MAX_RETRIES: Max ACK retry attempts before escalating to NEEDS-FIX
#   On ACK-TIMEOUT, StageEngine kills the worker and re-dispatches this many
#   times (with a fresh claude-agent-acp session). Default 1.
# export WORKER_ACK_MAX_RETRIES=1
# MONITOR_AUTO_QA: Auto-advance to QA when stale runtime detected
#   true = auto-advance (for fully automated pipelines)
#   false = only label STALE-RUNTIME, requires manual action
export MONITOR_AUTO_QA=true
# CONFLICT_DEFAULT: Default conflict domain policy (for cards without conflict: labels)
#   serial = default to serial (safe, one card at a time)
#   parallel = default to parallel
export CONFLICT_DEFAULT="serial"
# TICK_LOCK_TIMEOUT_MINUTES: Tick lock timeout (minutes), prevents concurrent ticks
# export TICK_LOCK_TIMEOUT_MINUTES=10

# ── Notifications ────────────────────────────────────────────────
# MATRIX_ROOM_ID: Matrix notification room (project-level override; blank uses ~/.coral/env global)
# export MATRIX_ROOM_ID="!roomid:server.com"

# ── Path Overrides (usually no need to change) ──────────────────
# WORKTREE_DIR: Worker worktree root (default: ~/.coral/worktrees/<project>/)
# export WORKTREE_DIR=""
# LOGS_DIR: Log directory (default: ~/.coral/projects/<project>/logs/)
# export LOGS_DIR=""
`);
  log.ok('Updated conf.example (full parameter reference)');

  // Create empty pipeline_order.json if not exists
  const orderFile = resolve(instanceDir, 'pipeline_order.json');
  if (!existsSync(orderFile)) {
    writeFileSync(orderFile, '[]\n');
    log.ok('Created empty pipeline_order.json');
  }

  // Create/update pipelines directory with sample template
  const pipelinesDir = resolve(instanceDir, 'pipelines');
  if (!existsSync(pipelinesDir)) mkdirSync(pipelinesDir, { recursive: true });
  {
    const samplePath = resolve(pipelinesDir, 'sample.yaml.example');
    writeFileSync(samplePath, `# ══════════════════════════════════════════════════════════════════
# SPS Pipeline Configuration (v0.37.0 — Single Worker Model)
# ══════════════════════════════════════════════════════════════════
# To activate: copy this file to project.yaml
#   cp sample.yaml.example project.yaml
# ══════════════════════════════════════════════════════════════════

mode: project

# git: true  = code project (worker commits + pushes to current branch)
# git: false = non-code project (document processing, data tasks)
# git: true

# ── Stages ───────────────────────────────────────────────────────
# Single worker executes stages serially. One card at a time.
# If a card fails, the pipeline halts until resolved (halt: true).
#
# Required fields:
#   name:       Stage name (unique)
#   on_complete: "move_card <next_state>" or "move_card Done"
#
# Optional fields:
#   profile:    Skill profile (see ~/.coral/skills/dev-worker/references/)
#   on_fail:    Failure handling
#     action:   "label <LABEL>" — add label to card
#     comment:  Comment text
#     halt:     true (default) — stop pipeline on failure
#               false — continue to next card
#   timeout:    Max duration (30s / 5m / 2h)

# ── Simple: 1 stage (develop → Done) ────────────────────────────
stages:
  - name: develop
    # profile: fullstack
    on_complete: "move_card Done"
    on_fail:
      action: "label NEEDS-FIX"
      comment: "Worker failed. Check logs."

# ── Standard: 2 stages (develop → review → Done) ────────────────
# Uncomment to add code review:
#
# stages:
#   - name: develop
#     profile: fullstack
#     on_complete: "move_card Review"
#     on_fail:
#       action: "label NEEDS-FIX"
#       halt: true
#
#   - name: review
#     profile: reviewer
#     on_complete: "move_card Done"
#     on_fail:
#       action: "label REVIEW-FAILED"
#       halt: true
`);
    log.ok(`Created pipelines/ with sample template`);
  }

  // Initialize state.json
  const stateFile = resolve(instanceDir, 'runtime', 'state.json');
  if (!existsSync(stateFile)) {
    const { writeState } = await import('../core/state.js');
    const maxW = parseInt(String(flags.maxWorkers || '3'), 10) || 3;
    const { createIdleWorkerSlot } = await import('../core/state.js');
    const workers: Record<string, any> = {};
    for (let i = 1; i <= maxW; i++) {
      workers[`worker-${i}`] = createIdleWorkerSlot();
    }
    const initState = {
      workers, activeCards: {}, leases: {},
      worktreeEvidence: {}, sessions: {},
      integrationQueues: {}, worktreeCleanup: [] as never[],
      pendingPMActions: [],
    };
    writeState(stateFile, initState as any, 'project-init');
    log.ok('Initialized state.json');
  }

  // Cards directory — only create seq.txt; state subdirectories will be
  // created by MarkdownTaskBackend.bootstrap() based on pipeline YAML config
  const cardsDir = resolve(instanceDir, 'cards');
  if (!existsSync(cardsDir)) {
    mkdirSync(cardsDir, { recursive: true });
    writeFileSync(resolve(cardsDir, 'seq.txt'), '0\n');
    log.ok('Initialized cards/ directory (state dirs created on first use)');
  }

  // Initialize memory directory
  const memoryDir = resolve(HOME, '.coral', 'memory', 'projects', project);
  if (!existsSync(memoryDir)) {
    mkdirSync(memoryDir, { recursive: true });
    log.ok(`Created project memory at ${memoryDir}`);
  }

  // Install Claude preset into the target project repo (if it exists).
  // Read PROJECT_DIR from the generated conf (covers both interactive and
  // existing-conf paths; no need to thread projectDir through local scope).
  try {
    const confContent = readFileSync(confDst, 'utf-8');
    const match = confContent.match(/export\s+PROJECT_DIR=["']?([^"'\n]+)/);
    const projectDir = match?.[1]?.trim();
    if (projectDir) {
      installClaudePreset(projectDir, project, log);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`Could not install Claude preset (non-fatal): ${msg}`);
  }

  log.ok(`Project ${project} initialized at ${instanceDir}`);
  console.log('\n  Next steps:\n');
  console.log(`  1. Create pipeline config:`);
  console.log(`     cp ${resolve(instanceDir, 'pipelines', 'sample.yaml.example')} ${resolve(instanceDir, 'pipelines', 'project.yaml')}`);
  console.log(`     vim ${resolve(instanceDir, 'pipelines', 'project.yaml')}`);
  console.log(`     Or use: sps agent --chat → "帮我创建 pipeline"`);
  console.log('');
  console.log(`  2. Add task cards:`);
  console.log(`     sps card add ${project} "task title" "description"`);
  console.log('');
  console.log(`  3. Start pipeline:`);
  console.log(`     sps tick ${project}`);
  console.log('');
  console.log(`  Optional: sps doctor ${project} --fix  (generate CLAUDE.md in repo)`);
  console.log('');
}
