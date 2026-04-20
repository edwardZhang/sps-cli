/**
 * @module        cardMarkStarted.test
 * @description   sps card mark-started 命令单元测试
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const addLabelMock = vi.fn(async () => {});

vi.mock('../core/context.js', () => ({
  ProjectContext: {
    load: vi.fn(() => ({
      projectName: 'test',
      config: { raw: {} },
      paths: { repoDir: '/tmp/test-repo', logsDir: '/tmp/test-logs' },
      maxWorkers: 1,
    })),
  },
}));

vi.mock('../core/projectPipelineAdapter.js', () => ({
  ProjectPipelineAdapter: class {
    states = { planning: 'P', backlog: 'B', ready: 'R', done: 'D' };
    stages = [];
  },
}));

vi.mock('../providers/registry.js', () => ({
  createTaskBackend: () => ({
    addLabel: addLabelMock,
  }),
}));

describe('executeCardMarkStarted', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    addLabelMock.mockClear();
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('adds STARTED-<stage> label using --stage flag', async () => {
    const { executeCardMarkStarted } = await import('./cardMarkStarted.js');
    await executeCardMarkStarted('my-project', ['42'], { stage: 'develop' });
    expect(addLabelMock).toHaveBeenCalledWith('42', 'STARTED-develop');
  });

  it('defaults stage to "develop" when no source provides one', async () => {
    delete process.env.SPS_STAGE;
    const { executeCardMarkStarted } = await import('./cardMarkStarted.js');
    await executeCardMarkStarted('my-project', ['1'], {});
    expect(addLabelMock).toHaveBeenCalledWith('1', 'STARTED-develop');
  });

  it('exits with code 2 when seq missing and SPS_WORKER_SLOT not set', async () => {
    delete process.env.SPS_WORKER_SLOT;
    const { executeCardMarkStarted } = await import('./cardMarkStarted.js');
    await expect(executeCardMarkStarted('p', [], {})).rejects.toThrow('exit:2');
  });

  describe('marker file resolution (hook usage)', () => {
    const originalHome = process.env.HOME;
    const originalSlot = process.env.SPS_WORKER_SLOT;
    let tmpHome: string;

    beforeEach(() => {
      tmpHome = mkdtempSync(resolve(tmpdir(), 'sps-mark-started-'));
      mkdirSync(resolve(tmpHome, '.coral', 'projects', 'p', 'runtime'), { recursive: true });
      process.env.HOME = tmpHome;
      process.env.SPS_WORKER_SLOT = 'worker-1';
    });

    afterEach(() => {
      rmSync(tmpHome, { recursive: true, force: true });
      if (originalHome !== undefined) process.env.HOME = originalHome;
      else delete process.env.HOME;
      if (originalSlot !== undefined) process.env.SPS_WORKER_SLOT = originalSlot;
      else delete process.env.SPS_WORKER_SLOT;
    });

    it('reads seq + stage from marker file when seq omitted', async () => {
      const markerPath = resolve(tmpHome, '.coral', 'projects', 'p', 'runtime', 'worker-worker-1-current.json');
      writeFileSync(markerPath, JSON.stringify({ cardId: '77', stage: 'review', dispatchedAt: new Date().toISOString() }));
      const { executeCardMarkStarted } = await import('./cardMarkStarted.js');
      await executeCardMarkStarted('p', [], {});
      expect(addLabelMock).toHaveBeenCalledWith('77', 'STARTED-review');
    });

    it('does NOT fall back to $SPS_CARD_ID env (prevents mis-marking)', async () => {
      process.env.SPS_CARD_ID = '1';
      const { executeCardMarkStarted } = await import('./cardMarkStarted.js');
      await expect(executeCardMarkStarted('p', [], {})).rejects.toThrow('exit:2');
      expect(addLabelMock).not.toHaveBeenCalled();
      delete process.env.SPS_CARD_ID;
    });
  });
});
