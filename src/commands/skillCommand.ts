/**
 * @module        skillCommand
 * @description   `sps skill` 命令族：list / add / remove / sync / freeze / unfreeze
 *
 * @role          command
 * @layer         command
 * @boundedContext skill-distribution
 *
 * @trigger       sps skill <sub> [name] [--project <p>]
 *
 * 子命令语义：
 *   list                        列出 user-level skills + 当前项目 link 状态
 *   add <name>                  在当前项目建 symlink → ~/.coral/skills/<name>
 *   remove <name>               从当前项目移除 skill（link 或 frozen 副本）
 *   freeze <name>               symlink → 真实副本（允许项目级定制）
 *   unfreeze <name>             真实副本 → symlink（重新跟随全局）
 *   sync                        ① bundled → ~/.coral/skills/，② ~/.coral/skills/ → ~/.claude/skills/
 *
 * 项目定位：默认 cwd（若其 .claude/ 存在），也可通过 --project <name> 指定
 *           ~/.coral/projects/<name>（仍需对应的工作目录）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Logger } from '../core/logger.js';
import {
  addSkillToProject,
  ensureSkillsGitignore,
  freezeSkillInProject,
  inspectProjectSkill,
  listUserSkills,
  projectSkillsDir,
  removeSkillFromProject,
  syncBundledSkillsToUser,
  unfreezeSkillInProject,
  userSkillsRoot,
} from '../core/skillStore.js';

const HOME = process.env.HOME || '/home/coral';
const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * 解析项目目录：
 * - --project <name> → ~/.coral/projects/<name>/<slug>（需存在 .claude/）
 * - 否则：走 cwd（需含 .claude/）
 */
function resolveProjectDir(flagProject: string | undefined, log: Logger): string | null {
  if (flagProject) {
    // 如果传的是绝对/相对路径，直接用
    const asPath = resolve(flagProject);
    if (existsSync(resolve(asPath, '.claude'))) return asPath;
    // 否则当作项目名，查 ~/.coral/projects/<name>/conf 中的 repo 路径
    const projDir = resolve(HOME, '.coral', 'projects', flagProject);
    const confPath = resolve(projDir, 'conf');
    if (existsSync(confPath)) {
      const conf = readFileSync(confPath, 'utf-8');
      const match = conf.match(/^REPO_DIR="?([^"\n]+)"?\s*$/m);
      if (match && existsSync(resolve(match[1], '.claude'))) return resolve(match[1]);
    }
    log.error(`无法定位项目 "${flagProject}" 的工作目录（需含 .claude/）`);
    return null;
  }
  const cwd = process.cwd();
  if (existsSync(resolve(cwd, '.claude'))) return cwd;
  log.error('当前目录没有 .claude/；请在项目根目录运行，或用 --project <name>');
  return null;
}

function resolveBundledSkillsDir(): string {
  // npm 包安装时：dist/commands/skillCommand.js → ../../skills
  const pkgPath = resolve(__dirname, '..', '..', 'skills');
  if (existsSync(pkgPath)) return pkgPath;
  // 源码运行时：src/commands/ → ../../skills
  const srcPath = resolve(__dirname, '..', '..', '..', 'workflow-cli', 'skills');
  if (existsSync(srcPath)) return srcPath;
  return pkgPath;
}

export async function executeSkillCommand(
  subcommand: string,
  positionals: string[],
  flags: Record<string, unknown>,
): Promise<void> {
  const log = new Logger('skill', '');
  const flagProject = typeof flags.project === 'string' ? (flags.project as string) : undefined;

  switch (subcommand) {
    case 'list':
      return skillList(log, flagProject);
    case 'add':
      return skillAdd(log, positionals[0], flagProject);
    case 'remove':
      return skillRemove(log, positionals[0], flagProject);
    case 'freeze':
      return skillFreeze(log, positionals[0], flagProject);
    case 'unfreeze':
      return skillUnfreeze(log, positionals[0], flagProject);
    case 'sync':
      return skillSync(log);
    default:
      console.error('Usage: sps skill <list|add|remove|freeze|unfreeze|sync> [name] [--project <name>]');
      process.exit(2);
  }
}

function skillList(log: Logger, flagProject: string | undefined): void {
  const users = listUserSkills();
  if (users.length === 0) {
    log.info(`~/.coral/skills/ 还没有 skill — 试试 \`sps skill sync\``);
    return;
  }

  const projectDir = resolveProjectDir(flagProject, log);
  console.log('');
  console.log(`  User-level skills (${userSkillsRoot()}):\n`);
  for (const u of users) {
    let state = '';
    if (projectDir) {
      const info = inspectProjectSkill(projectDir, u.name);
      if (info) {
        if (info.state === 'linked') state = '  \x1b[36m[linked]\x1b[0m';
        else if (info.state === 'frozen') state = '  \x1b[33m[frozen]\x1b[0m';
      }
    }
    console.log(`    ${u.name.padEnd(32)}${state}`);
  }
  console.log('');
  if (projectDir) {
    console.log(`  Project: ${projectDir}`);
    console.log('');
  }
}

