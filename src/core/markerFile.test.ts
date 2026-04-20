/**
 * @module        markerFile.test
 * @description   marker 文件读/写/合并工具单元测试
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getMarkerPath,
  getMarkerPathFromStateFile,
  patchCurrentCardFile,
  readCurrentCardMarker,
  writeCurrentCardFile,
} from './markerFile.js';

describe('markerFile', () => {
  const originalHome = process.env.HOME;
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'marker-test-'));
    mkdirSync(join(tmpHome, '.coral', 'projects', 'p', 'runtime'), { recursive: true });
    process.env.HOME = tmpHome;
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
  });

  describe('writeCurrentCardFile', () => {
    it('writes cardId/stage/dispatchedAt atomically', () => {
      const path = getMarkerPath('p', 'worker-1');
      writeCurrentCardFile(path, '42', 'develop');
      expect(existsSync(path)).toBe(true);
      const contents = JSON.parse(readFileSync(path, 'utf-8'));
      expect(contents.cardId).toBe('42');
      expect(contents.stage).toBe('develop');
      expect(contents.dispatchedAt).toBeDefined();
    });

    it('includes sessionId and pid when passed in extra', () => {
      const path = getMarkerPath('p', 'worker-1');
      writeCurrentCardFile(path, '42', 'develop', undefined, { sessionId: 'sess-1', pid: 1234 });
      const contents = JSON.parse(readFileSync(path, 'utf-8'));
      expect(contents.sessionId).toBe('sess-1');
      expect(contents.pid).toBe(1234);
    });

    it('overwrites existing marker on subsequent call', () => {
      const path = getMarkerPath('p', 'worker-1');
      writeCurrentCardFile(path, '1', 'develop');
      writeCurrentCardFile(path, '2', 'develop');
      const contents = JSON.parse(readFileSync(path, 'utf-8'));
      expect(contents.cardId).toBe('2');
    });
  });

  describe('patchCurrentCardFile', () => {
    it('preserves existing fields and adds sessionId + pid', () => {
      const path = getMarkerPath('p', 'worker-1');
      writeCurrentCardFile(path, '42', 'develop');
      const originalAt = JSON.parse(readFileSync(path, 'utf-8')).dispatchedAt;

      patchCurrentCardFile(path, { sessionId: 'sess-abc', pid: 99999 });

      const contents = JSON.parse(readFileSync(path, 'utf-8'));
      expect(contents.cardId).toBe('42');          // unchanged
      expect(contents.stage).toBe('develop');       // unchanged
      expect(contents.dispatchedAt).toBe(originalAt); // NOT reset — ACK timeout clock preserved
      expect(contents.sessionId).toBe('sess-abc');  // new
      expect(contents.pid).toBe(99999);             // new
    });

    it('is a no-op with onError callback when marker file missing', () => {
      const path = getMarkerPath('p', 'worker-ghost');
      let errorCaught: unknown = null;
      patchCurrentCardFile(path, { sessionId: 'x' }, (err) => { errorCaught = err; });
      expect(errorCaught).toBeTruthy();
      expect(existsSync(path)).toBe(false);  // did not create
    });
  });

  describe('readCurrentCardMarker', () => {
    it('returns null when file missing', () => {
      expect(readCurrentCardMarker('p', 'worker-ghost')).toBeNull();
    });

    it('reads cardId/stage/dispatchedAt', () => {
      const path = getMarkerPath('p', 'worker-1');
      writeCurrentCardFile(path, '42', 'review');
      const marker = readCurrentCardMarker('p', 'worker-1');
      expect(marker?.cardId).toBe('42');
      expect(marker?.stage).toBe('review');
    });

    it('reads sessionId/pid when present (new format)', () => {
      const path = getMarkerPath('p', 'worker-1');
      writeFileSync(path, JSON.stringify({
        cardId: '7', stage: 'develop', dispatchedAt: '2026-04-20T00:00:00Z',
        sessionId: 'sess-x', pid: 42,
      }));
      const marker = readCurrentCardMarker('p', 'worker-1');
      expect(marker?.sessionId).toBe('sess-x');
      expect(marker?.pid).toBe(42);
    });

    it('is backward-compatible with old markers (no sessionId/pid)', () => {
      const path = getMarkerPath('p', 'worker-1');
      writeFileSync(path, JSON.stringify({
        cardId: '7', stage: 'develop', dispatchedAt: '2026-04-20T00:00:00Z',
      }));
      const marker = readCurrentCardMarker('p', 'worker-1');
      expect(marker?.cardId).toBe('7');
      expect(marker?.sessionId).toBeUndefined();
      expect(marker?.pid).toBeUndefined();
    });
  });

  describe('getMarkerPathFromStateFile', () => {
    it('builds path in the same directory as state.json', () => {
      const stateFile = '/tmp/sps/runtime/state.json';
      const markerPath = getMarkerPathFromStateFile(stateFile, 'worker-1');
      expect(markerPath).toBe(resolve('/tmp/sps/runtime/worker-worker-1-current.json'));
    });
  });
});
