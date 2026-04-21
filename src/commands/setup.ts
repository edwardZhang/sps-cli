/**
 * @module        setup
 * @description   全局环境初始化向导，配置 SPS 运行所需的目录、密钥和全局设置
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
 * @trigger       sps setup [--force]
 * @inputs        交互式用户输入（API key、配置项）
 * @outputs       ~/.coral/ 目录结构和全局配置文件
 * @workflow      1. 创建目录结构 → 2. 交互式收集配置 → 3. 写入 env 文件 → 4. 安装技能文件
 */
import { execSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Logger } from '../core/logger.js';

const HOME = process.env.HOME || '/home/coral';
const ENV_PATH = resolve(HOME, '.coral', 'env');
const PROJECTS_DIR = resolve(HOME, '.coral', 'projects');
const SKILLS_SRC_DIR = resolve(HOME, '.coral', 'skills');

function createPrompt(): { ask: (question: string, defaultValue?: string) => Promise<string>; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    ask: (question: string, defaultValue?: string): Promise<string> => {
      const suffix = defaultValue ? ` [${defaultValue}]` : '';
      return new Promise((resolve) => {
        rl.question(`  ${question}${suffix}: `, (answer) => {
          resolve(answer.trim() || defaultValue || '');
        });
      });
    },
    close: () => rl.close(),
  };
}

