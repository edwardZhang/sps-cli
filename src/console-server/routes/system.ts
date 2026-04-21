/**
 * @module        console-server/routes/system
 * @description   系统信息：版本、运行时、env（脱敏）、doctor 聚合
 */
import { Hono } from 'hono';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

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
