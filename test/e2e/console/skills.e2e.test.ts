/**
 * Phase 0 characterization — /api/skills 主线
 *
 * 锁定 v0.49.16 skills API 行为：list / get / references / sync / link。
 * Skills 存在 ~/.coral/skills/<name>/SKILL.md。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestProject, destroyTestProject, type TestProjectFixture } from '../helpers/testProject';
import { buildTestApp, type TestAppHandle } from '../helpers/testServer';

describe('E2E /api/skills', () => {
  let fx: TestProjectFixture;
  let prevHome: string | undefined;
  let app: TestAppHandle;

  beforeEach(async () => {
    prevHome = process.env.HOME;
    fx = createTestProject({ project: 'skills-test' });
    process.env.HOME = fx.home;
    app = await buildTestApp();
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    destroyTestProject(fx);
  });

  function seedSkill(name: string, description = 'a test skill'): string {
    const skillDir = resolve(fx.home, '.coral', 'skills', name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      resolve(skillDir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: "${description}"\norigin: test\n---\n\n# ${name}\n\nSkill body.\n`,
    );
    return skillDir;
  }

  it('GET /skills 无 skill 返回空', async () => {
    const res = await app.req('/api/skills');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toEqual([]);
  });

  it('GET /skills 列出 seed 过的 skill', async () => {
    seedSkill('typescript', 'TS expert');
    seedSkill('python', 'Python expert');
    const res = await app.req('/api/skills');
    const body = (await res.json()) as { data: Array<{ name: string; category: string }> };
    expect(body.data).toHaveLength(2);
    const names = body.data.map((s) => s.name).sort();
    expect(names).toEqual(['python', 'typescript']);
  });

  it('GET /skills 按 name 分类 category', async () => {
    seedSkill('typescript');
    seedSkill('frontend');
    seedSkill('my-custom-skill');
    const res = await app.req('/api/skills');
    const body = (await res.json()) as { data: Array<{ name: string; category: string }> };
    const byName = Object.fromEntries(body.data.map((s) => [s.name, s.category]));
    expect(byName['typescript']).toBe('language');
    expect(byName['frontend']).toBe('end');
    expect(byName['my-custom-skill']).toBe('other');
  });

  it('GET /skills/:name 返回 body + references 数组', async () => {
    seedSkill('mytool', 'a useful tool');
    const res = await app.req('/api/skills/mytool');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      description: string;
      body: string;
      references: unknown[];
    };
    expect(body.name).toBe('mytool');
    expect(body.description).toBe('a useful tool');
    expect(body.body).toContain('Skill body');
    expect(Array.isArray(body.references)).toBe(true);
  });

  it('GET /skills/:name 404 skill 不存在', async () => {
    const res = await app.req('/api/skills/nope');
    expect(res.status).toBe(404);
  });

  it('GET /skills/:name/references/:file 422 非法文件名', async () => {
    seedSkill('mytool');
    const res = await app.req('/api/skills/mytool/references/..%2Fetc%2Fpasswd');
    expect(res.status).toBe(422);
  });
});
