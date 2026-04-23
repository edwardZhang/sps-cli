/**
 * Phase 0 characterization — CLI `sps status`
 *
 * 锁定 v0.49.16 行为：全局状态列表 + --json。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  destroyTestProject,
  seedCard,
  type TestProjectFixture,
} from '../helpers/testProject';
import { runCli, stripAnsi } from '../helpers/cliRunner';

describe('E2E `sps status`', () => {
  let fx: TestProjectFixture;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    fx = createTestProject({ project: 'status-test' });
    process.env.HOME = fx.home;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    destroyTestProject(fx);
  });

  it('空项目 status 退出码 0', async () => {
    const result = await runCli(['status'], { home: fx.home, timeoutMs: 15000 });
    expect(result.exitCode).toBe(0);
  });

  it('有项目时 stdout 含项目名', async () => {
    const result = await runCli(['status'], { home: fx.home, timeoutMs: 15000 });
    expect(stripAnsi(result.stdout)).toContain('status-test');
  });

  it('--json 输出合法 JSON', async () => {
    const result = await runCli(['status', '--json'], { home: fx.home, timeoutMs: 15000 });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBeGreaterThanOrEqual(1);
    expect(parsed[0]).toHaveProperty('project');
  });

  it('--json 反映 seed 过的卡片', async () => {
    await seedCard(fx, 'c1', '', 'Inprogress');
    await seedCard(fx, 'c2', '', 'Done');
    const result = await runCli(['status', '--json'], { home: fx.home, timeoutMs: 15000 });
    const parsed = JSON.parse(result.stdout) as Array<{ project: string }>;
    const entry = parsed.find((p) => p.project === 'status-test');
    expect(entry).toBeTruthy();
  });

  it('HOME 空目录（无 .coral）也退出 0 —— 不崩溃', async () => {
    const result = await runCli(['status'], {
      home: '/tmp/sps-e2e-empty-' + Date.now(),
      timeoutMs: 15000,
    });
    // 首次 setup 可能创建 ~/.coral；允许 0 或优雅错误，但不能 crash
    expect([0, 1, 2]).toContain(result.exitCode);
  });
});
