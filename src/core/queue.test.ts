/**
 * @module        queue.test
 * @description   流水线队列读写操作的单元测试
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
 * @boundedContext pipeline
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readQueue, removeFromQueue, writeQueue } from './queue.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sps-queue-test-'));
}

describe('readQueue', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('returns empty array when file does not exist', () => {
    expect(readQueue(join(tempDir, 'nonexistent.json'))).toEqual([]);
  });

  it('reads a valid queue file', () => {
    const file = join(tempDir, 'queue.json');
    writeFileSync(file, '[1, 2, 3, 4, 5]\n');
    expect(readQueue(file)).toEqual([1, 2, 3, 4, 5]);
  });

  it('returns empty array for invalid JSON', () => {
    const file = join(tempDir, 'bad.json');
    writeFileSync(file, 'NOT JSON');
    expect(readQueue(file)).toEqual([]);
  });

  it('returns empty array when file contains non-array JSON', () => {
    const file = join(tempDir, 'obj.json');
    writeFileSync(file, '{"not": "array"}');
    expect(readQueue(file)).toEqual([]);
  });

  it('filters out non-number values', () => {
    const file = join(tempDir, 'mixed.json');
    writeFileSync(file, '[1, "two", 3, null, 5, true]');
    expect(readQueue(file)).toEqual([1, 3, 5]);
  });

  it('handles empty array', () => {
    const file = join(tempDir, 'empty.json');
    writeFileSync(file, '[]');
    expect(readQueue(file)).toEqual([]);
  });
});

describe('writeQueue', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('writes a queue atomically', () => {
    const file = join(tempDir, 'queue.json');
    writeQueue(file, [10, 20, 30]);

    const raw = JSON.parse(readFileSync(file, 'utf-8'));
    expect(raw).toEqual([10, 20, 30]);
  });

  it('overwrites existing queue', () => {
    const file = join(tempDir, 'queue.json');
    writeQueue(file, [1, 2, 3]);
    writeQueue(file, [4, 5]);

    expect(readQueue(file)).toEqual([4, 5]);
  });

  it('writes empty array', () => {
    const file = join(tempDir, 'queue.json');
    writeQueue(file, []);
    expect(readQueue(file)).toEqual([]);
  });

  it('does not leave temp files', () => {
    const file = join(tempDir, 'queue.json');
    writeQueue(file, [1]);

    const { readdirSync } = require('node:fs');
    const files = readdirSync(tempDir) as string[];
    const tmpFiles = files.filter((f: string) => f.endsWith('.tmp'));
    expect(tmpFiles).toHaveLength(0);
  });
});

describe('removeFromQueue', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('removes a seq from the queue', () => {
    const file = join(tempDir, 'queue.json');
    writeQueue(file, [1, 2, 3, 4, 5]);
    removeFromQueue(file, 3);
    expect(readQueue(file)).toEqual([1, 2, 4, 5]);
  });

  it('does nothing when seq not in queue', () => {
    const file = join(tempDir, 'queue.json');
    writeQueue(file, [1, 2, 3]);
    removeFromQueue(file, 99);
    expect(readQueue(file)).toEqual([1, 2, 3]);
  });

  it('handles nonexistent file gracefully', () => {
    const file = join(tempDir, 'nofile.json');
    expect(() => removeFromQueue(file, 1)).not.toThrow();
  });

  it('removes duplicate occurrences', () => {
    const file = join(tempDir, 'queue.json');
    writeQueue(file, [1, 2, 2, 3]);
    removeFromQueue(file, 2);
    expect(readQueue(file)).toEqual([1, 3]);
  });
});
