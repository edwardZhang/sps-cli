/**
 * Phase 0 characterization — CLI `sps reset`
 *
 * 锁定 v0.49.16 行为：--card / --all 的卡片状态回退。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createTestProject,
  destroyTestProject,
  seedCard,
  type TestProjectFixture,
} from '../helpers/testProject';
import { runCli } from '../helpers/cliRunner';

describe('E2E `sps reset`', () => {
  let fx: TestProjectFixture;
  let prevHome: string | undefined;

  beforeEach(() => {
    prevHome = process.env.HOME;
    fx = createTestProject({ project: 'reset-test' });
    process.env.HOME = fx.home;
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    destroyTestProject(fx);
  });

  it('缺参数非 0 退出', async () => {
    const result = await runCli(['reset'], { home: fx.home });
    expect(result.exitCode).not.toBe(0);
  });

  it('不存在的项目非 0 退出', async () => {
    const result = await runCli(['reset', 'no-such'], { home: fx.home });
    expect(result.exitCode).not.toBe(0);
  });

  it('--card 指定卡片重置，状态回到 Planning', async () => {
    const seq = await seedCard(fx, 'to-reset', '', 'Done');
    // 确认卡在 done/
    expect(readdirSync(resolve(fx.cardsDir, 'done')).length).toBe(1);
    const result = await runCli(['reset', 'reset-test', '--card', String(seq)], {
      home: fx.home,
      timeoutMs: 15000,
    });
    expect(result.exitCode).toBe(0);
    // done/ 应该空，planning/ 应该有一张
    expect(existsSync(resolve(fx.cardsDir, 'done'))
      ? readdirSync(resolve(fx.cardsDir, 'done')).filter((f) => f.endsWith('.md')).length
      : 0).toBe(0);
    expect(readdirSync(resolve(fx.cardsDir, 'planning')).filter((f) => f.endsWith('.md')).length).toBe(1);
  });

  it('--all 重置所有卡片', async () => {
    await seedCard(fx, 'a', '', 'Done');
    await seedCard(fx, 'b', '', 'Inprogress');
    await seedCard(fx, 'c', '', 'Todo');
    const result = await runCli(['reset', 'reset-test', '--all'], {
      home: fx.home,
      timeoutMs: 15000,
    });
    expect(result.exitCode).toBe(0);
    // 三张卡都应该在 planning/
    expect(readdirSync(resolve(fx.cardsDir, 'planning')).filter((f) => f.endsWith('.md')).length).toBe(3);
  });

  // v0.49.16 实测：--card 指定不存在的 seq，当前行为是静默 exit 0（reset 很宽容）。
  // Phase 0 锁定此行为；service 层重构时再决定是否改。
  it('--card 不存在的 seq 当前静默退出 0 (已知宽容)', async () => {
    await seedCard(fx, 'real', '', 'Done');
    const result = await runCli(['reset', 'reset-test', '--card', '999'], {
      home: fx.home,
      timeoutMs: 15000,
    });
    expect(result.exitCode).toBe(0);
  });
});
