import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activePipelineFile,
  cardsDir,
  cardsSeqFile,
  cardsStateDir,
  coralRoot,
  home,
  logsDir,
  PipelineFilenameRe,
  PipelineLogFilenameRe,
  pipelineFile,
  pipelinesDir,
  projectConfFile,
  projectDir,
  projectsDir,
  runtimeDir,
  slotFromMarkerFilename,
  slotNameFromNumber,
  stateFile,
  supervisorPidFile,
  userSkillsDir,
  WorkerMarkerFilenameRe,
  workerLogLineTag,
  workerMarkerFile,
} from './runtimePaths.js';

describe('runtimePaths —— root 层', () => {
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    process.env.HOME = '/tmp/fake-home';
  });
  afterEach(() => {
    process.env.HOME = prevHome;
  });

  it('home() 读 env', () => {
    expect(home()).toBe('/tmp/fake-home');
  });

  it('缺 HOME 抛', () => {
    delete process.env.HOME;
    expect(() => home()).toThrow(/HOME environment variable/);
  });

  it('coralRoot 拼 .coral', () => {
    expect(coralRoot()).toBe('/tmp/fake-home/.coral');
  });

  it('projectsDir / userSkillsDir / projectDir 基本拼装', () => {
    expect(projectsDir()).toBe('/tmp/fake-home/.coral/projects');
    expect(userSkillsDir()).toBe('/tmp/fake-home/.coral/skills');
    expect(projectDir('alpha')).toBe('/tmp/fake-home/.coral/projects/alpha');
  });
});

describe('runtimePaths —— project 层', () => {
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    process.env.HOME = '/h';
  });
  afterEach(() => {
    process.env.HOME = prevHome;
  });

  it('runtime / conf / state / supervisor', () => {
    expect(runtimeDir('p')).toBe('/h/.coral/projects/p/runtime');
    expect(projectConfFile('p')).toBe('/h/.coral/projects/p/conf');
    expect(stateFile('p')).toBe('/h/.coral/projects/p/runtime/state.json');
    expect(supervisorPidFile('p')).toBe('/h/.coral/projects/p/runtime/supervisor.pid');
  });

  it('cards / seq / stateDir 大小写和非字母数字正规化', () => {
    expect(cardsDir('p')).toBe('/h/.coral/projects/p/cards');
    expect(cardsSeqFile('p')).toBe('/h/.coral/projects/p/cards/seq.txt');
    expect(cardsStateDir('p', 'Inprogress')).toBe('/h/.coral/projects/p/cards/inprogress');
    expect(cardsStateDir('p', 'QA')).toBe('/h/.coral/projects/p/cards/qa');
    expect(cardsStateDir('p', 'Done')).toBe('/h/.coral/projects/p/cards/done');
  });

  it('logs / pipelines', () => {
    expect(logsDir('p')).toBe('/h/.coral/projects/p/logs');
    expect(pipelinesDir('p')).toBe('/h/.coral/projects/p/pipelines');
    expect(activePipelineFile('p')).toBe('/h/.coral/projects/p/pipelines/project.yaml');
    expect(pipelineFile('p', 'sample.yaml')).toBe('/h/.coral/projects/p/pipelines/sample.yaml');
  });
});

describe('runtimePaths —— worker marker', () => {
  let prevHome: string | undefined;
  beforeEach(() => {
    prevHome = process.env.HOME;
    process.env.HOME = '/h';
  });
  afterEach(() => {
    process.env.HOME = prevHome;
  });

  it('workerMarkerFile 产出双前缀文件名（v0.49.16 实际格式）', () => {
    expect(workerMarkerFile('p', 'worker-1')).toBe(
      '/h/.coral/projects/p/runtime/worker-worker-1-current.json',
    );
  });

  it('slotNameFromNumber 标准化', () => {
    expect(slotNameFromNumber(1)).toBe('worker-1');
    expect(slotNameFromNumber(42)).toBe('worker-42');
  });

  it('WorkerMarkerFilenameRe 匹配双前缀', () => {
    const m = 'worker-worker-3-current.json'.match(WorkerMarkerFilenameRe);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('3');
  });

  it('WorkerMarkerFilenameRe 兼容单前缀老格式', () => {
    const m = 'worker-2-current.json'.match(WorkerMarkerFilenameRe);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe('2');
  });

  it('WorkerMarkerFilenameRe 拒非 marker 文件名', () => {
    expect('state.json'.match(WorkerMarkerFilenameRe)).toBeNull();
    expect('worker-x-current.json'.match(WorkerMarkerFilenameRe)).toBeNull();
    expect('pipeline.log'.match(WorkerMarkerFilenameRe)).toBeNull();
  });

  it('slotFromMarkerFilename 抽数字', () => {
    expect(slotFromMarkerFilename('worker-worker-1-current.json')).toBe(1);
    expect(slotFromMarkerFilename('worker-2-current.json')).toBe(2);
    expect(slotFromMarkerFilename('whatever.json')).toBeNull();
    expect(slotFromMarkerFilename('worker-0-current.json')).toBeNull(); // slot 必须 > 0
  });
});

describe('runtimePaths —— patterns', () => {
  it('PipelineLogFilenameRe 匹配日期后缀', () => {
    expect(PipelineLogFilenameRe.test('pipeline-2026-04-23.log')).toBe(true);
    expect(PipelineLogFilenameRe.test('pipeline-2026-4-1.log')).toBe(false);
    expect(PipelineLogFilenameRe.test('pipeline.log')).toBe(false);
  });

  it('workerLogLineTag', () => {
    expect(workerLogLineTag(3)).toBe('worker-3');
  });

  it('PipelineFilenameRe 拒路径穿越', () => {
    expect(PipelineFilenameRe.test('project.yaml')).toBe(true);
    expect(PipelineFilenameRe.test('sample.yaml.example')).toBe(true);
    expect(PipelineFilenameRe.test('../etc/passwd')).toBe(false);
    expect(PipelineFilenameRe.test('a/b.yaml')).toBe(false);
  });
});
