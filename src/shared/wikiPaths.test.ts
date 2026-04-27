/**
 * @module        wikiPaths.test
 * @description   Wiki 文件系统路径 helper 测试
 */
import { describe, expect, it } from 'vitest';
import {
  parseWikiPageId,
  wikiAttachmentsDir,
  wikiDir,
  wikiHotFile,
  wikiIndexFile,
  wikiLogFile,
  wikiManifestFile,
  wikiMetaFile,
  wikiOverviewFile,
  wikiPageDir,
  wikiPageFile,
  wikiPageId,
  wikiRawDir,
} from './wikiPaths.js';

describe('wikiPaths', () => {
  const REPO = '/Users/foo/proj';

  it('wikiDir returns <repo>/wiki', () => {
    expect(wikiDir(REPO)).toBe('/Users/foo/proj/wiki');
  });

  it('top-level files', () => {
    expect(wikiMetaFile(REPO)).toBe('/Users/foo/proj/wiki/WIKI.md');
    expect(wikiIndexFile(REPO)).toBe('/Users/foo/proj/wiki/index.md');
    expect(wikiOverviewFile(REPO)).toBe('/Users/foo/proj/wiki/overview.md');
    expect(wikiHotFile(REPO)).toBe('/Users/foo/proj/wiki/.hot.md');
    expect(wikiLogFile(REPO)).toBe('/Users/foo/proj/wiki/.log.md');
    expect(wikiManifestFile(REPO)).toBe('/Users/foo/proj/wiki/.manifest.json');
  });

  it('hidden directories', () => {
    expect(wikiRawDir(REPO)).toBe('/Users/foo/proj/wiki/.raw');
    expect(wikiAttachmentsDir(REPO)).toBe('/Users/foo/proj/wiki/_attachments');
  });

  it('page dir uses plural type suffix', () => {
    expect(wikiPageDir(REPO, 'module')).toBe('/Users/foo/proj/wiki/modules');
    expect(wikiPageDir(REPO, 'concept')).toBe('/Users/foo/proj/wiki/concepts');
    expect(wikiPageDir(REPO, 'decision')).toBe('/Users/foo/proj/wiki/decisions');
    expect(wikiPageDir(REPO, 'lesson')).toBe('/Users/foo/proj/wiki/lessons');
    expect(wikiPageDir(REPO, 'source')).toBe('/Users/foo/proj/wiki/sources');
  });

  it('page file path uses title with spaces preserved', () => {
    expect(wikiPageFile(REPO, 'module', 'PipelineService')).toBe(
      '/Users/foo/proj/wiki/modules/PipelineService.md',
    );
    expect(wikiPageFile(REPO, 'lesson', 'Stop Hook Race')).toBe(
      '/Users/foo/proj/wiki/lessons/Stop Hook Race.md',
    );
  });

  it('pageId is plural type + slash + title', () => {
    expect(wikiPageId('module', 'PipelineService')).toBe('modules/PipelineService');
    expect(wikiPageId('lesson', 'Stop Hook Race')).toBe('lessons/Stop Hook Race');
  });

  describe('parseWikiPageId (round-trip)', () => {
    it('parses module file path', () => {
      const path = '/Users/foo/proj/wiki/modules/PipelineService.md';
      const result = parseWikiPageId(REPO, path);
      expect(result).toEqual({
        type: 'module',
        title: 'PipelineService',
        pageId: 'modules/PipelineService',
      });
    });

    it('parses title with spaces', () => {
      const path = '/Users/foo/proj/wiki/lessons/Stop Hook Race.md';
      const result = parseWikiPageId(REPO, path);
      expect(result?.title).toBe('Stop Hook Race');
      expect(result?.pageId).toBe('lessons/Stop Hook Race');
    });

    it('returns null for non-page files (index.md, hot.md)', () => {
      expect(parseWikiPageId(REPO, '/Users/foo/proj/wiki/index.md')).toBeNull();
      expect(parseWikiPageId(REPO, '/Users/foo/proj/wiki/.hot.md')).toBeNull();
    });

    it('returns null for nested subdirs (titles cannot contain /)', () => {
      const path = '/Users/foo/proj/wiki/modules/sub/Foo.md';
      expect(parseWikiPageId(REPO, path)).toBeNull();
    });

    it('returns null for non-md files', () => {
      const path = '/Users/foo/proj/wiki/modules/PipelineService.txt';
      expect(parseWikiPageId(REPO, path)).toBeNull();
    });

    it('returns null for paths outside the wiki dir', () => {
      expect(parseWikiPageId(REPO, '/Users/foo/proj/src/X.ts')).toBeNull();
    });
  });
});
