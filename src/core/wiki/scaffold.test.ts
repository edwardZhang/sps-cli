/**
 * @module        scaffold.test
 * @description   `initWiki` 脚手架 + .gitignore 维护测试
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wikiDir, wikiHotFile, wikiIndexFile, wikiMetaFile } from '../../shared/wikiPaths.js';
import { ensureGitignoreEntries, initWiki } from './scaffold.js';

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'wiki-scaffold-test-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('initWiki', () => {
  it('creates wiki/ root and 5 type subdirs', () => {
    initWiki(repo, { projectName: 'demo' });
    expect(existsSync(wikiDir(repo))).toBe(true);
    for (const t of ['modules', 'concepts', 'decisions', 'lessons', 'sources']) {
      expect(existsSync(resolve(wikiDir(repo), t))).toBe(true);
    }
  });

  it('creates .raw and _attachments subdirs', () => {
    initWiki(repo, { projectName: 'demo' });
    expect(existsSync(resolve(wikiDir(repo), '.raw'))).toBe(true);
    expect(existsSync(resolve(wikiDir(repo), '_attachments'))).toBe(true);
  });

  it('writes WIKI.md / index.md / overview.md / .hot.md templates', () => {
    initWiki(repo, { projectName: 'demo' });
    expect(existsSync(wikiMetaFile(repo))).toBe(true);
    expect(existsSync(wikiIndexFile(repo))).toBe(true);
    expect(existsSync(resolve(wikiDir(repo), 'overview.md'))).toBe(true);
    expect(existsSync(wikiHotFile(repo))).toBe(true);
  });

  it('uses projectName in WIKI.md title', () => {
    initWiki(repo, { projectName: 'my-cool-project' });
    const content = readFileSync(wikiMetaFile(repo), 'utf-8');
    expect(content).toContain('my-cool-project Wiki');
  });

  it('uses provided today value for created/updated', () => {
    initWiki(repo, { projectName: 'demo', today: '2026-04-27' });
    const content = readFileSync(wikiMetaFile(repo), 'utf-8');
    expect(content).toContain('created: 2026-04-27');
    expect(content).toContain('updated: 2026-04-27');
  });

  it('is idempotent — second call preserves user content', () => {
    initWiki(repo, { projectName: 'demo' });
    const customContent = '---\ntype: meta\ntitle: hand-edited\nversion: 1\ncreated: 2020-01-01\nupdated: 2020-01-01\n---\nmy custom wiki\n';
    writeFileSync(wikiMetaFile(repo), customContent);
    const report = initWiki(repo, { projectName: 'demo' });
    const content = readFileSync(wikiMetaFile(repo), 'utf-8');
    expect(content).toContain('my custom wiki');
    expect(report.filesSkipped).toContain(wikiMetaFile(repo));
  });

  it('reports created dirs and written files', () => {
    const report = initWiki(repo, { projectName: 'demo' });
    expect(report.created.length).toBeGreaterThan(0);
    expect(report.filesWritten.length).toBe(4); // WIKI.md, index.md, overview.md, .hot.md
  });

  it('updates .gitignore when missing', () => {
    initWiki(repo, { projectName: 'demo' });
    const gitignorePath = resolve(repo, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(true);
    const content = readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain('wiki/.hot.md');
    expect(content).toContain('wiki/.log.md');
    expect(content).toContain('wiki/.manifest.json');
  });

  it('skipGitignore=true leaves .gitignore alone', () => {
    initWiki(repo, { projectName: 'demo', skipGitignore: true });
    expect(existsSync(resolve(repo, '.gitignore'))).toBe(false);
  });
});

describe('ensureGitignoreEntries', () => {
  it('creates .gitignore when missing', () => {
    const updated = ensureGitignoreEntries(repo);
    expect(updated).toBe(true);
    const path = resolve(repo, '.gitignore');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('wiki/.hot.md');
  });

  it('appends only missing lines to existing .gitignore', () => {
    const path = resolve(repo, '.gitignore');
    writeFileSync(path, 'node_modules/\nwiki/.hot.md\n');
    const updated = ensureGitignoreEntries(repo);
    expect(updated).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('wiki/.hot.md');
    expect(content).toContain('wiki/.log.md');
    expect(content).toContain('wiki/.manifest.json');
    // Doesn't duplicate
    const hotCount = content.match(/wiki\/\.hot\.md/g)?.length ?? 0;
    expect(hotCount).toBe(1);
  });

  it('returns false when already up to date', () => {
    const path = resolve(repo, '.gitignore');
    writeFileSync(
      path,
      'wiki/.hot.md\nwiki/.log.md\nwiki/.manifest.json\n',
    );
    const updated = ensureGitignoreEntries(repo);
    expect(updated).toBe(false);
  });
});
