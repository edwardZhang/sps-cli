/**
 * Phase 0 characterization — CLI `sps tick`
 *
 * 锁定 v0.49.16 行为：dry-run 模式下的 pipeline 推进。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  destroyTestProject,
  seedCard,
  type TestProjectFixture,
} from '../helpers/testProject';
import { runCli, stripAnsi } from '../helpers/cliRunner';

describe('E2E `sps tick`', () => {
  let fx: TestProjectFixture;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    fx = createTestProject({ project: 'tick-test' });
    process.env.HOME = fx.home;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    destroyTestProject(fx);
  });

  it('空项目 dry-run 退出码 0', async () => {
    const result = await runCli(['tick', 'tick-test', '--dry-run'], {
      home: fx.home,
      timeoutMs: 30000,
    });
    expect(result.exitCode).toBe(0);
  });

  it('不存在的项目非 0 退出', async () => {
    const result = await runCli(['tick', 'no-such', '--dry-run'], {
      home: fx.home,
      timeoutMs: 15000,
    });
    expect(result.exitCode).not.toBe(0);
  });

  it('缺项目参数退出码非 0', async () => {
    const result = await runCli(['tick'], { home: fx.home });
    expect(result.exitCode).not.toBe(0);
  });

  it('有 Backlog 卡的 dry-run 可执行', async () => {
    await seedCard(fx, 'bk1', '', 'Backlog');
    await seedCard(fx, 'bk2', '', 'Backlog');
    const result = await runCli(['tick', 'tick-test', '--dry-run'], {
      home: fx.home,
      timeoutMs: 30000,
    });
    // exitCode 可能是 0 或 2（有 pending work） —— 锁定 shape 即可
    expect([0, 2]).toContain(result.exitCode);
    expect(stripAnsi(result.stdout + result.stderr)).not.toMatch(/unhandled|ECONNREFUSED/i);
  });
});
