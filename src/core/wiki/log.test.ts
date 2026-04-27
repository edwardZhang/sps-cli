/**
 * @module        log.test
 * @description   wiki .log.md 时间序列测试
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wikiLogFile } from '../../shared/wikiPaths.js';
import { appendLog, readLog } from './log.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wiki-log-test-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('appendLog / readLog', () => {
  it('readLog returns default header when file missing', () => {
    const content = readLog(repo);
    expect(content).toContain('# Wiki Operation Log');
  });

  it('appendLog creates file with first entry', () => {
    appendLog(repo, {
      action: 'init',
      target: 'wiki/',
      message: 'Initialized wiki structure',
      timestamp: '2026-04-27T10:00:00Z',
    });
    const content = readFileSync(wikiLogFile(repo), 'utf-8');
    expect(content).toContain('# Wiki Operation Log');
    expect(content).toContain('## 2026-04-27T10:00:00Z · init · wiki/');
    expect(content).toContain('Initialized wiki structure');
  });

  it('newest entry on top', () => {
    appendLog(repo, {
      action: 'update',
      target: 'src/A.ts',
      message: 'first entry',
      timestamp: '2026-04-27T10:00:00Z',
    });
    appendLog(repo, {
      action: 'update',
      target: 'src/B.ts',
      message: 'second entry',
      timestamp: '2026-04-27T11:00:00Z',
    });
    const content = readFileSync(wikiLogFile(repo), 'utf-8');
    const idxFirst = content.indexOf('first entry');
    const idxSecond = content.indexOf('second entry');
    expect(idxSecond).toBeLessThan(idxFirst);
    expect(idxSecond).toBeGreaterThan(0);
  });

  it('renders pages list as wikilinks', () => {
    appendLog(repo, {
      action: 'write',
      target: 'lessons/Stop Hook Race',
      message: 'Wrote new lesson',
      timestamp: 'now',
      pages: ['lessons/Stop Hook Race', 'modules/PipelineService'],
    });
    const content = readFileSync(wikiLogFile(repo), 'utf-8');
    expect(content).toContain('[[lessons/Stop Hook Race]]');
    expect(content).toContain('[[modules/PipelineService]]');
  });

  it('uses now() when timestamp missing', () => {
    const before = Date.now();
    appendLog(repo, {
      action: 'lint',
      target: '*',
      message: 'lint pass',
    });
    const content = readFileSync(wikiLogFile(repo), 'utf-8');
    const tsMatch = content.match(/## (\S+Z) /);
    expect(tsMatch).not.toBeNull();
    const ts = new Date(tsMatch![1]!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
  });

  it('caps to MAX_ENTRIES', () => {
    for (let i = 0; i < 600; i++) {
      appendLog(repo, {
        action: 'update',
        target: `file-${i}`,
        message: `entry ${i}`,
        timestamp: `2026-04-27T10:00:${String(i).padStart(2, '0')}Z`,
      });
    }
    const content = readFileSync(wikiLogFile(repo), 'utf-8');
    // 总共应只有 500 条
    const matches = content.match(/^## /gm) ?? [];
    expect(matches.length).toBe(500);
    expect(content).toContain('truncated');
  });

  it('readLog returns full file content', () => {
    appendLog(repo, {
      action: 'init',
      target: 'wiki/',
      message: 'first',
      timestamp: '2026-04-27T10:00:00Z',
    });
    const content = readLog(repo);
    expect(content).toContain('first');
    expect(content).toContain('# Wiki Operation Log');
  });
});
