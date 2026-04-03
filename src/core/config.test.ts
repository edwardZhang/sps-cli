import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGlobalEnv, loadProjectConf, type ProjectConfig, type RawConfig, validateConfig } from './config.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeConfig(overrides?: Partial<ProjectConfig>): ProjectConfig {
  return {
    PROJECT_NAME: 'test-project',
    GITLAB_PROJECT: 'group/test-project',
    GITLAB_PROJECT_ID: '42',
    GITLAB_MERGE_BRANCH: 'develop',
    PM_TOOL: 'plane',
    MR_MODE: 'none',
    WORKER_TOOL: 'claude',
    WORKER_TRANSPORT: 'acp-sdk',
    MAX_CONCURRENT_WORKERS: 3,
    WORKER_RESTART_LIMIT: 2,
    MAX_ACTIONS_PER_TICK: 1,
    WORKER_LAUNCH_TIMEOUT_S: 120,
    WORKER_IDLE_TIMEOUT_M: 15,
    INPROGRESS_TIMEOUT_HOURS: 8,
    MONITOR_AUTO_QA: false,
    CONFLICT_DEFAULT: 'serial',
    TICK_LOCK_TIMEOUT_MINUTES: 30,
    raw: {} as RawConfig,
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────

describe('validateConfig', () => {
  it('returns no errors for a complete config', () => {
    const config = makeConfig();
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });

  it('reports missing PROJECT_NAME', () => {
    const config = makeConfig({ PROJECT_NAME: '' });
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('PROJECT_NAME');
  });

  it('reports missing GITLAB_PROJECT', () => {
    const config = makeConfig({ GITLAB_PROJECT: '' });
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('GITLAB_PROJECT');
  });

  it('reports missing GITLAB_MERGE_BRANCH', () => {
    const config = makeConfig({ GITLAB_MERGE_BRANCH: '' });
    const errors = validateConfig(config);
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe('GITLAB_MERGE_BRANCH');
  });

  it('reports multiple missing fields', () => {
    const config = makeConfig({
      PROJECT_NAME: '',
      GITLAB_PROJECT: '',
      GITLAB_MERGE_BRANCH: '',
    });
    const errors = validateConfig(config);
    expect(errors).toHaveLength(3);
    const fields = errors.map(e => e.field);
    expect(fields).toContain('PROJECT_NAME');
    expect(fields).toContain('GITLAB_PROJECT');
    expect(fields).toContain('GITLAB_MERGE_BRANCH');
  });

  it('does not require optional fields like GITLAB_PROJECT_ID', () => {
    const config = makeConfig({ GITLAB_PROJECT_ID: '' });
    const errors = validateConfig(config);
    expect(errors).toEqual([]);
  });
});

describe('resolveWorkflowTransport', () => {
  it('defaults to acp-sdk when no WORKER_TRANSPORT set', async () => {
    const { resolveWorkflowTransport } = await import('./config.js');
    const config = makeConfig();
    expect(resolveWorkflowTransport(config)).toBe('acp-sdk');
  });

  it('maps acp to acp-sdk', async () => {
    const { resolveWorkflowTransport } = await import('./config.js');
    const config = makeConfig({ raw: { WORKER_TRANSPORT: 'acp' } as any });
    expect(resolveWorkflowTransport(config)).toBe('acp-sdk');
  });

  it('always returns acp-sdk regardless of config', async () => {
    const { resolveWorkflowTransport } = await import('./config.js');
    const config = makeConfig({ raw: { WORKER_TRANSPORT: 'unknown' } as any });
    expect(resolveWorkflowTransport(config)).toBe('acp-sdk');
  });
});

describe('loadProjectConf', () => {
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'sps-config-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function writeConf(projectName: string, content: string): void {
    const confDir = join(fakeHome, '.coral', 'projects', projectName);
    mkdirSync(confDir, { recursive: true });
    writeFileSync(join(confDir, 'conf'), content);
  }

  function writeGlobalEnv(content: string): void {
    const envDir = join(fakeHome, '.coral');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, 'env'), content);
  }

  it('throws when conf file does not exist', () => {
    expect(() => loadProjectConf('nonexistent')).toThrow('Project conf not found');
  });

  it('parses simple KEY=value assignments', () => {
    writeConf('myapp', [
      'PROJECT_NAME=myapp',
      'GITLAB_PROJECT=group/myapp',
      'GITLAB_MERGE_BRANCH=develop',
    ].join('\n'));

    const config = loadProjectConf('myapp');
    expect(config.PROJECT_NAME).toBe('myapp');
    expect(config.GITLAB_PROJECT).toBe('group/myapp');
    expect(config.GITLAB_MERGE_BRANCH).toBe('develop');
  });

  it('parses export KEY="value" syntax', () => {
    writeConf('quoted', [
      'export PROJECT_NAME="my-project"',
      'export GITLAB_PROJECT="ns/repo"',
      'export GITLAB_MERGE_BRANCH="main"',
    ].join('\n'));

    const config = loadProjectConf('quoted');
    expect(config.PROJECT_NAME).toBe('my-project');
    expect(config.GITLAB_PROJECT).toBe('ns/repo');
  });

  it('skips comments and blank lines', () => {
    writeConf('comments', [
      '# This is a comment',
      '',
      'PROJECT_NAME=test',
      '# Another comment',
      'GITLAB_PROJECT=g/t',
      'GITLAB_MERGE_BRANCH=main',
    ].join('\n'));

    const config = loadProjectConf('comments');
    expect(config.PROJECT_NAME).toBe('test');
  });

  it('applies default values for missing fields', () => {
    writeConf('minimal', [
      'PROJECT_NAME=min',
      'GITLAB_PROJECT=g/min',
      'GITLAB_MERGE_BRANCH=develop',
    ].join('\n'));

    const config = loadProjectConf('minimal');
    expect(config.WORKER_TOOL).toBe('claude');
    expect(config.WORKER_TRANSPORT).toBe('acp-sdk');
    expect(config.MAX_CONCURRENT_WORKERS).toBe(3);
    expect(config.WORKER_RESTART_LIMIT).toBe(2);
    expect(config.MR_MODE).toBe('none');
    expect(config.PM_TOOL).toBe('trello');
    expect(config.CONFLICT_DEFAULT).toBe('serial');
    expect(config.MONITOR_AUTO_QA).toBe(false);
  });

  it('parses numeric fields correctly', () => {
    writeConf('nums', [
      'PROJECT_NAME=nums',
      'GITLAB_PROJECT=g/nums',
      'GITLAB_MERGE_BRANCH=main',
      'MAX_CONCURRENT_WORKERS=10',
      'WORKER_RESTART_LIMIT=5',
      'MAX_ACTIONS_PER_TICK=3',
      'WORKER_LAUNCH_TIMEOUT_S=300',
      'WORKER_IDLE_TIMEOUT_M=30',
      'INPROGRESS_TIMEOUT_HOURS=24',
    ].join('\n'));

    const config = loadProjectConf('nums');
    expect(config.MAX_CONCURRENT_WORKERS).toBe(10);
    expect(config.WORKER_RESTART_LIMIT).toBe(5);
    expect(config.MAX_ACTIONS_PER_TICK).toBe(3);
    expect(config.WORKER_LAUNCH_TIMEOUT_S).toBe(300);
    expect(config.WORKER_IDLE_TIMEOUT_M).toBe(30);
    expect(config.INPROGRESS_TIMEOUT_HOURS).toBe(24);
  });

  it('parses boolean fields correctly', () => {
    writeConf('bools', [
      'PROJECT_NAME=bools',
      'GITLAB_PROJECT=g/bools',
      'GITLAB_MERGE_BRANCH=main',
      'MONITOR_AUTO_QA=true',
    ].join('\n'));

    const config = loadProjectConf('bools');
    expect(config.MONITOR_AUTO_QA).toBe(true);
  });

  it('strips __PLACEHOLDER__ values', () => {
    writeConf('placeholders', [
      'PROJECT_NAME=ph',
      'GITLAB_PROJECT=g/ph',
      'GITLAB_MERGE_BRANCH=main',
      'GITLAB_PROJECT_ID=__PROJECT_ID__',
    ].join('\n'));

    const config = loadProjectConf('placeholders');
    expect(config.GITLAB_PROJECT_ID).toBe('');
  });

  it('uses project name as fallback for PROJECT_NAME', () => {
    writeConf('fallback', [
      'GITLAB_PROJECT=g/fb',
      'GITLAB_MERGE_BRANCH=main',
    ].join('\n'));

    const config = loadProjectConf('fallback');
    expect(config.PROJECT_NAME).toBe('fallback');
  });

  it('merges global env with project conf', () => {
    writeGlobalEnv([
      'GITLAB_URL=https://git.example.com',
      'GITLAB_TOKEN=secret-token',
    ].join('\n'));

    writeConf('merged', [
      'PROJECT_NAME=merged',
      'GITLAB_PROJECT=g/merged',
      'GITLAB_MERGE_BRANCH=main',
    ].join('\n'));

    const config = loadProjectConf('merged');
    expect(config.raw.GITLAB_URL).toBe('https://git.example.com');
    expect(config.raw.GITLAB_TOKEN).toBe('secret-token');
  });

  it('parses PM_TOOL variants', () => {
    for (const tool of ['plane', 'trello', 'markdown'] as const) {
      writeConf(`pm-${tool}`, [
        'PROJECT_NAME=test',
        'GITLAB_PROJECT=g/test',
        'GITLAB_MERGE_BRANCH=main',
        `PM_TOOL=${tool}`,
      ].join('\n'));

      const config = loadProjectConf(`pm-${tool}`);
      expect(config.PM_TOOL).toBe(tool);
    }
  });

  it('parses WORKER_TOOL variants', () => {
    for (const tool of ['claude', 'codex'] as const) {
      writeConf(`wt-${tool}`, [
        'PROJECT_NAME=test',
        'GITLAB_PROJECT=g/test',
        'GITLAB_MERGE_BRANCH=main',
        `WORKER_TOOL=${tool}`,
      ].join('\n'));

      const config = loadProjectConf(`wt-${tool}`);
      expect(config.WORKER_TOOL).toBe(tool);
    }
  });

  it('handles shell variable interpolation via bash sourcing', () => {
    writeGlobalEnv('PLANE_URL=https://plane.example.com');
    writeConf('interp', [
      'PROJECT_NAME=interp',
      'GITLAB_PROJECT=g/interp',
      'GITLAB_MERGE_BRANCH=main',
      'PLANE_API_URL="${PLANE_URL}/api/v1"',
    ].join('\n'));

    const config = loadProjectConf('interp');
    // bash sourcing should interpolate ${PLANE_URL}
    expect(config.raw.PLANE_API_URL).toBe('https://plane.example.com/api/v1');
  });

  it('loads conf without global env file', () => {
    // No writeGlobalEnv — ~/.coral/env does not exist
    writeConf('no-env', [
      'PROJECT_NAME=no-env',
      'GITLAB_PROJECT=g/no-env',
      'GITLAB_MERGE_BRANCH=main',
    ].join('\n'));

    const config = loadProjectConf('no-env');
    expect(config.PROJECT_NAME).toBe('no-env');
  });

  it('parses single-quoted values', () => {
    writeConf('sq', [
      "PROJECT_NAME='single-quoted'",
      "GITLAB_PROJECT='g/sq'",
      "GITLAB_MERGE_BRANCH='develop'",
    ].join('\n'));

    const config = loadProjectConf('sq');
    expect(config.PROJECT_NAME).toBe('single-quoted');
  });

  it('parses all MR_MODE variants', () => {
    for (const mr of ['none', 'create'] as const) {
      writeConf(`mr-${mr}`, [
        'PROJECT_NAME=test',
        'GITLAB_PROJECT=g/test',
        'GITLAB_MERGE_BRANCH=main',
        `MR_MODE=${mr}`,
      ].join('\n'));
      expect(loadProjectConf(`mr-${mr}`).MR_MODE).toBe(mr);
    }
  });

  it('exposes raw config for PM-specific fields', () => {
    writeConf('raw', [
      'PROJECT_NAME=raw',
      'GITLAB_PROJECT=g/raw',
      'GITLAB_MERGE_BRANCH=main',
      'TRELLO_BOARD_ID=abc123',
      'PLANE_STATE_PLANNING=uuid-1',
    ].join('\n'));

    const config = loadProjectConf('raw');
    expect(config.raw.TRELLO_BOARD_ID).toBe('abc123');
    expect(config.raw.PLANE_STATE_PLANNING).toBe('uuid-1');
  });
});

describe('loadGlobalEnv', () => {
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'sps-env-test-'));
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('returns empty object when env file does not exist', () => {
    const env = loadGlobalEnv();
    expect(env).toEqual({});
  });

  it('loads variables from ~/.coral/env', () => {
    const envDir = join(fakeHome, '.coral');
    mkdirSync(envDir, { recursive: true });
    writeFileSync(join(envDir, 'env'), [
      'GITLAB_URL=https://git.test.com',
      'PLANE_API_KEY=pk-123',
    ].join('\n'));

    const env = loadGlobalEnv();
    expect(env.GITLAB_URL).toBe('https://git.test.com');
    expect(env.PLANE_API_KEY).toBe('pk-123');
  });
});
