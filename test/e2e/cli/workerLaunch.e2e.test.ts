/**
 * Phase 0 characterization — CLI `sps worker launch`
 *
 * 锁定 v0.49.16 行为。用 --dry-run 避免真正 spawn claude 子进程。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestProject,
  destroyTestProject,
  seedCard,
  type TestProjectFixture,
} from '../helpers/testProject';
import { runCli, stripAnsi } from '../helpers/cliRunner';

describe('E2E `sps worker launch`', () => {
  let fx: TestProjectFixture;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    fx = createTestProject({ project: 'launch-test' });
    process.env.HOME = fx.home;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    destroyTestProject(fx);
  });

  it('缺参数退出码 2 + usage', async () => {
    const result = await runCli(['worker', 'launch'], { home: fx.home });
    expect(result.exitCode).toBe(2);
    expect(stripAnsi(result.stderr + result.stdout)).toMatch(/Usage/i);
  });

  it('不存在的项目退出码 3', async () => {
    const result = await runCli(['worker', 'launch', 'no-such', '1'], { home: fx.home });
    expect(result.exitCode).toBe(3);
  });

  it('不存在的 seq 退出码非 0', async () => {
    const result = await runCli(['worker', 'launch', 'launch-test', '999', '--dry-run'], {
      home: fx.home,
    });
    expect(result.exitCode).not.toBe(0);
  });

  // v0.49.16 实测：Backlog 卡 dry-run 会走 prepare 路径但不真正 move 文件 → 后续
  // 断言 state===Ready 失败，所以 exitCode 1。这是当前的已知怪异行为，Phase 0 锁住。
  it('Backlog 卡 dry-run exitCode 1（prepare-dry-run 不真移动的已知怪异）', async () => {
    const seq = await seedCard(fx, 'backlog card', '', 'Backlog');
    const result = await runCli(
      ['worker', 'launch', 'launch-test', String(seq), '--dry-run'],
      { home: fx.home, timeoutMs: 15000 },
    );
    expect(result.exitCode).toBe(1);
  });

  it('Todo 卡 dry-run exitCode 0（直接 launch）', async () => {
    const seq = await seedCard(fx, 'ready card', '', 'Todo');
    const result = await runCli(
      ['worker', 'launch', 'launch-test', String(seq), '--dry-run'],
      { home: fx.home, timeoutMs: 15000 },
    );
    expect(result.exitCode).toBe(0);
  });

  it('Done 卡 dry-run exitCode 0（v0.49.15 起先 move 回 Ready 再 launch）', async () => {
    const seq = await seedCard(fx, 'done card', '', 'Done');
    const result = await runCli(
      ['worker', 'launch', 'launch-test', String(seq), '--dry-run'],
      { home: fx.home, timeoutMs: 15000 },
    );
    expect(result.exitCode).toBe(0);
  });

  it('--json flag 输出结构化结果（Todo 卡）', async () => {
    const seq = await seedCard(fx, 'json card', '', 'Todo');
    const result = await runCli(
      ['worker', 'launch', 'launch-test', String(seq), '--dry-run', '--json'],
      { home: fx.home, timeoutMs: 15000 },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed).toHaveProperty('status', 'ok');
    expect(parsed).toHaveProperty('actions');
    expect(Array.isArray(parsed.actions)).toBe(true);
  });
});
