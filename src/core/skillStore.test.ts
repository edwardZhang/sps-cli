/**
 * @module        skillStore.test
 * @description   skillStore 单元测试 — symlink / frozen / 回退、幂等语义
 *
 * 测试 symlink 路径：在 tmp 目录构造一个假 HOME 和假 project，所以不污染真实 ~/.coral/。
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * skillStore 用 process.env.HOME 计算 ~/.coral/skills/，所以要在 import 前
 * 覆盖 HOME；再 dynamic import 重新读取。用 vi.resetModules 确保不用缓存。
 */
async function loadStoreWithFakeHome(fakeHome: string) {
  process.env.HOME = fakeHome;
  vi.resetModules();
  return await import('./skillStore.js');
}

function makeUserSkill(fakeHome: string, name: string, extraFiles: Record<string, string> = {}): string {
  const dir = resolve(fakeHome, '.coral', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'SKILL.md'), `---\nname: ${name}\n---\n# ${name}\n`);
  for (const [rel, content] of Object.entries(extraFiles)) {
    const p = resolve(dir, rel);
    mkdirSync(resolve(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

function makeProject(root: string): string {
  const dir = resolve(root, 'proj');
  mkdirSync(resolve(dir, '.claude'), { recursive: true });
  return dir;
}

describe('skillStore', () => {
  let fakeHome: string;
  let root: string;
  const origHome = process.env.HOME;

  beforeEach(() => {
    root = tempDir('sps-skillstore-');
    fakeHome = resolve(root, 'home');
    mkdirSync(fakeHome, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('listUserSkills 返回含 SKILL.md 的目录', async () => {
    makeUserSkill(fakeHome, 'python');
    makeUserSkill(fakeHome, 'backend');
    // 无 SKILL.md 的目录不应出现
    mkdirSync(resolve(fakeHome, '.coral', 'skills', 'not-a-skill'), { recursive: true });

    const store = await loadStoreWithFakeHome(fakeHome);
    const users = store.listUserSkills();
    const names = users.map((u) => u.name).sort();
    expect(names).toEqual(['backend', 'python']);
  });

  it('addSkillToProject 建 symlink', async () => {
    makeUserSkill(fakeHome, 'python');
    const proj = makeProject(root);
    const store = await loadStoreWithFakeHome(fakeHome);

    const result = store.addSkillToProject(proj, 'python');
    expect(['linked', 'copied']).toContain(result);

    const linkPath = resolve(proj, '.claude', 'skills', 'python');
    expect(existsSync(linkPath)).toBe(true);
    expect(existsSync(resolve(linkPath, 'SKILL.md'))).toBe(true);
  });

  it('addSkillToProject 对已 linked 的 skill 幂等', async () => {
    makeUserSkill(fakeHome, 'python');
    const proj = makeProject(root);
    const store = await loadStoreWithFakeHome(fakeHome);

    store.addSkillToProject(proj, 'python');
    const again = store.addSkillToProject(proj, 'python');
    expect(['skipped-linked', 'skipped-frozen']).toContain(again);
  });

  it('addSkillToProject 不覆盖已 frozen 的真实目录', async () => {
    makeUserSkill(fakeHome, 'python');
    const proj = makeProject(root);
    const store = await loadStoreWithFakeHome(fakeHome);

    // 先手工放一个真实目录（模拟已 frozen / v0.42 cpSync 后的目录）
    const frozenPath = resolve(proj, '.claude', 'skills', 'python');
    mkdirSync(frozenPath, { recursive: true });
    writeFileSync(resolve(frozenPath, 'SKILL.md'), '# custom\n');

    const result = store.addSkillToProject(proj, 'python');
    expect(result).toBe('skipped-frozen');
    // 内容保留
    expect(readFileSync(resolve(frozenPath, 'SKILL.md'), 'utf-8')).toBe('# custom\n');
  });

  it('addSkillToProject 对不存在的 skill 返回 skipped-absent', async () => {
    const proj = makeProject(root);
    const store = await loadStoreWithFakeHome(fakeHome);
    expect(store.addSkillToProject(proj, 'nope')).toBe('skipped-absent');
  });

  it('inspectProjectSkill 区分 absent / linked / frozen', async () => {
    makeUserSkill(fakeHome, 'python');
    makeUserSkill(fakeHome, 'backend');
    const proj = makeProject(root);
    const store = await loadStoreWithFakeHome(fakeHome);

    expect(store.inspectProjectSkill(proj, 'python')?.state).toBe('absent');

    store.addSkillToProject(proj, 'python');
    const linked = store.inspectProjectSkill(proj, 'python');
    expect(linked?.state).toBe('linked');

    // 手工造一个 frozen
    const backendDir = resolve(proj, '.claude', 'skills', 'backend');
    mkdirSync(backendDir, { recursive: true });
    writeFileSync(resolve(backendDir, 'SKILL.md'), '# custom\n');
    expect(store.inspectProjectSkill(proj, 'backend')?.state).toBe('frozen');
  });

  it('freezeSkillInProject 把 symlink 转成独立副本', async () => {
    makeUserSkill(fakeHome, 'python', { 'references/a.md': 'hello\n' });
    const proj = makeProject(root);
    const store = await loadStoreWithFakeHome(fakeHome);
    store.addSkillToProject(proj, 'python');

    expect(store.freezeSkillInProject(proj, 'python')).toBe(true);

    const projPath = resolve(proj, '.claude', 'skills', 'python');
    const stat = lstatSync(projPath);
    expect(stat.isSymbolicLink()).toBe(false);

    // 改源文件后，项目里的副本不应跟着变
    const userPath = resolve(fakeHome, '.coral', 'skills', 'python', 'references', 'a.md');
    writeFileSync(userPath, 'modified\n');
    expect(readFileSync(resolve(projPath, 'references', 'a.md'), 'utf-8')).toBe('hello\n');
  });

  it('unfreezeSkillInProject 把真实副本转回 symlink', async () => {
    makeUserSkill(fakeHome, 'python', { 'references/a.md': 'hello\n' });
    const proj = makeProject(root);
    const store = await loadStoreWithFakeHome(fakeHome);
    store.addSkillToProject(proj, 'python');
    store.freezeSkillInProject(proj, 'python');

    expect(store.unfreezeSkillInProject(proj, 'python')).toBe(true);

    const projPath = resolve(proj, '.claude', 'skills', 'python');
    expect(lstatSync(projPath).isSymbolicLink()).toBe(true);

    // 改源文件后，项目里会跟着变
    const userPath = resolve(fakeHome, '.coral', 'skills', 'python', 'references', 'a.md');
    writeFileSync(userPath, 'modified\n');
    expect(readFileSync(resolve(projPath, 'references', 'a.md'), 'utf-8')).toBe('modified\n');
  });

  it('removeSkillFromProject 移除 symlink 不动源', async () => {
    makeUserSkill(fakeHome, 'python');
    const proj = makeProject(root);
    const store = await loadStoreWithFakeHome(fakeHome);
    store.addSkillToProject(proj, 'python');

    expect(store.removeSkillFromProject(proj, 'python')).toBe(true);
    expect(existsSync(resolve(proj, '.claude', 'skills', 'python'))).toBe(false);
    // 源还在
    expect(existsSync(resolve(fakeHome, '.coral', 'skills', 'python', 'SKILL.md'))).toBe(true);
  });

  it('syncAllSkillsToProject 对 20 个 skill 批量建 symlink，幂等', async () => {
    const names = Array.from({ length: 20 }, (_, i) => `skill-${i}`);
    for (const n of names) makeUserSkill(fakeHome, n);
    const proj = makeProject(root);
    const store = await loadStoreWithFakeHome(fakeHome);

    const first = store.syncAllSkillsToProject(proj);
    expect(first.linked + first.copied).toBe(20);

    const second = store.syncAllSkillsToProject(proj);
    expect(second.kept).toBe(20);
  });

  it('syncBundledSkillsToUser 把 bundled 目录 cpSync 到 ~/.coral/skills/，不覆盖已存在', async () => {
    const bundled = resolve(root, 'bundled');
    mkdirSync(resolve(bundled, 'python'), { recursive: true });
    writeFileSync(resolve(bundled, 'python', 'SKILL.md'), '# bundled python\n');
    mkdirSync(resolve(bundled, 'rust'), { recursive: true });
    writeFileSync(resolve(bundled, 'rust', 'SKILL.md'), '# bundled rust\n');

    // 用户已有一个 python（用户改过）
    makeUserSkill(fakeHome, 'python', {});
    writeFileSync(resolve(fakeHome, '.coral', 'skills', 'python', 'SKILL.md'), '# user customized\n');

    const store = await loadStoreWithFakeHome(fakeHome);
    const res = store.syncBundledSkillsToUser(bundled);
    expect(res.copied).toBe(1); // rust 新建
    expect(res.skipped).toBe(1); // python 保留
    expect(readFileSync(resolve(fakeHome, '.coral', 'skills', 'python', 'SKILL.md'), 'utf-8'))
      .toBe('# user customized\n');
  });

  it('ensureSkillsGitignore 幂等追加 .claude/skills/', async () => {
    const proj = makeProject(root);
    const store = await loadStoreWithFakeHome(fakeHome);
    const gitignore = resolve(proj, '.gitignore');

    store.ensureSkillsGitignore(proj);
    expect(readFileSync(gitignore, 'utf-8')).toContain('.claude/skills/');

    // 再跑一次不应重复
    store.ensureSkillsGitignore(proj);
    const lines = readFileSync(gitignore, 'utf-8').split('\n').filter((l) => l.trim() === '.claude/skills/');
    expect(lines.length).toBe(1);
  });
});
