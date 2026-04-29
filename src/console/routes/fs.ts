/**
 * @module        console/routes/fs
 * @description   本机文件系统：目录浏览 + 附件上传 + 附件预览
 *
 * @layer         console (delivery)
 *
 * 浏览器 native picker 拿不到绝对路径（同源限制），console-server 自己暴露
 * 这套端点。Console 仅监听 127.0.0.1，调用方就是本机用户自己。
 *
 * 端点：
 *   GET  /browse?path=...        列子目录（v0.51.5）
 *   POST /upload                 上传附件（v0.51.8，multipart）
 *   GET  /file?path=...&sessionId=...   读单个文件（用于附件预览，v0.51.8）
 *
 * 安全：
 *   - 只读：listing / 读单文件 — 没有写文件接口（仅 upload 写到固定位置）
 *   - resolve 后 absolute path（避免 .. 越界）
 *   - upload 落在 ~/.coral/chat-attachments/<sessionId>/，文件名 sanitize
 *   - file 端点要求 path 在 chat-attachments 下 OR 在某 session 的 attachments
 *     列表中（即用户主动 attach 过）
 *   - 50 MB 上限（前端预校验，后端兜底）
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { Hono } from 'hono';
import { stream } from 'hono/streaming';
import { chatAttachmentsDir, chatAttachmentsDirFor, chatSessionsDir } from '../../shared/runtimePaths.js';

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
          detail: `${target} is a system directory; browsing is not allowed`,
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

  // ─── POST /upload — 附件上传 ────────────────────────────────────────
  //
  // multipart/form-data 字段：
  //   - sessionId: string (必)  —— 用于落到 ~/.coral/chat-attachments/<sid>/
  //   - file: File (必)         —— 单文件
  //
  // 成功返 { path, name, size, mime }
  // 50 MB 上限（前端 + 后端双校验）
  //
  app.post('/upload', async (c) => {
    let form: FormData;
    try {
      form = await c.req.formData();
    } catch (err) {
      return c.json(
        { type: 'validation', title: 'invalid multipart', status: 400, detail: err instanceof Error ? err.message : String(err) },
        400,
      );
    }
    const sessionId = String(form.get('sessionId') ?? '').trim();
    const file = form.get('file');
    if (!sessionId || !/^[a-zA-Z0-9-]+$/.test(sessionId)) {
      return c.json({ type: 'validation', title: 'sessionId required', status: 422 }, 422);
    }
    if (!(file instanceof File)) {
      return c.json({ type: 'validation', title: 'file field required', status: 422 }, 422);
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      return c.json(
        {
          type: 'validation',
          title: 'file too large',
          status: 413,
          detail: `Per-file limit is ${UPLOAD_MAX_BYTES / 1024 / 1024} MB; current ${(file.size / 1024 / 1024).toFixed(2)} MB`,
        },
        413,
      );
    }

    // 落盘
    const dir = chatAttachmentsDirFor(sessionId);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const stamped = `${Date.now()}-${sanitizeFilename(file.name || 'upload.bin')}`;
    const dest = resolve(dir, stamped);
    try {
      const buf = Buffer.from(await file.arrayBuffer());
      writeFileSync(dest, buf, { mode: 0o644 });
    } catch (err) {
      return c.json(
        { type: 'internal', title: 'write failed', status: 500, detail: err instanceof Error ? err.message : String(err) },
        500,
      );
    }

    return c.json(
      {
        path: dest,
        name: file.name,
        size: file.size,
        mime: file.type || guessMime(file.name),
      },
      201,
    );
  });

  // ─── GET /file — 读取附件内容（用于预览） ───────────────────────────
  //
  // Query：
  //   - path:  绝对路径
  //   - sessionId:  关联 session id（用于校验路径是该 session 已挂载的附件）
  //
  // 路径校验：path 必须满足两条之一
  //   1. 在 ~/.coral/chat-attachments/<sessionId>/ 下（用户上传的）
  //   2. 在指定 session JSON 的 messages[].attachments 列表中（用户从本地挑的）
  //
  app.get('/file', async (c) => {
    const path = c.req.query('path');
    const sessionId = c.req.query('sessionId');
    if (!path || !isAbsolute(path)) {
      return c.json({ type: 'validation', title: 'absolute path required', status: 422 }, 422);
    }
    if (!sessionId || !/^[a-zA-Z0-9-]+$/.test(sessionId)) {
      return c.json({ type: 'validation', title: 'sessionId required', status: 422 }, 422);
    }
    if (!isAttachmentAuthorized(path, sessionId)) {
      return c.json(
        { type: 'forbidden', title: 'path not authorized for this session', status: 403 },
        403,
      );
    }
    if (!existsSync(path)) {
      return c.json({ type: 'not-found', title: 'file not found', status: 404 }, 404);
    }
    let st;
    try {
      st = statSync(path);
    } catch {
      return c.json({ type: 'forbidden', title: 'cannot stat file', status: 403 }, 403);
    }
    if (!st.isFile()) {
      return c.json({ type: 'validation', title: 'not a file', status: 422 }, 422);
    }

    const mime = guessMime(path);
    c.header('Content-Type', mime);
    c.header('Content-Length', String(st.size));
    c.header('Content-Disposition', `inline; filename="${encodeURIComponent(basename(path))}"`);
    // 大文件流式发，避免把 50 MB 一次性塞进 buffer
    return stream(c, async (s) => {
      const reader = createReadStream(path);
      for await (const chunk of reader) {
        await s.write(chunk as Uint8Array);
      }
    });
  });

  return app;
}

// ─── 50 MB 上限 ───────────────────────────────────────────────────

const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

/**
 * 文件名清洗：
 *   - 仅保留 basename（去掉任何路径分量）
 *   - 替换非安全字符为 `_`
 *   - 长度截断到 100
 */
