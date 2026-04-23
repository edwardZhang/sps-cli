/**
 * @module        services/SkillService
 * @description   Skill 注册 + link/unlink/freeze service
 *
 * @layer         services
 *
 * 包装 core/skillStore 的能力，让 Delivery 层不再直接调 Domain。
 * Phase 3 会用 SkillRegistry port 替代，当前先内部 wrap。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

import type { DomainEventBus } from '../shared/domainEvents.js';
import { type DomainError, domainError } from '../shared/errors.js';
import { err, ok, type Result } from '../shared/result.js';
import { projectConfFile, projectsDir, userSkillsDir } from '../shared/runtimePaths.js';

export type SkillCategory = 'language' | 'end' | 'persona' | 'workflow' | 'other';
export type SkillLinkState = 'absent' | 'linked' | 'frozen';

export interface SkillSummary {
  readonly name: string;
  readonly category: SkillCategory;
  readonly description: string;
  readonly origin: string;
  readonly linkedProjects: string[];
  /** 当 opts.project 提供时附 */
  readonly stateInProject?: SkillLinkState;
}

export interface SkillDetail extends SkillSummary {
  readonly body: string;
  readonly references: Array<{ name: string; lines: number }>;
  readonly linkedProjects: string[];
}

export interface SkillServiceDeps {
  readonly events: DomainEventBus;
}

export class SkillService {
  constructor(private readonly deps: SkillServiceDeps) {}

  /** 列出 user-level skills。可选带 project 参数以得到 stateInProject。 */
  async list(project?: string): Promise<Result<SkillSummary[], DomainError>> {
    const { listUserSkills, inspectProjectSkill } = await import('../core/skillStore.js');
    const users = listUserSkills();
    const enriched: SkillSummary[] = users.map((u) => {
      const fm = readFrontmatter(resolve(u.userPath, 'SKILL.md'));
      const base: SkillSummary = {
        name: u.name,
        category: classifyCategory(u.name),
        description: fm.description,
        origin: fm.origin,
        linkedProjects: collectLinkedProjects(u.name).map((p) => p.project),
      };
      if (project) {
        const repo = findProjectRepoDir(project);
        const state: SkillLinkState = repo
          ? inspectProjectSkill(repo, u.name)?.state ?? 'absent'
          : 'absent';
        return { ...base, stateInProject: state };
      }
      return base;
    });
    return ok(enriched);
  }

  async get(name: string): Promise<Result<SkillDetail, DomainError>> {
    if (!isValidSkillName(name)) {
      return err(domainError('validation', 'INVALID_SKILL_NAME', 'skill 名非法'));
    }
    const { listUserSkills } = await import('../core/skillStore.js');
    const found = listUserSkills().find((u) => u.name === name);
    if (!found) {
      return err(domainError('not-found', 'SKILL_NOT_FOUND', `skill ${name} 不存在`));
    }
    const fm = readFrontmatter(resolve(found.userPath, 'SKILL.md'));
    const body = readFileOrEmpty(resolve(found.userPath, 'SKILL.md'));
    const refsDir = resolve(found.userPath, 'references');
    const references = existsSync(refsDir)
      ? readdirSync(refsDir)
          .filter((f) => f.endsWith('.md'))
          .map((f) => {
            const full = resolve(refsDir, f);
            return { name: f, lines: readFileOrEmpty(full).split('\n').length };
          })
      : [];
    return ok({
      name,
      category: classifyCategory(name),
      description: fm.description,
      origin: fm.origin,
      body,
      references,
      linkedProjects: collectLinkedProjects(name).map((p) => p.project),
    });
  }

  async sync(): Promise<Result<void, DomainError>> {
    const skillStore = await import('../core/skillStore.js');
    // syncBundledSkillsToUser 需要 bundled skills 目录参数。defaults 让它自己查找内置。
    // Phase 3 重构 bundled 目录定位时再传显式参数。
    const bundled = findBundledSkillsDir();
    if (!bundled) {
      // 没有 bundled skills 就是成功 noop
      return ok(undefined);
    }
    try {
      skillStore.syncBundledSkillsToUser(bundled);
    } catch (cause) {
      return err(domainError('internal', 'SKILL_SYNC_FAIL', 'skill 同步失败', { cause }));
    }
    return ok(undefined);
  }

  async link(skill: string, project: string): Promise<Result<void, DomainError>> {
    if (!isValidSkillName(skill)) return err(invalidSkill());
    if (!isValidProject(project)) return err(invalidProject());
    const repo = findProjectRepoDir(project);
    if (!repo) return err(projectNotFound(project));
    const { addSkillToProject } = await import('../core/skillStore.js');
    const result = addSkillToProject(repo, skill);
    if (result === 'skipped-absent') {
      return err(
        domainError('not-found', 'SKILL_NOT_FOUND', `skill ${skill} 不在 user registry`),
      );
    }
    // 已在工程中（symlink 或 frozen copy）→ 幂等 ok，不再 emit
    if (result === 'skipped-linked' || result === 'skipped-frozen') {
      return ok(undefined);
    }
    this.deps.events.emit({
      type: 'skill.linked',
      project,
      skill,
      ts: Date.now(),
    });
    return ok(undefined);
  }

  async unlink(skill: string, project: string): Promise<Result<void, DomainError>> {
    if (!isValidSkillName(skill)) return err(invalidSkill());
    if (!isValidProject(project)) return err(invalidProject());
    const repo = findProjectRepoDir(project);
    if (!repo) return err(projectNotFound(project));
    const { removeSkillFromProject } = await import('../core/skillStore.js');
    const removed = removeSkillFromProject(repo, skill);
    if (!removed) return ok(undefined); // idempotent
    this.deps.events.emit({
      type: 'skill.unlinked',
      project,
      skill,
      ts: Date.now(),
    });
    return ok(undefined);
  }

