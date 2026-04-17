/**
 * @module        cardMarkComplete.test
 * @description   sps card mark-complete 命令单元测试
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-04-17
 * @updated       2026-04-17
 *
 * @role          test
 * @layer         command
 * @boundedContext taskManagement
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock dependencies BEFORE importing the module under test.
const addLabelMock = vi.fn(async () => {});
const getBySeqMock = vi.fn(async () => null);

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
    getBySeq: getBySeqMock,
  }),
}));

describe('executeCardMarkComplete', () => {
  const originalEnv = process.env.SPS_STAGE;
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
    if (originalEnv !== undefined) {
      process.env.SPS_STAGE = originalEnv;
    } else {
      delete process.env.SPS_STAGE;
    }
  });

  it('adds COMPLETED-<stage> label using --stage flag', async () => {
    const { executeCardMarkComplete } = await import('./cardMarkComplete.js');
    await executeCardMarkComplete('my-project', ['42'], { stage: 'develop' });
    expect(addLabelMock).toHaveBeenCalledWith('42', 'COMPLETED-develop');
  });

  it('falls back to $SPS_STAGE env var when flag missing', async () => {
    process.env.SPS_STAGE = 'qa';
    const { executeCardMarkComplete } = await import('./cardMarkComplete.js');
    await executeCardMarkComplete('my-project', ['7'], {});
    expect(addLabelMock).toHaveBeenCalledWith('7', 'COMPLETED-qa');
  });

  it('defaults stage to "develop" when neither flag nor env set', async () => {
    delete process.env.SPS_STAGE;
    const { executeCardMarkComplete } = await import('./cardMarkComplete.js');
    await executeCardMarkComplete('my-project', ['1'], {});
    expect(addLabelMock).toHaveBeenCalledWith('1', 'COMPLETED-develop');
  });

  it('emits JSON output when --json flag set', async () => {
    const { executeCardMarkComplete } = await import('./cardMarkComplete.js');
    await executeCardMarkComplete('p', ['5'], { stage: 'integrate', json: true });
    const jsonCall = logSpy.mock.calls.find((c: unknown[]) =>
      typeof c[0] === 'string' && (c[0] as string).startsWith('{'),
    );
    expect(jsonCall).toBeDefined();
    expect(JSON.parse(jsonCall![0] as string)).toMatchObject({
      ok: true, seq: '5', stage: 'integrate', label: 'COMPLETED-integrate',
    });
  });

  it('exits with code 2 when seq missing', async () => {
    const { executeCardMarkComplete } = await import('./cardMarkComplete.js');
    await expect(executeCardMarkComplete('p', [], {})).rejects.toThrow('exit:2');
  });
});
