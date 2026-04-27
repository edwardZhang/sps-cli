/**
 * @module        core/wiki/manifest
 * @description   Wiki 增量索引：源文件 hash 跟踪表（.manifest.json）
 *
 * @layer         core
 *
 * 作用：每次 `sps wiki update` 时比 hash，决定哪些 source 需要重新 ingest——
 *      避免每次都让 Worker 重读全部源文件。
 *
 * 设计要点（doc-28 §5 + §8）：
 *   - 文件位置：`<repo>/wiki/.manifest.json`（gitignored）
 *   - 每台机一份；不同 dev 的 manifest 不互相覆盖
 *   - 源路径用相对 repo 根目录（"src/X.ts" / ".raw/pdfs/y.pdf"）
 *   - hash 用 sha256，文件级原子单位（不切分到行/段）
 *   - 跟 zod schema 校验过——损坏的 manifest 当作 EMPTY 重建，不阻塞 update
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import {
  EMPTY_MANIFEST,
  type Manifest,
  type ManifestEntry,
  ManifestSchema,
  type SourceDiff,
} from './types.js';

// ─── 文件 I/O ─────────────────────────────────────────────────────

/**
 * 读 manifest 文件。
 * 文件不存在 / 损坏 / schema 不合法 → 返 EMPTY_MANIFEST（同时调 onWarn 报告）。
 *
 * 不 throw —— manifest 只是性能优化，损坏时退化为全量重 ingest 即可。
 */
export function readManifest(
  manifestPath: string,
  onWarn?: (msg: string) => void,
): Manifest {
  if (!existsSync(manifestPath)) return EMPTY_MANIFEST;
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf-8');
  } catch (err) {
    onWarn?.(`manifest read failed (${manifestPath}): ${errMsg(err)}`);
    return EMPTY_MANIFEST;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    onWarn?.(`manifest JSON parse failed (${manifestPath}): ${errMsg(err)} — treating as empty`);
    return EMPTY_MANIFEST;
  }
  const result = ManifestSchema.safeParse(parsed);
  if (!result.success) {
    onWarn?.(
      `manifest schema invalid (${manifestPath}): ${result.error.issues
        .map((i) => `${i.path.join('.')}:${i.message}`)
        .join('; ')} — treating as empty`,
    );
    return EMPTY_MANIFEST;
  }
  return result.data;
}

/**
 * 写 manifest 文件。原子替换（temp + rename），避免读到半截。
 */
export function writeManifest(manifestPath: string, manifest: Manifest): void {
  const validated = ManifestSchema.parse(manifest); // 写入前最后一道校验
  const text = JSON.stringify(validated, null, 2) + '\n';
  // node:fs writeFileSync 已经是原子的（POSIX rename semantics）—— 但为防止 partial
  // write 在 crash 场景留半截文件，用 .tmp + rename。
  const tmpPath = manifestPath + '.tmp';
  writeFileSync(tmpPath, text, { encoding: 'utf-8', mode: 0o644 });
  renameSync(tmpPath, manifestPath);
}

// ─── Hash 计算 ────────────────────────────────────────────────────

/**
 * 计算文件 sha256 hex。文件不存在或读失败 → throw（调用方决定是否兜底）。
 *
 * 大文件友好：用 buffer reads 而不是一次性读到内存——但 wiki 源文件
 * 一般 < 1 MB，readFileSync 已经够。如果将来要 ingest 大 PDF，再换 streaming。
 */
export function hashFile(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 同上但是宽松：失败时返 null（用于 lint / 增量扫描）。
 */
export function tryHashFile(filePath: string): string | null {
  try {
    return hashFile(filePath);
  } catch {
    return null;
  }
}

// ─── Diff: 已知 sources vs current files ─────────────────────────

export interface DiffInputSource {
  /** Path relative to repo root (e.g. "src/X.ts" 或 ".raw/y.pdf") */
  readonly path: string;
  /** Pre-computed hash (caller responsibility) */
  readonly hash: string;
}

/**
 * 比较"当前发现的源 + 它们的 hash"和 manifest 里记录的状态。
 *
 * - added：current 里有，manifest 里没
 * - changed：两边都有但 hash 不同
 * - removed：manifest 里有，current 里没（源被删了）
 * - unchanged：两边都有且 hash 相同
 *
 * 纯函数，无 I/O。
 */
export function diffSources(
  current: readonly DiffInputSource[],
  manifest: Manifest,
): SourceDiff {
  const currentMap = new Map(current.map((s) => [s.path, s.hash]));
  const manifestPaths = new Set(Object.keys(manifest.sources));

  const added: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const [path, hash] of currentMap) {
    const entry = manifest.sources[path];
    if (!entry) {
      added.push(path);
    } else if (entry.sha256 !== hash) {
      changed.push(path);
    } else {
      unchanged.push(path);
    }
  }

  const removed: string[] = [];
  for (const path of manifestPaths) {
    if (!currentMap.has(path)) removed.push(path);
  }

  return {
    added: added.sort(),
    changed: changed.sort(),
    removed: removed.sort(),
    unchanged: unchanged.sort(),
  };
}

// ─── 更新 manifest（in-place pure，返回新 manifest） ───────────────

/**
 * 标记一个 source 已 ingest 过。返回新 manifest（不修改原对象）。
 *
 * 用途：每次 ingest 一个 source 后调一次。如果 path 已存在，覆盖；否则添加。
 */
export function recordIngest(
  manifest: Manifest,
  path: string,
  entry: ManifestEntry,
): Manifest {
  const sources = { ...manifest.sources, [path]: entry };
  return {
    ...manifest,
    updated_at: new Date().toISOString(),
    sources,
  };
}

/**
 * 删除一个 source 的记录（被删除时用）。返回新 manifest。
 */
export function removeFromManifest(manifest: Manifest, path: string): Manifest {
  if (!(path in manifest.sources)) return manifest;
  const { [path]: _removed, ...rest } = manifest.sources;
  void _removed;
  return {
    ...manifest,
    updated_at: new Date().toISOString(),
    sources: rest,
  };
}

/**
 * 检查 source 文件 mtime > 它所派生的 page 中任何一个的 updated 字段。
 * 用于 lint：标 stale page。
 *
 * 这是 best-effort —— 跨文件系统 mtime 精度不一致（macOS HFS+ 1s，
 * Linux ext4 ns）。差几秒不算 stale。
 */
export function isSourceStale(sourcePath: string, pageMtime: Date | null): boolean {
  if (!pageMtime) return false;
  try {
    const sourceMtime = statSync(sourcePath).mtime;
    // 超过 60s 才算改过——避免精度问题误报
    return sourceMtime.getTime() - pageMtime.getTime() > 60_000;
  } catch {
    return false; // source 不存在 = 不算 stale，归 lint 别的检查
  }
}

// ─── helpers ──────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
