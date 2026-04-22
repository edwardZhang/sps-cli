/**
 * @module        console-server/routes/system
 * @description   系统信息：版本、运行时、env（脱敏）、doctor 聚合
 */
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const HOME = process.env.HOME || '/home/coral';
const ENV_PATH = resolve(HOME, '.coral', 'env');

function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 6) return '****';
  return value.slice(0, 4) + '****';
}

const SECRET_KEY_PATTERNS = [
  /_TOKEN$/,
  /_KEY$/,
  /_SECRET$/,
  /_PASSWORD$/,
  /_PASS$/,
  /^(ANTHROPIC|OPENAI|CLAUDE|PLANE|TRELLO|MATRIX)_/,
];

function isSecret(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((p) => p.test(key));
}

export function createSystemRoute(version: string, startedAt: Date): Hono {
  const app = new Hono();

  app.get('/info', (c) => {
    return c.json({
      version,
      nodeVersion: process.version,
      startedAt: startedAt.toISOString(),
      uptimeMs: Date.now() - startedAt.getTime(),
      platform: process.platform,
      pid: process.pid,
    });
  });

  app.get('/env', (c) => {
    if (!existsSync(ENV_PATH)) {
      return c.json({ path: ENV_PATH, exists: false, entries: [] });
    }
    const raw = readFileSync(ENV_PATH, 'utf-8');
    const entries: Array<{ key: string; value: string; masked: boolean }> = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const m = t.match(/^(?:export\s+)?([A-Z_][A-Z0-9_]*)=["']?(.*?)["']?\s*$/);
      if (!m) continue;
      const key = m[1] ?? '';
      const value = m[2] ?? '';
      const masked = isSecret(key);
      entries.push({ key, value: masked ? maskSecret(value) : value, masked });
    }
    return c.json({ path: ENV_PATH, exists: true, entries });
  });

  /**
   * GET /api/system/env/raw — Return raw ~/.coral/env content + SHA-256 etag.
   *   Values NOT masked (for editing). UI should warn user before showing.
   */
  app.get('/env/raw', (c) => {
    if (!existsSync(ENV_PATH)) {
      return c.json({ path: ENV_PATH, exists: false, content: '', etag: '' });
    }
    const content = readFileSync(ENV_PATH, 'utf-8');
    const etag = createHash('sha256').update(content).digest('hex').slice(0, 16);
    return c.json({ path: ENV_PATH, exists: true, content, etag });
  });

  /**
   * PATCH /api/system/env — Overwrite ~/.coral/env with body.content.
   *   Optimistic lock via body.etag (or If-Match). Keeps file mode 0600.
   *   Creates ~/.coral/ directory if missing.
   */
  app.patch('/env', async (c) => {
    const body = (await c.req.json().catch(() => null)) as
      | { content?: string; etag?: string }
      | null;
    if (!body || typeof body.content !== 'string') {
      return c.json({ type: 'validation', title: 'content required', status: 422 }, 422);
    }
    const ifMatch = body.etag ?? c.req.header('If-Match');
    const current = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf-8') : '';
    const currentEtag = existsSync(ENV_PATH)
      ? createHash('sha256').update(current).digest('hex').slice(0, 16)
      : '';
    // Create-new allowed without etag; update requires etag match
    if (existsSync(ENV_PATH)) {
      if (!ifMatch) {
        return c.json({ type: 'validation', title: 'etag required', status: 422 }, 422);
      }
      if (ifMatch !== currentEtag) {
        return c.json(
          {
            type: 'conflict',
            title: 'etag mismatch',
            status: 409,
            detail: 'env changed since you loaded it; reload and try again',
            currentEtag,
          },
          409,
        );
      }
    }
    try {
      mkdirSync(dirname(ENV_PATH), { recursive: true });
      writeFileSync(ENV_PATH, body.content);
      chmodSync(ENV_PATH, 0o600);
    } catch (err) {
      return c.json(
        {
          type: 'internal',
          title: 'write failed',
          status: 500,
          detail: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
    const newEtag = createHash('sha256').update(body.content).digest('hex').slice(0, 16);
    return c.json({ etag: newEtag });
  });

  /**
   * GET /api/system/latest-version — Fetch latest npm version for self-update check.
   *   Spawns `npm view @coralai/sps-cli version`. 10s timeout.
   */
  app.get('/latest-version', async (c) => {
    const result = await new Promise<{ ok: boolean; version?: string; error?: string }>((r) => {
      const child = spawn('npm', ['view', '@coralai/sps-cli', 'version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
        r({ ok: false, error: 'npm view timeout (10s)' });
      }, 10_000);
      child.stdout?.on('data', (d) => (stdout += d.toString()));
      child.stderr?.on('data', (d) => (stderr += d.toString()));
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) r({ ok: true, version: stdout.trim() });
        else r({ ok: false, error: stderr.trim() || `npm exit ${code}` });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        r({ ok: false, error: err.message });
      });
    });
    if (!result.ok) {
      return c.json(
        { type: 'internal', title: 'version check failed', status: 500, detail: result.error },
        500,
      );
    }
    return c.json({ current: version, latest: result.version, upToDate: version === result.version });
  });

  /**
   * POST /api/system/upgrade — Run `npm i -g @coralai/sps-cli@latest`.
   *   Safety: refuses if any project has a running pipeline (supervisor.pid alive).
   *   Streams stdout/stderr back as plain text (user must refresh to re-bind new version).
   */
  app.post('/upgrade', async (c) => {
    // Safety: check all projects for running pipelines
    const projectsDir = resolve(HOME, '.coral', 'projects');
    const runningProjects: string[] = [];
    if (existsSync(projectsDir)) {
      const names = readdirSync(projectsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      for (const name of names) {
        const pidFile = resolve(projectsDir, name, 'runtime', 'supervisor.pid');
        if (!existsSync(pidFile)) continue;
        try {
          const pid = Number.parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
          if (pid > 0) {
            try {
              process.kill(pid, 0);
              runningProjects.push(name);
            } catch { /* dead */ }
          }
        } catch { /* ignore */ }
      }
    }
    if (runningProjects.length > 0) {
      return c.json(
        {
          type: 'conflict',
          title: 'pipelines running',
          status: 409,
          detail: `Stop pipelines first: ${runningProjects.join(', ')}`,
          projects: runningProjects,
        },
        409,
      );
    }

    // Run npm i -g (streams output, returns combined log)
    const result = await new Promise<{ ok: boolean; output: string }>((r) => {
      const child = spawn('npm', ['i', '-g', '@coralai/sps-cli@latest'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
        r({ ok: false, output: output + '\n[timeout 120s]' });
      }, 120_000);
      child.stdout?.on('data', (d) => (output += d.toString()));
      child.stderr?.on('data', (d) => (output += d.toString()));
      child.on('close', (code) => {
        clearTimeout(timer);
        r({ ok: code === 0, output });
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        r({ ok: false, output: output + `\n[spawn error: ${err.message}]` });
      });
    });
    return c.json({ ok: result.ok, output: result.output });
  });

  app.get('/doctor/all', (c) => {
    const projectsDir = resolve(HOME, '.coral', 'projects');
    const report: Array<{ project: string; issues: string[]; ok: boolean }> = [];
    if (existsSync(projectsDir)) {
      const names = readdirSync(projectsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      for (const name of names) {
        const issues: string[] = [];
        const dir = resolve(projectsDir, name);
        if (!existsSync(resolve(dir, 'conf'))) issues.push('missing conf');
        if (!existsSync(resolve(dir, 'cards'))) issues.push('missing cards/');
        const runtime = resolve(dir, 'runtime');
        if (existsSync(runtime)) {
          const markers = readdirSync(runtime).filter((f) => /worker-\d+-current\.json$/.test(f));
          for (const mf of markers) {
            try {
              const stat = statSync(resolve(runtime, mf));
              const ageMin = Math.floor((Date.now() - stat.mtimeMs) / 60000);
              if (ageMin > 60) issues.push(`stale marker ${mf} (${ageMin}m)`);
            } catch {
              /* ignore */
            }
          }
        }
        report.push({ project: name, issues, ok: issues.length === 0 });
      }
    }
    return c.json({ data: report });
  });

  return app;
}
