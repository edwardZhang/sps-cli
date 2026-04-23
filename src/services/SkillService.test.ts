import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DomainEvent, InMemoryEventBus } from '../shared/domainEvents.js';
import { SkillService } from './SkillService.js';

/**
 * SkillService 依赖 core/skillStore —— 走真 FS（tmp HOME）测试。
 */
describe('SkillService', () => {
  let tmpHome: string;
  let prev: string | undefined;
  let svc: SkillService;
  let events: DomainEvent[];

  beforeEach(() => {
    prev = process.env.HOME;
    tmpHome = mkdtempSync(resolve(tmpdir(), 'sps-skill-'));
    process.env.HOME = tmpHome;
    // 清模块缓存 —— skillStore.ts 在 top-level 读 process.env.HOME 冻结成常量，
    // 不 reset 每个 testcase 会拿到首次 load 时的 HOME。
    vi.resetModules();
    const bus = new InMemoryEventBus();
    events = [];
    bus.subscribe((e) => events.push(e));
    svc = new SkillService({ events: bus });
  });

  afterEach(() => {
    process.env.HOME = prev;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  function seedSkill(name: string, description = 'desc'): void {
    const dir = resolve(tmpHome, '.coral', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      resolve(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: "${description}"\norigin: test\n---\n\n# ${name}\n`,
    );
  }

  function seedProject(name: string, repoDir: string): void {
    const projDir = resolve(tmpHome, '.coral', 'projects', name);
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      resolve(projDir, 'conf'),
      `export PROJECT_NAME="${name}"\nexport PROJECT_DIR="${repoDir}"\n`,
    );
    mkdirSync(repoDir, { recursive: true });
  }

  it('list 无 skill 返空', async () => {
    const r = await svc.list();
    if (r.ok) expect(r.value).toEqual([]);
  });

  it('list 返回 seed 过的 skills', async () => {
    seedSkill('typescript', 'TS expert');
    seedSkill('python');
    const r = await svc.list();
    if (r.ok) {
      expect(r.value.map((s) => s.name).sort()).toEqual(['python', 'typescript']);
    }
  });

  it('list 按名字分类 category', async () => {
    seedSkill('typescript');
    seedSkill('frontend');
    seedSkill('my-tool');
    const r = await svc.list();
    if (r.ok) {
      const byName = Object.fromEntries(r.value.map((s) => [s.name, s.category]));
      expect(byName.typescript).toBe('language');
      expect(byName.frontend).toBe('end');
      expect(byName['my-tool']).toBe('other');
    }
  });

  it('list 带 project 返回 stateInProject', async () => {
    seedSkill('s1');
    const repo = resolve(tmpHome, 'repo-a');
    seedProject('a', repo);
    const r = await svc.list('a');
    if (r.ok) expect(r.value[0]?.stateInProject).toBe('absent');
  });

  it('get 不存在 → not-found', async () => {
    const r = await svc.get('nope');
    if (!r.ok) expect(r.error.code).toBe('SKILL_NOT_FOUND');
  });

  it('get 存在返 detail 含 body', async () => {
    seedSkill('mytool', 'a useful tool');
    const r = await svc.get('mytool');
    if (r.ok) {
      expect(r.value.description).toBe('a useful tool');
      expect(r.value.body).toContain('# mytool');
      expect(r.value.references).toEqual([]);
    }
  });

  it('get 非法 name → validation', async () => {
    const r = await svc.get('../etc');
    if (!r.ok) expect(r.error.kind).toBe('validation');
  });

  it('get 含 references 时返 references 列表', async () => {
    seedSkill('s1');
    const refsDir = resolve(tmpHome, '.coral', 'skills', 's1', 'references');
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(resolve(refsDir, 'tips.md'), 'line1\nline2\nline3\n');
    const r = await svc.get('s1');
    if (r.ok) {
      expect(r.value.references).toHaveLength(1);
      expect(r.value.references[0]?.name).toBe('tips.md');
      expect(r.value.references[0]?.lines).toBeGreaterThanOrEqual(3);
    }
  });

  it('link 项目不存在 → not-found', async () => {
    seedSkill('s1');
    const r = await svc.link('s1', 'nope');
    if (!r.ok) expect(r.error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('link skill 不存在 → not-found', async () => {
    const repo = resolve(tmpHome, 'repo-a');
    seedProject('a', repo);
    const r = await svc.link('not-a-skill', 'a');
    if (!r.ok) expect(r.error.code).toBe('SKILL_NOT_FOUND');
  });

  it('link 成功 → emit skill.linked', async () => {
    seedSkill('s1');
    const repo = resolve(tmpHome, 'repo-a');
    seedProject('a', repo);
    const r = await svc.link('s1', 'a');
    expect(r.ok).toBe(true);
    const linkedEvents = events.filter((e) => e.type === 'skill.linked');
    expect(linkedEvents).toHaveLength(1);
  });

  it('link 幂等（已 link 再调不抛）', async () => {
    seedSkill('s1');
    const repo = resolve(tmpHome, 'repo-a');
    seedProject('a', repo);
    await svc.link('s1', 'a');
    const r = await svc.link('s1', 'a');
    expect(r.ok).toBe(true);
  });

  it('unlink 未 link 也返 ok（幂等）', async () => {
    seedSkill('s1');
    const repo = resolve(tmpHome, 'repo-a');
    seedProject('a', repo);
    const r = await svc.unlink('s1', 'a');
    expect(r.ok).toBe(true);
  });

  it('unlink 已 link 后 emit skill.unlinked', async () => {
    seedSkill('s1');
    const repo = resolve(tmpHome, 'repo-a');
    seedProject('a', repo);
    await svc.link('s1', 'a');
    events.length = 0;
    const r = await svc.unlink('s1', 'a');
    expect(r.ok).toBe(true);
    expect(events.filter((e) => e.type === 'skill.unlinked')).toHaveLength(1);
  });

  it('sync 不抛', async () => {
    const r = await svc.sync();
    expect(r.ok).toBe(true);
  });
});
