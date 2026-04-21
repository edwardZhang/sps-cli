/**
 * @module        skillStore
 * @description   Skill 分发核心：user-level ~/.coral/skills/ ↔ project-level .claude/skills/
 *
 * @role          core
 * @layer         core
 * @boundedContext skill-distribution
 *
 * @responsibilities
 *   - 列举 user-level skills（~/.coral/skills/）
 *   - 在项目中 add/remove/freeze/unfreeze skill
 *   - 默认用 symlink（同机器稳定路径），失败回退 cpSync
 *   - 区分 linked（symlink）/ frozen（真实副本）/ foreign（未知目录）
 */
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { resolve } from 'node:path';

const HOME = process.env.HOME || '/home/coral';
const USER_SKILLS_DIR = resolve(HOME, '.coral', 'skills');

export type SkillLinkState = 'absent' | 'linked' | 'frozen';

export interface SkillInfo {
  name: string;
  userPath: string;
  hasSkillMd: boolean;
}

export interface ProjectSkillState extends SkillInfo {
  state: SkillLinkState;
  target?: string;
}

export function userSkillsRoot(): string {
  return USER_SKILLS_DIR;
}

export function listUserSkills(): SkillInfo[] {
  if (!existsSync(USER_SKILLS_DIR)) return [];
  return readdirSync(USER_SKILLS_DIR, { withFileTypes: true })
    .filter((e) => {
      // 普通目录或指向目录的 symlink 都算（外部 skill 包经常用 symlink 接入）
      if (e.isDirectory()) return true;
      if (!e.isSymbolicLink()) return false;
      try {
        // statSync 跟随 symlink，解析到目标
        return statSync(resolve(USER_SKILLS_DIR, e.name)).isDirectory();
      } catch {
        return false;
      }
    })
    .map((e) => ({
      name: e.name,
      userPath: resolve(USER_SKILLS_DIR, e.name),
      hasSkillMd: existsSync(resolve(USER_SKILLS_DIR, e.name, 'SKILL.md')),
    }))
    .filter((s) => s.hasSkillMd);
}

export function projectSkillsDir(projectDir: string): string {
  return resolve(projectDir, '.claude', 'skills');
}

export function projectSkillPath(projectDir: string, name: string): string {
  return resolve(projectSkillsDir(projectDir), name);
}

export function inspectProjectSkill(projectDir: string, name: string): ProjectSkillState | null {
  const user = listUserSkills().find((s) => s.name === name);
  if (!user) return null;
  const p = projectSkillPath(projectDir, name);
  if (!existsSync(p)) return { ...user, state: 'absent' };
  const stat = lstatSync(p);
  if (stat.isSymbolicLink()) {
    let target: string | undefined;
    try {
      target = readlinkSync(p);
    } catch {
      /* ignore */
    }
    return { ...user, state: 'linked', target };
  }
  return { ...user, state: 'frozen' };
}

export type AddResult =
  | 'linked'
  | 'copied'
  | 'skipped-linked'
  | 'skipped-frozen'
  | 'skipped-absent';

export function addSkillToProject(projectDir: string, name: string): AddResult {
  const user = listUserSkills().find((s) => s.name === name);
  if (!user) return 'skipped-absent';

  const skillsDir = projectSkillsDir(projectDir);
  if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });

  const dst = projectSkillPath(projectDir, name);
  if (existsSync(dst)) {
    return lstatSync(dst).isSymbolicLink() ? 'skipped-linked' : 'skipped-frozen';
  }

  try {
    symlinkSync(user.userPath, dst, 'dir');
    return 'linked';
  } catch {
    cpSync(user.userPath, dst, { recursive: true, force: false });
    return 'copied';
  }
}

export function removeSkillFromProject(projectDir: string, name: string): boolean {
  const p = projectSkillPath(projectDir, name);
  if (!existsSync(p) && !isDanglingSymlink(p)) return false;
  rmSync(p, { recursive: true, force: true });
  return true;
}

export function freezeSkillInProject(projectDir: string, name: string): boolean {
  const p = projectSkillPath(projectDir, name);
  if (!existsSync(p)) return false;
  const stat = lstatSync(p);
  if (!stat.isSymbolicLink()) return false;
  const user = listUserSkills().find((s) => s.name === name);
  if (!user) return false;
  rmSync(p);
  cpSync(user.userPath, p, { recursive: true, force: true });
  return true;
}

export function unfreezeSkillInProject(projectDir: string, name: string): boolean {
  const p = projectSkillPath(projectDir, name);
  const user = listUserSkills().find((s) => s.name === name);
  if (!user) return false;
  if (existsSync(p)) {
    const stat = lstatSync(p);
    if (stat.isSymbolicLink()) return false;
    rmSync(p, { recursive: true, force: true });
  }
  const skillsDir = projectSkillsDir(projectDir);
  if (!existsSync(skillsDir)) mkdirSync(skillsDir, { recursive: true });
  symlinkSync(user.userPath, p, 'dir');
  return true;
}

/**
 * Bulk link every user-level skill into the project. Idempotent:
 * - absent → symlink（或回退 cpSync）
 * - linked → 保留
 * - frozen → 保留（用户已 freeze 的不重建）
 */
export function syncAllSkillsToProject(
  projectDir: string,
): { linked: number; copied: number; kept: number } {
  const users = listUserSkills();
  let linked = 0;
  let copied = 0;
  let kept = 0;
  for (const u of users) {
    const r = addSkillToProject(projectDir, u.name);
    if (r === 'linked') linked++;
    else if (r === 'copied') copied++;
    else kept++;
  }
  return { linked, copied, kept };
}

/**
 * 把 bundled skills（npm 包内 skills/）拷贝到 ~/.coral/skills/。
 * Non-destructive：已存在的 skill 目录保留，不覆盖用户改动。
 * Bundled → user 必须是 cpSync，因为 npm 包路径会随重装变化，symlink 会失效。
 */
export function syncBundledSkillsToUser(
  bundledSkillsDir: string,
): { copied: number; skipped: number } {
  if (!existsSync(bundledSkillsDir)) return { copied: 0, skipped: 0 };
  if (!existsSync(USER_SKILLS_DIR)) mkdirSync(USER_SKILLS_DIR, { recursive: true });

  let copied = 0;
  let skipped = 0;
  const entries = readdirSync(bundledSkillsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = resolve(bundledSkillsDir, entry.name);
    if (!existsSync(resolve(src, 'SKILL.md'))) continue;
    const dst = resolve(USER_SKILLS_DIR, entry.name);
    if (existsSync(dst)) {
      skipped++;
      continue;
    }
    cpSync(src, dst, { recursive: true, force: false });
    copied++;
  }
  return { copied, skipped };
}

/**
 * 把 .claude/skills/ 条目追加到 .gitignore（幂等）。
 * 项目级 skill 是 symlink 到本机 ~/.coral/，不该进仓库。
 */
export function ensureSkillsGitignore(projectDir: string): void {
  const gitignore = resolve(projectDir, '.gitignore');
  const entry = '.claude/skills/';
  let existing = '';
  if (existsSync(gitignore)) existing = readFileSync(gitignore, 'utf-8');
  const has = existing
    .split('\n')
    .map((l) => l.trim())
    .some((l) => l === entry || l === '.claude/skills');
  if (has) return;
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  appendFileSync(gitignore, `${prefix}${entry}\n`);
}

function isDanglingSymlink(p: string): boolean {
  try {
    const stat = lstatSync(p);
    return stat.isSymbolicLink();
  } catch {
    return false;
  }
}
