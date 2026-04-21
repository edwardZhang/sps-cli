/**
 * @module        console-server/routes/skills
 * @description   Skill REST API - 复用 core/skillStore
 */
import { Hono } from 'hono';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
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
} from '../../core/skillStore.js';

const HOME = process.env.HOME || '/home/coral';
const PROJECTS_DIR = resolve(HOME, '.coral', 'projects');

function findProjectRepoDir(projectName: string): string | null {
  const confPath = resolve(PROJECTS_DIR, projectName, 'conf');
  if (!existsSync(confPath)) return null;
  try {
    const content = readFileSync(confPath, 'utf-8');
    const match = content.match(/^(?:export\s+)?REPO_DIR=["']?([^"'\n]+)["']?/m);
    return match ? (match[1] ?? null) : null;
  } catch {
    return null;
  }
}

function classifyCategory(name: string): 'language' | 'end' | 'persona' | 'workflow' | 'other' {
  const LANGUAGES = new Set(['python', 'typescript', 'golang', 'rust', 'kotlin', 'swift', 'java']);
  const ENDS = new Set(['frontend', 'backend', 'mobile', 'database', 'devops']);
  const PERSONAS = new Set([
    'backend-architect', 'frontend-developer', 'code-reviewer', 'database-optimizer',
    'devops-automator', 'security-engineer', 'qa-tester',
  ]);
  const WORKFLOWS = new Set([
    'coding-standards', 'tdd-workflow', 'git-workflow',
    'architecture-decision-records', 'debugging-workflow',
  ]);
  if (LANGUAGES.has(name)) return 'language';
  if (ENDS.has(name)) return 'end';
  if (PERSONAS.has(name)) return 'persona';
  if (WORKFLOWS.has(name)) return 'workflow';
  return 'other';
}

function readFrontmatter(path: string): { description: string; origin: string } {
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

interface LinkedProject { project: string; state: 'linked' | 'frozen' }

function collectLinkedProjects(skillName: string): LinkedProject[] {
  if (!existsSync(PROJECTS_DIR)) return [];
  const out: LinkedProject[] = [];
  const projects = readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const name of projects) {
    const repo = findProjectRepoDir(name);
    if (!repo || !existsSync(repo)) continue;
    const info = inspectProjectSkill(repo, skillName);
    if (info && info.state !== 'absent') {
      out.push({ project: name, state: info.state });
    }
  }
  return out;
}