  async freeze(skill: string, project: string): Promise<Result<void, DomainError>> {
    if (!isValidSkillName(skill)) return err(invalidSkill());
    if (!isValidProject(project)) return err(invalidProject());
    const repo = findProjectRepoDir(project);
    if (!repo) return err(projectNotFound(project));
    const { freezeSkillInProject } = await import('../core/skillStore.js');
    if (!freezeSkillInProject(repo, skill)) {
      return err(domainError('conflict', 'FREEZE_FAIL', '冻结失败 —— 可能未 link'));
    }
    return ok(undefined);
  }

  async unfreeze(skill: string, project: string): Promise<Result<void, DomainError>> {
    if (!isValidSkillName(skill)) return err(invalidSkill());
    if (!isValidProject(project)) return err(invalidProject());
    const repo = findProjectRepoDir(project);
    if (!repo) return err(projectNotFound(project));
    const { unfreezeSkillInProject } = await import('../core/skillStore.js');
    if (!unfreezeSkillInProject(repo, skill)) {
      return err(domainError('conflict', 'UNFREEZE_FAIL', '解冻失败 —— 可能未冻结'));
    }
    return ok(undefined);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function classifyCategory(name: string): SkillCategory {
  const LANGUAGES = new Set(['python', 'typescript', 'golang', 'rust', 'kotlin', 'swift', 'java']);
  const ENDS = new Set(['frontend', 'backend', 'mobile', 'database', 'devops']);
  const PERSONAS = new Set([
    'backend-architect',
    'frontend-developer',
    'code-reviewer',
    'database-optimizer',
    'devops-automator',
    'security-engineer',
    'qa-tester',
  ]);
  const WORKFLOWS = new Set([
    'coding-standards',
    'tdd-workflow',
    'git-workflow',
    'architecture-decision-records',
    'debugging-workflow',
  ]);
  if (LANGUAGES.has(name)) return 'language';
  if (ENDS.has(name)) return 'end';
  if (PERSONAS.has(name)) return 'persona';
  if (WORKFLOWS.has(name)) return 'workflow';
  return 'other';
}

function readFrontmatter(path: string): { description: string; origin: string } {
  if (!existsSync(path)) return { description: '', origin: '' };
  try {
    const raw = readFileSync(path, 'utf-8');
    if (!raw.startsWith('---')) return { description: '', origin: '' };
    const end = raw.indexOf('\n---', 3);
    if (end === -1) return { description: '', origin: '' };
    const yaml = raw.slice(3, end);
    const desc = yaml.match(/^description:\s*(.+)$/m)?.[1] ?? '';
    const origin = yaml.match(/^origin:\s*(.+)$/m)?.[1] ?? '';
    return {
      description: desc.trim().replace(/^["']|["']$/g, ''),
      origin: origin.trim().replace(/^["']|["']$/g, ''),
    };
  } catch {
    return { description: '', origin: '' };
  }
}

function readFileOrEmpty(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

interface LinkedProject {
  project: string;
  state: 'linked' | 'frozen';
}

function collectLinkedProjects(skillName: string): LinkedProject[] {
  const root = projectsDir();
  if (!existsSync(root)) return [];
  const out: LinkedProject[] = [];
  const projects = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const name of projects) {
    const repo = findProjectRepoDir(name);
    if (!repo || !existsSync(repo)) continue;
    // Avoid importing skillStore here —— dynamic import in methods that need it
    // 此 helper 仅供 list/get 内部预计算，用脏读直接 fs 判定：
    const linked = resolve(repo, '.claude', 'skills', skillName);
    if (existsSync(linked)) {
      const frozen = existsSync(resolve(linked, '.frozen'));
      out.push({ project: name, state: frozen ? 'frozen' : 'linked' });
    }
  }
  return out;
}

function findProjectRepoDir(project: string): string | null {
  const confPath = projectConfFile(project);
  if (!existsSync(confPath)) return null;
  try {
    const content = readFileSync(confPath, 'utf-8');
    const match = content.match(/^(?:export\s+)?(?:PROJECT_DIR|REPO_DIR)=["']?([^"'\n]+)["']?/m);
    return match ? match[1] ?? null : null;
  } catch {
    return null;
  }
}

function isValidProject(project: string): boolean {
  return typeof project === 'string' && /^[a-zA-Z0-9_-]+$/.test(project);
}

function isValidSkillName(name: string): boolean {
  return typeof name === 'string' && /^[a-zA-Z0-9_-]+$/.test(name);
}

function invalidSkill(): DomainError {
  return domainError('validation', 'INVALID_SKILL_NAME', 'skill 名非法');
}

function invalidProject(): DomainError {
  return domainError('validation', 'INVALID_PROJECT_NAME', '项目名非法');
}

function projectNotFound(name: string): DomainError {
  return domainError('not-found', 'PROJECT_NOT_FOUND', `项目 ${name} 不存在`);
}

/**
 * 定位仓库里的 `skills/` bundled 目录（project-template 模板同级）。
 * 和 console-server/routes/skills.ts::findBundledSkillsDir 逻辑一致 ——
 * Phase 3 迁移 Delivery 时再合并到 shared helper。
 */
function findBundledSkillsDir(): string | null {
  const candidates = [
    resolve(process.cwd(), 'skills'),
    // 从 src/services/SkillService.ts 往上数：services → src → workflow-cli → skills
    resolve(__dirname, '..', '..', 'skills'),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

// void —— 让 TypeScript 不要 warn userSkillsDir 没直接用
void userSkillsDir;
