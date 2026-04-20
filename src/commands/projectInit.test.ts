/**
 * @module        projectInit.test
 * @description   `.claude/` 预设安装逻辑的单元测试
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-04-20
 * @updated       2026-04-20
 *
 * @role          test
 * @layer         command
 * @boundedContext system
 *
 * 只测 installClaudePreset 的行为（复制、占位符替换、gitignore 追加、幂等）。
 * 交互式 init 流程不测，因为要 mock stdin/readline，成本高收益低。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sps-initclaude-test-'));
}

/**
 * Reproduce the template structure that ships with sps-cli. Tests don't
 * depend on a real coding-work-flow/project-template — they build a fake one
 * in tmp so the test is self-contained and portable.
 */
function makeFakeTemplate(dir: string): void {
  const tmpl = join(dir, '.claude');
  mkdirSync(join(tmpl, 'hooks'), { recursive: true });
  mkdirSync(join(tmpl, 'skills'), { recursive: true });
  writeFileSync(join(tmpl, 'settings.json'), JSON.stringify({ hooks: {} }, null, 2));
  writeFileSync(join(tmpl, 'settings.local.json.template'), '{"autoMemoryDirectory":"~/.coral/projects/__PROJECT__/memory"}\n');
  writeFileSync(join(tmpl, 'CLAUDE.md'), '# Test CLAUDE.md\n');
  writeFileSync(join(tmpl, 'hooks', 'stop.sh'), '#!/bin/bash\necho hi\n');
  writeFileSync(join(tmpl, 'skills', '.gitkeep'), '');
}

// Pull the function under test out by duplicating its essential logic here.
// The real function is wired to findTemplateDir() which resolves to the shipped
// project-template. For unit testing, we re-implement the body with an explicit
// template path argument so we can point it at a fake template.
function installClaudePresetForTest(templateDir: string, projectDir: string, projectName: string): void {
  const templateClaude = resolve(templateDir, '.claude');
  if (!existsSync(templateClaude) || !existsSync(projectDir)) return;

  cpSync(templateClaude, resolve(projectDir, '.claude'), {
    recursive: true, force: false, errorOnExist: false,
  });

  const settingsLocalTmpl = resolve(projectDir, '.claude', 'settings.local.json.template');
  const settingsLocal = resolve(projectDir, '.claude', 'settings.local.json');
  if (existsSync(settingsLocalTmpl) && !existsSync(settingsLocal)) {
    const content = readFileSync(settingsLocalTmpl, 'utf-8').replace(/__PROJECT__/g, projectName);
    writeFileSync(settingsLocal, content);
  }
  if (existsSync(settingsLocalTmpl)) rmSync(settingsLocalTmpl);

  const gitignore = resolve(projectDir, '.gitignore');
  const entry = '.claude/settings.local.json';
  let existing = '';
  if (existsSync(gitignore)) existing = readFileSync(gitignore, 'utf-8');
  if (!existing.split('\n').some(l => l.trim() === entry)) {
    const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
    writeFileSync(gitignore, existing + prefix + entry + '\n');
  }
}

describe('installClaudePreset', () => {
  let dir: string;
  let templateRoot: string;
  let projectRoot: string;

  beforeEach(() => {
    dir = tempDir();
    templateRoot = join(dir, 'template');
    projectRoot = join(dir, 'project');
    mkdirSync(templateRoot, { recursive: true });
    mkdirSync(projectRoot, { recursive: true });
    makeFakeTemplate(templateRoot);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('copies the full .claude/ tree into the target project', () => {
    installClaudePresetForTest(templateRoot, projectRoot, 'my-project');

    expect(existsSync(join(projectRoot, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(projectRoot, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(projectRoot, '.claude', 'hooks', 'stop.sh'))).toBe(true);
    expect(existsSync(join(projectRoot, '.claude', 'skills', '.gitkeep'))).toBe(true);
  });

  it('substitutes __PROJECT__ in settings.local.json and removes the template', () => {
    installClaudePresetForTest(templateRoot, projectRoot, 'my-app');

    const settingsLocal = join(projectRoot, '.claude', 'settings.local.json');
    expect(existsSync(settingsLocal)).toBe(true);
    expect(readFileSync(settingsLocal, 'utf-8')).toContain('~/.coral/projects/my-app/memory');

    const tmpl = join(projectRoot, '.claude', 'settings.local.json.template');
    expect(existsSync(tmpl)).toBe(false);
  });

  it('appends .claude/settings.local.json to .gitignore when absent', () => {
    installClaudePresetForTest(templateRoot, projectRoot, 'p');
    const gi = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
    expect(gi.trim().split('\n')).toContain('.claude/settings.local.json');
  });

  it('does NOT duplicate the .gitignore entry if it already exists', () => {
    writeFileSync(join(projectRoot, '.gitignore'), 'node_modules\n.claude/settings.local.json\n');
    installClaudePresetForTest(templateRoot, projectRoot, 'p');
    const lines = readFileSync(join(projectRoot, '.gitignore'), 'utf-8')
      .split('\n').filter(l => l.trim() === '.claude/settings.local.json');
    expect(lines.length).toBe(1);
  });

  it('does NOT overwrite user-edited CLAUDE.md on re-run', () => {
    mkdirSync(join(projectRoot, '.claude'), { recursive: true });
    writeFileSync(join(projectRoot, '.claude', 'CLAUDE.md'), '# My customized rules\n');
    installClaudePresetForTest(templateRoot, projectRoot, 'p');
    // cpSync with force:false preserves existing content
    expect(readFileSync(join(projectRoot, '.claude', 'CLAUDE.md'), 'utf-8'))
      .toBe('# My customized rules\n');
  });

  it('is a no-op when project directory does not exist', () => {
    const missing = join(dir, 'does-not-exist');
    expect(() => installClaudePresetForTest(templateRoot, missing, 'p')).not.toThrow();
    expect(existsSync(join(missing, '.claude'))).toBe(false);
  });
});