function findBundledSkillsDir(): string | null {
  // same strategy as consoleCommand
  const candidates = [
    resolve(process.cwd(), 'skills'),
    // npm package root/skills
    resolve(import.meta.url.replace(/^file:\/\//, ''), '..', '..', '..', '..', 'skills'),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isDirectory()) return c;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function createSkillsRoute(): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const users = listUserSkills();
    const forProject = c.req.query('project');
    const enriched = users.map((u) => {
      const fm = readFrontmatter(resolve(u.userPath, 'SKILL.md'));
      const base = {
        name: u.name,
        category: classifyCategory(u.name),
        description: fm.description,
        origin: fm.origin,
        linkedProjects: collectLinkedProjects(u.name).map((p) => p.project),
      };
      if (forProject) {
        const repo = findProjectRepoDir(forProject);
        const state = repo ? inspectProjectSkill(repo, u.name)?.state ?? 'absent' : 'absent';
        return { ...base, stateInProject: state };
      }
      return base;
    });
    return c.json({ data: enriched });
  });

  app.get('/:name', (c) => {
    const name = c.req.param('name');
    const users = listUserSkills();
    const user = users.find((u) => u.name === name);
    if (!user) {
      return c.json(
        { type: 'not-found', title: 'Skill not found', status: 404, detail: name },
        404,
      );
    }
    const fm = readFrontmatter(resolve(user.userPath, 'SKILL.md'));
    const body = (() => {
      try {
        return readFileSync(resolve(user.userPath, 'SKILL.md'), 'utf-8');
      } catch {
        return '';
      }
    })();
    const references = existsSync(resolve(user.userPath, 'references'))
      ? readdirSync(resolve(user.userPath, 'references'))
          .filter((f) => f.endsWith('.md'))
          .map((f) => {
            const full = resolve(user.userPath, 'references', f);
            try {
              return { name: f, lines: readFileSync(full, 'utf-8').split('\n').length };
            } catch {
              return { name: f, lines: 0 };
            }
          })
      : [];
    const linkedProjects = collectLinkedProjects(name);
    return c.json({
      name,
      category: classifyCategory(name),
      description: fm.description,
      origin: fm.origin,
      body,
      references,
      linkedProjects,
    });
  });

  app.post('/:name/link', async (c) => {
    const name = c.req.param('name');
    const body = await c.req.json().catch(() => null) as { project?: string } | null;
    if (!body?.project) {
      return c.json({ type: 'validation', title: 'project required', status: 422 }, 422);
    }
    const repo = findProjectRepoDir(body.project);
    if (!repo) {
      return c.json({ type: 'not-found', title: 'Project not found', status: 404 }, 404);
    }
    const result = addSkillToProject(repo, name);
    if (result === 'skipped-absent') {
      return c.json({ type: 'not-found', title: 'Skill not in ~/.coral/skills/', status: 404 }, 404);
    }
    ensureSkillsGitignore(repo);
    return c.json({ state: result });
  });

  app.delete('/:name/link', (c) => {
    const name = c.req.param('name');
    const project = c.req.query('project');
    if (!project) {
      return c.json({ type: 'validation', title: 'project required', status: 422 }, 422);
    }
    const repo = findProjectRepoDir(project);
    if (!repo) {
      return c.json({ type: 'not-found', title: 'Project not found', status: 404 }, 404);
    }
    const removed = removeSkillFromProject(repo, name);
    return c.json({ removed });
  });

  app.post('/:name/freeze', async (c) => {
    const name = c.req.param('name');
    const body = await c.req.json().catch(() => null) as { project?: string } | null;
    if (!body?.project) {
      return c.json({ type: 'validation', title: 'project required', status: 422 }, 422);
    }
    const repo = findProjectRepoDir(body.project);
    if (!repo) return c.json({ type: 'not-found', title: 'Project not found', status: 404 }, 404);
    const ok = freezeSkillInProject(repo, name);
    return c.json({ ok, state: ok ? 'frozen' : 'unchanged' });
  });

  app.post('/:name/unfreeze', async (c) => {
    const name = c.req.param('name');
    const body = await c.req.json().catch(() => null) as { project?: string } | null;
    if (!body?.project) {
      return c.json({ type: 'validation', title: 'project required', status: 422 }, 422);
    }
    const repo = findProjectRepoDir(body.project);
    if (!repo) return c.json({ type: 'not-found', title: 'Project not found', status: 404 }, 404);
    const ok = unfreezeSkillInProject(repo, name);
    return c.json({ ok, state: ok ? 'linked' : 'unchanged' });
  });

  app.post('/sync', (c) => {
    const bundled = findBundledSkillsDir();
    if (!bundled) {
      return c.json({ copied: 0, skipped: 0, note: 'bundled dir not found' });
    }
    const result = syncBundledSkillsToUser(bundled);
    return c.json({ ...result, userRoot: userSkillsRoot() });
  });

  // 当前项目的 .claude/skills 列表（用于调试）
  app.get('/links/:project', (c) => {
    const project = c.req.param('project');
    const repo = findProjectRepoDir(project);
    if (!repo) {
      return c.json({ type: 'not-found', title: 'Project not found', status: 404 }, 404);
    }
    const dir = projectSkillsDir(repo);
    return c.json({
      repo,
      skillsDir: dir,
      links: existsSync(dir) ? readdirSync(dir) : [],
    });
  });

  return app;
}