export async function executeSetup(flags: Record<string, boolean>): Promise<void> {
  const log = new Logger('setup', '');
  const prompt = createPrompt();

  console.log('');
  console.log('   ██████╗ ██████╗ ██████╗  █████╗ ██╗         ███████╗██████╗ ███████╗');
  console.log('  ██╔════╝██╔═══██╗██╔══██╗██╔══██╗██║         ██╔════╝██╔══██╗██╔════╝');
  console.log('  ██║     ██║   ██║██████╔╝███████║██║         ███████╗██████╔╝███████╗');
  console.log('  ██║     ██║   ██║██╔══██╗██╔══██║██║         ╚════██║██╔═══╝ ╚════██║');
  console.log('  ╚██████╗╚██████╔╝██║  ██║██║  ██║███████╗    ███████║██║     ███████║');
  console.log('   ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝    ╚══════╝╚═╝     ╚══════╝');
  console.log('');
  console.log('  AI-Driven Development Pipeline Orchestrator');
  console.log('  ──────────────────────────────────────────────────────────────────────');
  console.log('  Automate the full dev lifecycle: task cards → AI coding → push → merge.');
  console.log('  Supports Markdown PM backend, GitLab/GitHub, Claude (via ACP), Matrix.');
  console.log('  https://www.npmjs.com/package/@coralai/sps-cli');
  console.log('');

  // ─── Step 1: ~/.coral/ directory structure ──────────────────────
  const dirs = [
    PROJECTS_DIR,
    resolve(HOME, '.coral', 'memory', 'user'),
    resolve(HOME, '.coral', 'memory', 'agents'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      log.ok(`Created ${dir}`);
    } else {
      log.ok(`${dir} already exists`);
    }
  }

  // ─── Step 1.5: Install bundled skills to ~/.coral/skills/ ───────
  {
    const thisFile = fileURLToPath(import.meta.url);
    const bundledSkillsDir = resolve(dirname(thisFile), '..', '..', 'skills');

    if (existsSync(bundledSkillsDir)) {
      mkdirSync(SKILLS_SRC_DIR, { recursive: true });
      const skillDirs = readdirSync(bundledSkillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      let installed = 0;
      for (const dir of skillDirs) {
        const src = resolve(bundledSkillsDir, dir.name);
        const dest = resolve(SKILLS_SRC_DIR, dir.name);
        if (!existsSync(dest) || flags.force) {
          // Copy entire skill directory recursively
          copyDirRecursive(src, dest);
          installed++;
        }
      }
      log.ok(`Installed ${installed} system skill(s) to ${SKILLS_SRC_DIR} (${skillDirs.length} total)`);
    } else {
      log.warn(`Bundled skills not found at ${bundledSkillsDir} — skipping`);
    }
  }

  // ─── Step 2: ~/.coral/env ───────────────────────────────────────
  {
    // Load existing values as defaults (empty if no prior config)
    const existing: Record<string, string> = {};
    if (existsSync(ENV_PATH)) {
      const content = readFileSync(ENV_PATH, 'utf-8');
      for (const line of content.split('\n')) {
        const match = line.trim().match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=["']?(.*?)["']?\s*$/);
        if (match) existing[match[1]] = match[2];
      }
      if (!flags.force) {
        log.ok(`${ENV_PATH} already exists (use --force to reconfigure)`);
      }
    }

    // Mask secrets for display: show first 4 chars + ****
    const mask = (val: string | undefined): string => {
      if (!val) return '';
      if (val.length <= 6) return '****';
      return val.slice(0, 4) + '****';
    };

    if (!existsSync(ENV_PATH) || flags.force) {
    console.log('\n  Configure global credentials (~/.coral/env)');
    console.log('  Press Enter to keep existing value (shown in brackets).\n');

    // Git Remote (GitLab / GitHub / other)
    console.log('  ── Git Remote (GitLab / GitHub — leave blank if not needed) ──');
    const gitlabUrl = await prompt.ask('GITLAB_URL', existing.GITLAB_URL || '');
    const gitlabToken = await prompt.ask('GITLAB_TOKEN', mask(existing.GITLAB_TOKEN) ? `${mask(existing.GITLAB_TOKEN)} — Enter to keep` : '');
    // If user pressed Enter on masked token, keep the original
    const finalGitlabToken = (gitlabToken.includes('****') || gitlabToken.includes('— Enter to keep') || gitlabToken === '') && existing.GITLAB_TOKEN
      ? existing.GITLAB_TOKEN : gitlabToken;
    const defaultSshHost = gitlabUrl ? (() => { try { return new URL(gitlabUrl).hostname; } catch { return ''; } })() : existing.GITLAB_SSH_HOST || '';
    const gitlabSshHost = await prompt.ask('GITLAB_SSH_HOST', defaultSshHost);
    const gitlabSshPort = await prompt.ask('GITLAB_SSH_PORT', existing.GITLAB_SSH_PORT || '22');

    // v0.42.0: PM backend is markdown only (Plane/Trello removed).
    // No PM-related env prompts needed — cards live in ~/.coral/projects/<name>/cards/.

    // Matrix notifications
    console.log('\n  ── Notifications (Matrix) ──');
    const matrixHomeserver = await prompt.ask('MATRIX_HOMESERVER', existing.MATRIX_HOMESERVER || '');
    const matrixToken = matrixHomeserver ? await prompt.ask('MATRIX_ACCESS_TOKEN', mask(existing.MATRIX_ACCESS_TOKEN) ? `${mask(existing.MATRIX_ACCESS_TOKEN)} — Enter to keep` : '') : '';
    const finalMatrixToken = (matrixToken.includes('****') || matrixToken.includes('— Enter to keep') || matrixToken === '') && existing.MATRIX_ACCESS_TOKEN
      ? existing.MATRIX_ACCESS_TOKEN : matrixToken;
    const matrixRoomId = matrixHomeserver ? await prompt.ask('MATRIX_ROOM_ID', existing.MATRIX_ROOM_ID || '') : '';

    // Build env file
    const lines: string[] = [
      '# SPS CLI — Global Credentials',
      `# Generated by: sps setup (${new Date().toISOString().slice(0, 10)})`,
      '',
    ];

    if (gitlabUrl || finalGitlabToken) {
      lines.push('# ── Git Remote ──────────────────────────────────────');
      if (gitlabUrl) lines.push(`export GITLAB_URL="${gitlabUrl}"`);
      if (finalGitlabToken) lines.push(`export GITLAB_TOKEN="${finalGitlabToken}"`);
      if (gitlabSshHost) lines.push(`export GITLAB_SSH_HOST="${gitlabSshHost}"`);
      if (gitlabSshPort && gitlabSshPort !== '22') lines.push(`export GITLAB_SSH_PORT="${gitlabSshPort}"`);
      lines.push('');
    }

    if (matrixHomeserver) {
      lines.push('# ── Matrix (Notifications) ──────────────────────────');
      lines.push(`export MATRIX_HOMESERVER="${matrixHomeserver}"`);
      if (finalMatrixToken) lines.push(`export MATRIX_ACCESS_TOKEN="${finalMatrixToken}"`);
      if (matrixRoomId) lines.push(`export MATRIX_ROOM_ID="${matrixRoomId}"`);
      lines.push('');
    }

    writeFileSync(ENV_PATH, lines.join('\n') + '\n');
    chmodSync(ENV_PATH, 0o600);
    log.ok(`Saved ${ENV_PATH} (permissions: 600)`);
    } // closes: if (!existsSync(ENV_PATH) || flags.force)
  } // closes: Step 2 block

  // ─── Step 3: Skill sync (symlink ~/.coral/skills → agent skill dirs) ──
  {
    const synced = syncSkills(log);
    if (synced > 0) {
      log.ok(`Synced ${synced} skill(s) to agent directories`);
    } else if (existsSync(SKILLS_SRC_DIR)) {
      log.info('No skills to sync (directory empty)');
    } else {
      log.info(`No skills directory at ${SKILLS_SRC_DIR} — skipping sync`);
    }
  }

  // ─── Step 4: Install claude-agent-acp adapter globally ──────────
  {
    const adapter = { name: 'claude-agent-acp', pkg: '@agentclientprotocol/claude-agent-acp' };
    try {
      execSync(`which ${adapter.name}`, { stdio: 'ignore' });
      log.ok(`${adapter.name} already installed`);
    } catch {
      log.info(`Installing ${adapter.name}...`);
      try {
        execSync(`npm install -g ${adapter.pkg}`, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
        log.ok(`Installed ${adapter.name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(`Failed to install ${adapter.name}: ${msg}`);
        log.info(`  You can install manually: npm install -g ${adapter.pkg}`);
      }
    }
  }

  // ─── Summary ───────────────────────────────────────────────────
  console.log('\n  Setup complete! Next steps:\n');
  console.log('  1. Source the env file:');
  console.log(`     source ${ENV_PATH}`);
  console.log('');
  console.log('  2. (Optional) Auto-load on shell startup:');
  console.log(`     echo 'source ${ENV_PATH}' >> ~/.bashrc`);
  console.log('');
  console.log('  3. Initialize your first project:');
  console.log('     sps project init <project-name>');
  console.log('');
  console.log('  4. Edit the project config:');
  console.log('     vim ~/.coral/projects/<project-name>/conf');
  console.log('');
  console.log('  5. Run health check:');
  console.log('     sps doctor <project-name> --fix');
  console.log('');

  prompt.close();
}

// ─── Skill Sync ──────────────────────────────────────────────────

/** Agent skill directories (user-level) */
const AGENT_SKILL_DIRS = [
  resolve(HOME, '.claude', 'skills'),   // Claude Code (only supported agent)
];

/**
 * Sync skills from ~/.coral/skills/ to agent skill directories via symlink.
 * Each skill is a directory with SKILL.md inside.
 * Returns number of skills synced.
 */
export function syncSkills(log?: Logger): number {
  if (!existsSync(SKILLS_SRC_DIR)) return 0;

  const skillDirs = readdirSync(SKILLS_SRC_DIR, { withFileTypes: true })
    .filter(d => {
      // 普通目录或指向目录的 symlink（外部 skill 包常用 symlink 接入）
      const name = d.name;
      const isDir = d.isDirectory() || (d.isSymbolicLink() && (() => {
        try { return statSync(resolve(SKILLS_SRC_DIR, name)).isDirectory(); } catch { return false; }
      })());
      return isDir && existsSync(resolve(SKILLS_SRC_DIR, name, 'SKILL.md'));
    })
    .map(d => d.name);

  if (skillDirs.length === 0) return 0;

  let synced = 0;
  for (const targetDir of AGENT_SKILL_DIRS) {
    // Create agent skill directory if it doesn't exist
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    for (const skill of skillDirs) {
      const src = resolve(SKILLS_SRC_DIR, skill);
      const dest = resolve(targetDir, skill);

      // Already a correct symlink — skip
      try {
        const stat = lstatSync(dest);
        if (stat.isSymbolicLink()) {
          const linkTarget = readlinkSync(dest);
          if (linkTarget === src) continue; // correct symlink already exists
          // Wrong target — will recreate below
        }
        // Not a symlink (real directory) — skip to avoid overwriting user files
        if (stat.isDirectory()) {
          log?.info(`Skipping ${skill} in ${targetDir} (real directory, not managed by SPS)`);
          continue;
        }
      } catch {
        // Doesn't exist — create symlink
      }

      try {
        // Remove stale symlink if exists
        try { unlinkSync(dest); } catch { /* doesn't exist */ }
        symlinkSync(src, dest);
        log?.ok(`Linked ${skill} → ${targetDir}/`);
        synced++;
      } catch (err) {
        log?.warn?.(`Failed to link ${skill}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return synced;
}

/** Recursively copy a directory */
function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = resolve(src, entry.name);
    const destPath = resolve(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}
