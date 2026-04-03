/**
 * @module        shellEnv.test
 * @description   Shell 环境配置解析的单元测试
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-29
 * @updated       2026-04-03
 *
 * @role          test
 * @layer         core
 * @boundedContext configuration
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseShellConf, sourceCombinedConf, sourceShellConf } from './shellEnv.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sps-shellenv-test-'));
}

describe('parseShellConf', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('parses KEY=value lines', () => {
    const file = join(tempDir, 'conf');
    writeFileSync(file, 'FOO=bar\nBAZ=qux\n');
    const result = parseShellConf(file);
    expect(result.FOO).toBe('bar');
    expect(result.BAZ).toBe('qux');
  });

  it('parses export KEY=value', () => {
    const file = join(tempDir, 'conf');
    writeFileSync(file, 'export MY_VAR=hello\n');
    expect(parseShellConf(file).MY_VAR).toBe('hello');
  });

  it('parses double-quoted values', () => {
    const file = join(tempDir, 'conf');
    writeFileSync(file, 'MY_VAR="hello world"\n');
    expect(parseShellConf(file).MY_VAR).toBe('hello world');
  });

  it('parses single-quoted values', () => {
    const file = join(tempDir, 'conf');
    writeFileSync(file, "MY_VAR='single'\n");
    expect(parseShellConf(file).MY_VAR).toBe('single');
  });

  it('skips comments and blank lines', () => {
    const file = join(tempDir, 'conf');
    writeFileSync(file, '# comment\n\nKEY=val\n# another\n');
    const result = parseShellConf(file);
    expect(Object.keys(result).filter(k => k === 'KEY')).toHaveLength(1);
    expect(result.KEY).toBe('val');
  });

  it('returns empty object for nonexistent file', () => {
    expect(parseShellConf(join(tempDir, 'no-file'))).toEqual({});
  });
});

describe('sourceShellConf', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('sources variables via bash', () => {
    const file = join(tempDir, 'conf');
    writeFileSync(file, 'TEST_SRC_VAR=sourced_value\n');
    const result = sourceShellConf(file);
    expect(result.TEST_SRC_VAR).toBe('sourced_value');
  });

  it('resolves variable interpolation', () => {
    const file = join(tempDir, 'conf');
    writeFileSync(file, 'BASE=hello\nDERIVED="${BASE}_world"\n');
    const result = sourceShellConf(file);
    expect(result.DERIVED).toBe('hello_world');
  });
});

describe('sourceCombinedConf', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('returns empty when no files exist', () => {
    expect(sourceCombinedConf(['/tmp/no1', '/tmp/no2'])).toEqual({});
  });

  it('sources a single file', () => {
    const file = join(tempDir, 'env');
    writeFileSync(file, 'SINGLE=yes\n');
    const result = sourceCombinedConf([file]);
    expect(result.SINGLE).toBe('yes');
  });

  it('merges multiple files with later overriding earlier', () => {
    const env = join(tempDir, 'env');
    const conf = join(tempDir, 'conf');
    writeFileSync(env, 'SHARED=from_env\nENV_ONLY=env\n');
    writeFileSync(conf, 'SHARED=from_conf\nCONF_ONLY=conf\n');
    const result = sourceCombinedConf([env, conf]);
    expect(result.SHARED).toBe('from_conf');
    expect(result.ENV_ONLY).toBe('env');
    expect(result.CONF_ONLY).toBe('conf');
  });

  it('later file can reference earlier file variables', () => {
    const env = join(tempDir, 'env');
    const conf = join(tempDir, 'conf');
    writeFileSync(env, 'BASE_URL=https://api.example.com\n');
    writeFileSync(conf, 'API_ENDPOINT="${BASE_URL}/v1"\n');
    const result = sourceCombinedConf([env, conf]);
    expect(result.API_ENDPOINT).toBe('https://api.example.com/v1');
  });

  it('skips nonexistent files gracefully', () => {
    const existing = join(tempDir, 'exists');
    writeFileSync(existing, 'EXISTS=yes\n');
    const result = sourceCombinedConf(['/tmp/no-file-xyz', existing]);
    expect(result.EXISTS).toBe('yes');
  });
});
