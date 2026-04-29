/**
 * Phase 0 characterization — CLI `sps card add`
 *
 * 锁定 v0.49.16 行为：stdout / 退出码 / 写入的 md 文件内容。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestProject, destroyTestProject, type TestProjectFixture } from '../helpers/testProject';
import { runCli, stripAnsi } from '../helpers/cliRunner';

describe('E2E `sps card add`', () => {
  let fx: TestProjectFixture;

  beforeEach(() => {
    fx = createTestProject({ project: 'cli-cards' });
  });

  afterEach(() => {
    destroyTestProject(fx);
  });

  it('基本新建卡片，退出码 0', async () => {
    const result = await runCli(['card', 'add', 'cli-cards', 'my first card'], { home: fx.home });
    expect(result.exitCode).toBe(0);
    const files = readdirSync(resolve(fx.cardsDir, 'backlog'));
    expect(files.length).toBe(1);
    expect(files[0]).toMatch(/^1-.*\.md$/);
  });

  it('缺项目参数输出 usage，非 0 退出', async () => {
    const result = await runCli(['card', 'add'], { home: fx.home });
    expect(result.exitCode).not.toBe(0);
    expect(stripAnsi(result.stderr + result.stdout)).toMatch(/usage|Usage/i);
  });

  it('写入 frontmatter 含 title + seq', async () => {
    await runCli(['card', 'add', 'cli-cards', '含有中文的卡'], { home: fx.home });
    const files = readdirSync(resolve(fx.cardsDir, 'backlog'));
    const path = resolve(fx.cardsDir, 'backlog', files[0]!);
    const content = readFileSync(path, 'utf-8');
    expect(content).toMatch(/^---/);
    expect(content).toContain('title: 含有中文的卡');
    expect(content).toMatch(/seq:\s*1/);
  });

  it('第二张卡片 seq 自增到 2', async () => {
    await runCli(['card', 'add', 'cli-cards', 'first'], { home: fx.home });
    const result = await runCli(['card', 'add', 'cli-cards', 'second'], { home: fx.home });
    expect(result.exitCode).toBe(0);
    const seqContent = readFileSync(resolve(fx.cardsDir, 'seq.txt'), 'utf-8').trim();
    expect(seqContent).toBe('2');
  });

  it('带 --skill 参数写入 frontmatter.skills', async () => {
    const result = await runCli(
      ['card', 'add', 'cli-cards', 'has skills', '--skill', 'typescript,frontend'],
      { home: fx.home },
    );
    expect(result.exitCode).toBe(0);
    const files = readdirSync(resolve(fx.cardsDir, 'backlog'));
    const content = readFileSync(resolve(fx.cardsDir, 'backlog', files[0]!), 'utf-8');
    expect(content).toMatch(/skills:\s*\n\s*-\s*typescript/);
    expect(content).toMatch(/-\s*frontend/);
  });

  it('不存在的项目报错', async () => {
    const result = await runCli(['card', 'add', 'no-such', 'title'], { home: fx.home });
    expect(result.exitCode).not.toBe(0);
  });

  it('body 为空描述写入默认 (无描述)', async () => {
    await runCli(['card', 'add', 'cli-cards', 'empty body'], { home: fx.home });
    const files = readdirSync(resolve(fx.cardsDir, 'backlog'));
    const content = readFileSync(resolve(fx.cardsDir, 'backlog', files[0]!), 'utf-8');
    expect(content).toContain('## 描述');
    expect(content).toMatch(/\(无描述\)|(无描述)/);
  });

  it('seq.txt 持久化不会丢', async () => {
    await runCli(['card', 'add', 'cli-cards', 'a'], { home: fx.home });
    await runCli(['card', 'add', 'cli-cards', 'b'], { home: fx.home });
    await runCli(['card', 'add', 'cli-cards', 'c'], { home: fx.home });
    expect(readFileSync(resolve(fx.cardsDir, 'seq.txt'), 'utf-8').trim()).toBe('3');
    expect(existsSync(resolve(fx.cardsDir, 'backlog'))).toBe(true);
  });
});