function sanitizeFilename(name: string): string {
  const bare = basename(name);
  const cleaned = bare.replace(/[^\w.\-+()一-鿿]/g, '_');
  return cleaned.slice(0, 100) || 'unnamed';
}

/** 简易 MIME 推断（够 chat preview 用）。Hono / 浏览器都接受。 */
function guessMime(filename: string): string {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.pdf':
      return 'application/pdf';
    case '.txt':
    case '.md':
    case '.log':
      return 'text/plain; charset=utf-8';
    case '.json':
      return 'application/json; charset=utf-8';
    case '.html':
      return 'text/html; charset=utf-8';
    case '.csv':
      return 'text/csv; charset=utf-8';
    case '.mp4':
      return 'video/mp4';
    case '.webm':
      return 'video/webm';
    default:
      return 'application/octet-stream';
  }
}

/**
 * 校验 path 是否被 sessionId 授权访问。
 *
 * 通过两条任一即可：
 *   1. path 在 ~/.coral/chat-attachments/<sessionId>/ 下（用户主动上传）
 *   2. path 出现在该 session JSON 的 messages[].attachments 中（用户主动挑了本地文件）
 *
 * 这层校验在本地 console（127.0.0.1）下是防护性设计，避免 console UI 被诱导
 * 读任意 readable file。
 */
function isAttachmentAuthorized(path: string, sessionId: string): boolean {
  // case 1: 上传到 chat-attachments
  const allowedRoot = chatAttachmentsDirFor(sessionId);
  if (path === allowedRoot || path.startsWith(allowedRoot + sep) || path.startsWith(allowedRoot + '/')) {
    return true;
  }
  // case 2: 在 session JSON 的 attachments 列表里
  const sessionJson = resolve(chatSessionsDir(), `${sessionId}.json`);
  if (!existsSync(sessionJson)) return false;
  try {
    const raw = readFileSync(sessionJson, 'utf-8');
    const parsed = JSON.parse(raw) as { messages?: Array<{ attachments?: string[] }> };
    for (const m of parsed.messages ?? []) {
      if (m.attachments?.includes(path)) return true;
    }
  } catch {
    /* 损坏 session JSON 当未授权 */
  }
  return false;
}

// ── 注：chatAttachmentsDir 在 cleanup chat session 时会被一起删（chat.ts delete 路由处理）
void chatAttachmentsDir;

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
