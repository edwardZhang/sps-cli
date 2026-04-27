/**
 * @module        shared/wikiPaths
 * @description   Wiki vault 文件系统路径单一来源
 *
 * @layer         shared
 *
 * Wiki 实际位置：`<repo>/wiki/`（per-project，进 git 团队共享）。
 * 这里所有 helper 都是相对 repo 根目录的纯函数——不依赖 SPS instance state，
 * 不依赖 ProjectContext，方便测试。
 *
 * 命名规范：见 doc-28 §4 目录结构。
 *   - dot-prefix 文件（.hot.md / .log.md / .manifest.json）→ gitignored 的 per-instance 飘移
 *   - dot-prefix 目录（.raw/）→ Obsidian 视图隐藏，但进 git 共享
 *   - underscore-prefix（_attachments）→ Obsidian 约定的"非 wiki 内容"
 */
import { resolve } from 'node:path';

export type WikiPageType = 'module' | 'concept' | 'decision' | 'lesson' | 'source';

/** `<repo>/wiki/` —— Wiki vault 根目录。Obsidian Open folder 指向这里。 */
export function wikiDir(repoDir: string): string {
  return resolve(repoDir, 'wiki');
}

/** `<repo>/wiki/WIKI.md` —— schema + sources 配置 */
export function wikiMetaFile(repoDir: string): string {
  return resolve(wikiDir(repoDir), 'WIKI.md');
}

/** `<repo>/wiki/index.md` —— 全部 page 的 catalog */
export function wikiIndexFile(repoDir: string): string {
  return resolve(wikiDir(repoDir), 'index.md');
}

/** `<repo>/wiki/overview.md` —— 项目执行摘要 */
export function wikiOverviewFile(repoDir: string): string {
  return resolve(wikiDir(repoDir), 'overview.md');
}

/** `<repo>/wiki/.hot.md` —— ~500 字最近上下文（gitignored） */
export function wikiHotFile(repoDir: string): string {
  return resolve(wikiDir(repoDir), '.hot.md');
}

/** `<repo>/wiki/.log.md` —— 操作时间序列（gitignored） */
export function wikiLogFile(repoDir: string): string {
  return resolve(wikiDir(repoDir), '.log.md');
}

/** `<repo>/wiki/.manifest.json` —— 源 hash 跟踪表（gitignored） */
export function wikiManifestFile(repoDir: string): string {
  return resolve(wikiDir(repoDir), '.manifest.json');
}

/** `<repo>/wiki/.raw/` —— 用户外部添加的源材料（committed by default） */
export function wikiRawDir(repoDir: string): string {
  return resolve(wikiDir(repoDir), '.raw');
}

/** `<repo>/wiki/_attachments/` —— 嵌入图片（committed） */
export function wikiAttachmentsDir(repoDir: string): string {
  return resolve(wikiDir(repoDir), '_attachments');
}

/**
 * `<repo>/wiki/<type>s/` —— 特定类型 page 目录。
 * 名约定：复数后缀（modules/, concepts/, decisions/, lessons/, sources/）。
 */
export function wikiPageDir(repoDir: string, type: WikiPageType): string {
  return resolve(wikiDir(repoDir), `${type}s`);
}

/** `<repo>/wiki/<type>s/<title>.md` —— 单页文件路径 */
export function wikiPageFile(
  repoDir: string,
  type: WikiPageType,
  title: string,
): string {
  return resolve(wikiPageDir(repoDir, type), `${title}.md`);
}

/** Page id 格式：`<type>s/<title>`（不含 .md）。用作 frontmatter related / sources 字段 */
export function wikiPageId(type: WikiPageType, title: string): string {
  return `${type}s/${title}`;
}

/**
 * 从绝对路径反推 (type, title) —— 用于 listing 时把文件名解析回 page 标识。
 * 只接受 wikiDir 子路径，否则返 null。
 */
export function parseWikiPageId(
  repoDir: string,
  filePath: string,
): { type: WikiPageType; title: string; pageId: string } | null {
  const root = wikiDir(repoDir);
  const PAGE_TYPES: WikiPageType[] = ['module', 'concept', 'decision', 'lesson', 'source'];
  for (const t of PAGE_TYPES) {
    const dir = wikiPageDir(repoDir, t);
    if (filePath.startsWith(dir + '/') && filePath.endsWith('.md')) {
      const rel = filePath.slice(dir.length + 1, -3);
      // 不允许子目录嵌套——title 不含路径分隔符
      if (rel.includes('/')) return null;
      return { type: t, title: rel, pageId: wikiPageId(t, rel) };
    }
  }
  // 不在已知 type dir 下；可能是 index/overview/hot/log 等顶层文件
  void root;
  return null;
}
