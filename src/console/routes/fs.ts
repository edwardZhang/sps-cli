/**
 * @module        console/routes/fs
 * @description   本机文件系统目录浏览（仅供 chat cwd 选择器使用）
 *
 * @layer         console (delivery)
 *
 * 浏览器 native picker 拿不到绝对路径（安全限制），所以 console-server 自己
 * 暴露一个只读的目录浏览端点。Console 仅监听 127.0.0.1，调用方就是本机用户
 * 自己。
 *
 * 安全：
 *   - 只读：listing only，不暴露文件内容
 *   - resolve 后 absolute path（避免 .. 越界）
 *   - 跳过失败 stat 的条目（broken symlink / 无权限）
 *   - 黑名单已知陷阱目录（/proc / /sys 等会触发卡顿或意外副作用）
 *   - 默认起点：用户 HOME
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import { Hono } from 'hono';

interface FsEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

interface FsBrowseResponse {
  readonly path: string;
  readonly parent: string | null;
  readonly entries: readonly FsEntry[];
  /** Convenience: home directory absolute path（前端 UI 显示"回到 home"按钮用） */
  readonly home: string;
}

// 已知会捅马蜂窝的目录 — 避免列出
const SKIP_ABSOLUTE = new Set(['/proc', '/sys', '/dev']);

export function createFsRoute(): Hono {
  const app = new Hono();

  app.get('/browse', (c) => {
    const requested = c.req.query('path');
    const target = pickTarget(requested);

    if (!existsSync(target)) {
      return c.json(
        { type: 'not-found', title: 'directory not found', status: 404, detail: target },
        404,
      );
    }

    let st;
    try {
      st = statSync(target);
    } catch (err) {
      return c.json(
        {
          type: 'internal',
          title: 'stat failed',
          status: 500,
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
    if (!st.isDirectory()) {
      return c.json(
        { type: 'validation', title: 'not a directory', status: 422, detail: target },
        422,
      );
    }

    if (SKIP_ABSOLUTE.has(target)) {
      return c.json(
        {
          type: 'validation',
          title: 'directory not browsable',
          status: 422,
          detail: `${target} 是系统目录，不允许浏览`,
        },
        422,
      );
    }

    let names: string[];
    try {
      names = readdirSync(target);
    } catch (err) {
      return c.json(
        {
          type: 'internal',
          title: 'read directory failed',
          status: 403,
          detail: err instanceof Error ? err.message : String(err),
        },
        403,
      );
    }

    const entries: FsEntry[] = [];
    for (const name of names) {
      // skip dotfiles by default — wiki ".raw" 等也是 dot-prefix，但用户要找
      // 自己的项目目录基本都是非 dot；按需将来加 ?showHidden=1 query
      if (name.startsWith('.')) continue;
      const full = resolve(target, name);
      try {
        const entryStat = statSync(full);
        entries.push({ name, isDirectory: entryStat.isDirectory() });
      } catch {
        // 跳过无权限 / broken symlink 的条目
        continue;
      }
    }
    // 目录优先 + 字母序
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const parent = computeParent(target);

    const body: FsBrowseResponse = {
      path: target,
      parent,
      entries,
      home: homedir(),
    };
    return c.json(body);
  });

  return app;
}

/**
 * 决定要列哪个目录：query 参数优先（必须绝对路径），否则 home。
 * `..` / 相对路径都被 resolve() 归一为绝对路径再处理（避免越界）。
 */
function pickTarget(requested: string | undefined): string {
  if (!requested || requested.trim() === '') return homedir();
  const trimmed = requested.trim();
  if (!isAbsolute(trimmed)) return homedir();
  // resolve 会把 .. 折叠掉，等价于 normalize
  return resolve(trimmed);
}

/**
 * 父目录 — 根目录返 null（根的 parent 不能再往上）。
 */
function computeParent(target: string): string | null {
  const parent = resolve(target, '..');
  if (parent === target) return null;
  // 再次防御：parent 是不是 root
  if (parent === sep || /^[A-Za-z]:[\\/]$/.test(parent)) {
    return parent === target ? null : parent;
  }
  return parent;
}