function skillAdd(log: Logger, name: string | undefined, flagProject: string | undefined): void {
  if (!name) {
    console.error('Usage: sps skill add <name> [--project <name>]');
    process.exit(2);
  }
  const projectDir = resolveProjectDir(flagProject, log);
  if (!projectDir) process.exit(2);

  const result = addSkillToProject(projectDir, name);
  switch (result) {
    case 'linked':
      ensureSkillsGitignore(projectDir);
      log.ok(`${name} → ${projectSkillsDir(projectDir)}/${name} (symlink)`);
      break;
    case 'copied':
      ensureSkillsGitignore(projectDir);
      log.ok(`${name} → ${projectSkillsDir(projectDir)}/${name} (copied, symlink fallback)`);
      break;
    case 'skipped-linked':
      log.info(`${name} 已 linked，跳过`);
      break;
    case 'skipped-frozen':
      log.info(`${name} 已 frozen，跳过（先 unfreeze 再 add 可切回 symlink）`);
      break;
    case 'skipped-absent':
      log.error(`~/.coral/skills/${name} 不存在；\`sps skill list\` 看可用的`);
      process.exit(1);
  }
}

function skillRemove(log: Logger, name: string | undefined, flagProject: string | undefined): void {
  if (!name) {
    console.error('Usage: sps skill remove <name> [--project <name>]');
    process.exit(2);
  }
  const projectDir = resolveProjectDir(flagProject, log);
  if (!projectDir) process.exit(2);

  const removed = removeSkillFromProject(projectDir, name);
  if (removed) {
    log.ok(`移除 ${name}（~/.coral/skills/ 下的原始 skill 未动）`);
  } else {
    log.info(`${name} 不在项目中，无需移除`);
  }
}

function skillFreeze(log: Logger, name: string | undefined, flagProject: string | undefined): void {
  if (!name) {
    console.error('Usage: sps skill freeze <name> [--project <name>]');
    process.exit(2);
  }
  const projectDir = resolveProjectDir(flagProject, log);
  if (!projectDir) process.exit(2);

  const info = inspectProjectSkill(projectDir, name);
  if (!info) {
    log.error(`~/.coral/skills/${name} 不存在`);
    process.exit(1);
  }
  if (info.state === 'absent') {
    log.error(`${name} 还没在项目里，先 \`sps skill add ${name}\``);
    process.exit(1);
  }
  if (info.state === 'frozen') {
    log.info(`${name} 已是 frozen`);
    return;
  }
  if (freezeSkillInProject(projectDir, name)) {
    log.ok(`${name} symlink → 真实副本；现在可以在项目里改动了`);
  } else {
    log.error(`freeze 失败`);
    process.exit(1);
  }
}

function skillUnfreeze(log: Logger, name: string | undefined, flagProject: string | undefined): void {
  if (!name) {
    console.error('Usage: sps skill unfreeze <name> [--project <name>]');
    process.exit(2);
  }
  const projectDir = resolveProjectDir(flagProject, log);
  if (!projectDir) process.exit(2);

  const info = inspectProjectSkill(projectDir, name);
  if (!info) {
    log.error(`~/.coral/skills/${name} 不存在`);
    process.exit(1);
  }
  if (info.state === 'linked') {
    log.info(`${name} 已是 symlink`);
    return;
  }
  if (unfreezeSkillInProject(projectDir, name)) {
    log.ok(`${name} 真实副本 → symlink；项目里的本地改动已丢弃`);
  } else {
    log.error(`unfreeze 失败`);
    process.exit(1);
  }
}

function skillSync(log: Logger): void {
  // 1. bundled (npm 包内) → ~/.coral/skills/
  const bundledDir = resolveBundledSkillsDir();
  const { copied, skipped } = syncBundledSkillsToUser(bundledDir);
  if (copied > 0) log.ok(`Bundled → user: ${copied} copied, ${skipped} kept`);
  else log.info(`Bundled → user: nothing new (${skipped} already installed)`);

  // 2. ~/.coral/skills/ → ~/.claude/skills/（Claude Code 用户级 skill 目录）
  // 复用 setup.ts 中的 syncSkills（symlink 到 ~/.claude/skills/）
  import('./setup.js').then(({ syncSkills }) => {
    const synced = syncSkills(log);
    if (synced > 0) log.ok(`User → ~/.claude/skills/: ${synced} linked`);
    else log.info('User → ~/.claude/skills/: already in sync');
  });
}
