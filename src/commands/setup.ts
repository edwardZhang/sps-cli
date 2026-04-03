import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Logger } from '../core/logger.js';

const HOME = process.env.HOME || '/home/coral';
const ENV_PATH = resolve(HOME, '.coral', 'env');
const PROJECTS_DIR = resolve(HOME, '.coral', 'projects');
const PROFILES_DIR = resolve(HOME, '.coral', 'profiles');
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
  console.log('  Automate the full dev lifecycle: task cards → AI coding → MR → merge.');
  console.log('  Supports Plane/Trello/Markdown, GitLab, Claude Code/Codex, Matrix.');
  console.log('  https://www.npmjs.com/package/@coralai/sps-cli');
  console.log('');

  // ─── Step 1: ~/.coral/projects directory ───────────────────────
  if (!existsSync(PROJECTS_DIR)) {
    mkdirSync(PROJECTS_DIR, { recursive: true });
    log.ok(`Created ${PROJECTS_DIR}`);
  } else {
    log.ok(`${PROJECTS_DIR} already exists`);
  }

  // ─── Step 1.5: Install worker skill profiles to ~/.coral/profiles/ ──
  {
    // Resolve bundled profiles directory relative to compiled JS location
    // dist/commands/setup.js → ../../profiles/
    const thisFile = fileURLToPath(import.meta.url);
    const bundledProfilesDir = resolve(dirname(thisFile), '..', '..', 'profiles');

    if (existsSync(bundledProfilesDir)) {
      mkdirSync(PROFILES_DIR, { recursive: true });
      const files = readdirSync(bundledProfilesDir).filter(f => f.endsWith('.md'));
      let installed = 0;
      for (const file of files) {
        const src = resolve(bundledProfilesDir, file);
        const dest = resolve(PROFILES_DIR, file);
        // Only overwrite bundled profiles, preserve user-created ones
        if (!existsSync(dest) || flags.force) {
          copyFileSync(src, dest);
          installed++;
        }
      }
      log.ok(`Installed ${installed} skill profiles to ${PROFILES_DIR} (${files.length} total)`);
    } else {
      log.warn(`Bundled profiles not found at ${bundledProfilesDir} — skipping`);
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

    // GitLab
    console.log('  ── GitLab ──');
    const gitlabUrl = await prompt.ask('GITLAB_URL', existing.GITLAB_URL || '');
    const gitlabToken = await prompt.ask('GITLAB_TOKEN', mask(existing.GITLAB_TOKEN) ? `${mask(existing.GITLAB_TOKEN)} — Enter to keep` : '');
    // If user pressed Enter on masked token, keep the original
    const finalGitlabToken = (gitlabToken.includes('****') || gitlabToken.includes('— Enter to keep') || gitlabToken === '') && existing.GITLAB_TOKEN
      ? existing.GITLAB_TOKEN : gitlabToken;
    const defaultSshHost = gitlabUrl ? (() => { try { return new URL(gitlabUrl).hostname; } catch { return ''; } })() : existing.GITLAB_SSH_HOST || '';
    const gitlabSshHost = await prompt.ask('GITLAB_SSH_HOST', defaultSshHost);
    const gitlabSshPort = await prompt.ask('GITLAB_SSH_PORT', existing.GITLAB_SSH_PORT || '22');

    // PM Backend
    console.log('\n  ── PM Backend (Plane) ──');
    const planeUrl = await prompt.ask('PLANE_URL', existing.PLANE_URL || '');
    const planeApiKey = planeUrl ? await prompt.ask('PLANE_API_KEY', mask(existing.PLANE_API_KEY) ? `${mask(existing.PLANE_API_KEY)} — Enter to keep` : '') : '';
    const finalPlaneApiKey = (planeApiKey.includes('****') || planeApiKey.includes('— Enter to keep') || planeApiKey === '') && existing.PLANE_API_KEY
      ? existing.PLANE_API_KEY : planeApiKey;
    const planeWorkspace = planeUrl ? await prompt.ask('PLANE_WORKSPACE_SLUG', existing.PLANE_WORKSPACE_SLUG || '') : '';

    // Trello
    console.log('\n  ── PM Backend (Trello) ──');
    const trelloApiKey = await prompt.ask('TRELLO_API_KEY', existing.TRELLO_API_KEY || '');
    const trelloToken = trelloApiKey ? await prompt.ask('TRELLO_TOKEN', mask(existing.TRELLO_TOKEN) ? `${mask(existing.TRELLO_TOKEN)} — Enter to keep` : '') : '';
    const finalTrelloToken = (trelloToken.includes('****') || trelloToken.includes('— Enter to keep') || trelloToken === '') && existing.TRELLO_TOKEN
      ? existing.TRELLO_TOKEN : trelloToken;

    // Default Agent
    console.log('\n  ── Default Agent ──');
    const defaultAgent = await prompt.ask('DEFAULT_AGENT (claude/codex)', existing.DEFAULT_AGENT || 'claude');

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
      lines.push('# ── GitLab ──────────────────────────────────────────');
      if (gitlabUrl) lines.push(`export GITLAB_URL="${gitlabUrl}"`);
      if (finalGitlabToken) lines.push(`export GITLAB_TOKEN="${finalGitlabToken}"`);
      if (gitlabSshHost) lines.push(`export GITLAB_SSH_HOST="${gitlabSshHost}"`);
      if (gitlabSshPort && gitlabSshPort !== '22') lines.push(`export GITLAB_SSH_PORT="${gitlabSshPort}"`);
      lines.push('');
    }

    if (planeUrl) {
      lines.push('# ── Plane ───────────────────────────────────────────');
      lines.push(`export PLANE_URL="${planeUrl}"`);
      if (finalPlaneApiKey) lines.push(`export PLANE_API_KEY="${finalPlaneApiKey}"`);
      if (planeWorkspace) lines.push(`export PLANE_WORKSPACE_SLUG="${planeWorkspace}"`);
      lines.push('');
    }

    if (trelloApiKey) {
      lines.push('# ── Trello ──────────────────────────────────────────');
      lines.push(`export TRELLO_API_KEY="${trelloApiKey}"`);
      if (finalTrelloToken) lines.push(`export TRELLO_TOKEN="${finalTrelloToken}"`);
      lines.push('');
    }

    if (matrixHomeserver) {
      lines.push('# ── Matrix (Notifications) ──────────────────────────');
      lines.push(`export MATRIX_HOMESERVER="${matrixHomeserver}"`);
      if (finalMatrixToken) lines.push(`export MATRIX_ACCESS_TOKEN="${finalMatrixToken}"`);
      if (matrixRoomId) lines.push(`export MATRIX_ROOM_ID="${matrixRoomId}"`);
      lines.push('');
    }

    if (defaultAgent) {
      lines.push('# ── Default Agent ───────────────────────────────────');
      lines.push(`export DEFAULT_AGENT="${defaultAgent}"`);
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
  resolve(HOME, '.claude', 'skills'),   // Claude Code
  resolve(HOME, '.codex', 'skills'),    // Codex
];

/**
 * Sync skills from ~/.coral/skills/ to agent skill directories via symlink.
 * Each skill is a directory with SKILL.md inside.
 * Returns number of skills synced.
 */
export function syncSkills(log?: Logger): number {
  if (!existsSync(SKILLS_SRC_DIR)) return 0;

  const skillDirs = readdirSync(SKILLS_SRC_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(resolve(SKILLS_SRC_DIR, d.name, 'SKILL.md')))
    .map(d => d.name);

  if (skillDirs.length === 0) return 0;

  let synced = 0;
  for (const targetDir of AGENT_SKILL_DIRS) {
    if (!existsSync(targetDir)) {
      // Agent not installed — skip
      continue;
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
