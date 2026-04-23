/**
 * @module        test/e2e/helpers/testProject
 * @description   Phase 0 characterization 用：构造一个 fake HOME + 最小 project 结构
 *
 * 不走 CLI spawn —— 直接操作文件系统 + 调用 Domain 来建 fixture，快且隔离。
 * 每个 test 一个 tmp HOME，afterEach 自动清理。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

export interface TestProjectFixture {
  /** 唯一 HOME 根，整个测试结束清掉 */
  home: string;
  /** project 名（默认 testproj） */
  project: string;
  /** ~/.coral/projects/<project>/ */
  projectDir: string;
  /** ~/.coral/projects/<project>/runtime */
  runtimeDir: string;
  /** ~/.coral/projects/<project>/cards */
  cardsDir: string;
  /** ~/.coral/projects/<project>/logs */
  logsDir: string;
}

export interface TestProjectOptions {
  project?: string;
  /** 额外写 repo PROJECT_DIR 指向，默认用 home 本身 */
  projectDirConf?: string;
}

/**
 * 创建一个 fake HOME + 一个最小合法的 project。
 * 不设置 process.env.HOME —— 调用方负责。
 */
export function createTestProject(opts: TestProjectOptions = {}): TestProjectFixture {
  const project = opts.project ?? 'testproj';
  const home = mkdtempSync(resolve(tmpdir(), 'sps-e2e-'));
  const projectDir = resolve(home, '.coral', 'projects', project);
  const runtimeDir = resolve(projectDir, 'runtime');
  const cardsDir = resolve(projectDir, 'cards');
  const logsDir = resolve(projectDir, 'logs');
  const pipelinesDir = resolve(projectDir, 'pipelines');

  mkdirSync(cardsDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(pipelinesDir, { recursive: true });

  writeFileSync(resolve(cardsDir, 'seq.txt'), '0\n');

  writeFileSync(
    resolve(projectDir, 'conf'),
    `export PROJECT_NAME="${project}"\n` +
      `export PROJECT_DIR="${opts.projectDirConf ?? home}"\n` +
      `export PM_TOOL="markdown"\n` +
      `export AGENT_PROVIDER="claude"\n` +
      `export MAX_WORKERS="1"\n` +
      `export MERGE_BRANCH="main"\n`,
  );

  writeFileSync(
    resolve(pipelinesDir, 'project.yaml'),
    `mode: project\n` +
      `stages:\n` +
      `  - name: develop\n` +
      `    on_complete: "move_card Done"\n` +
      `    on_fail:\n` +
      `      action: "label NEEDS-FIX"\n` +
      `      halt: true\n`,
  );

  return { home, project, projectDir, runtimeDir, cardsDir, logsDir };
}

/** 同步 cleanup；测试 afterEach 调用。 */
export function destroyTestProject(fx: TestProjectFixture): void {
  rmSync(fx.home, { recursive: true, force: true });
}

/**
 * 直接通过 Domain 层（MarkdownTaskBackend）创建一张卡，返回 seq。
 * 不走 Console/CLI —— 是 test setup helper，不是被测对象。
 */
export async function seedCard(
  fx: TestProjectFixture,
  title: string,
  desc = '',
  state: 'Planning' | 'Backlog' | 'Todo' | 'Inprogress' | 'QA' | 'Done' = 'Planning',
): Promise<number> {
  const { ProjectContext } = await import('../../../src/core/context.js');
  const { createTaskBackend } = await import('../../../src/providers/registry.js');
  const ctx = ProjectContext.load(fx.project);
  const backend = createTaskBackend(ctx.config);
  await backend.bootstrap();
  const card = await backend.create(title, desc, state);
  if (state !== 'Planning') {
    await backend.move(card.seq, state);
  }
  return Number(card.seq);
}

/**
 * 直接写一个 worker marker 到 runtime/ —— 模拟 pipeline 已派发 worker。
 * 真实文件名是 worker-worker-<N>-current.json（slot name "worker-N" + prefix）。
 */
export function seedWorkerMarker(
  fx: TestProjectFixture,
  slot: number,
  cardId: string,
  stage: string,
  extra: { pid?: number; sessionId?: string; dispatchedAt?: string } = {},
): string {
  const slotName = `worker-${slot}`;
  const path = resolve(fx.runtimeDir, `worker-${slotName}-current.json`);
  const payload = {
    cardId,
    stage,
    dispatchedAt: extra.dispatchedAt ?? new Date().toISOString(),
    ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
    ...(extra.pid !== undefined ? { pid: extra.pid } : {}),
  };
  writeFileSync(path, JSON.stringify(payload));
  return path;
}
