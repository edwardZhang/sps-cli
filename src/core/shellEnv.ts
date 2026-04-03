/**
 * @module        shellEnv
 * @description   Shell 配置文件解析与环境变量加载工具
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-29
 * @updated       2026-04-03
 *
 * @role          util
 * @layer         core
 * @boundedContext configuration
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export interface RawEnv {
  [key: string]: string;
}

/**
 * Parse a shell conf file (KEY=value / export KEY=value) into a plain object.
 * Does NOT execute the file — only extracts simple assignments.
 */
export function parseShellConf(filePath: string): RawEnv {
  const result: RawEnv = {};
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(
        /^(?:export\s+)?([A-Z_][A-Z0-9_]*)=["']?(.*?)["']?\s*$/
      );
      if (match) {
        result[match[1]] = match[2];
      }
    }
  } catch { /* file read error */ }
  return result;
}

/**
 * Source a shell file via bash and capture all exported variables.
 * Falls back to regex parsing on bash failure.
 */
export function sourceShellConf(filePath: string): RawEnv {
  try {
    const output = execSync(
      `bash -c 'set -a; source "${filePath}" 2>/dev/null; env'`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    return parseEnvOutput(output);
  } catch {
    return parseShellConf(filePath);
  }
}

/**
 * Source multiple shell files in a single bash context.
 * Later files can reference variables from earlier ones.
 * Falls back to sourcing each file separately on bash failure.
 */
export function sourceCombinedConf(filePaths: string[]): RawEnv {
  const existing = filePaths.filter(p => existsSync(p));
  if (existing.length === 0) return {};

  const sources = existing.map(p => `source "${p}" 2>/dev/null`);
  try {
    const output = execSync(
      `bash -c 'set -a; ${sources.join('; ')}; env'`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    return parseEnvOutput(output);
  } catch {
    // Fallback: source each file separately and merge
    const result: RawEnv = {};
    for (const p of existing) {
      Object.assign(result, sourceShellConf(p));
    }
    return result;
  }
}

/**
 * Parse `env` command output into key-value pairs.
 */
function parseEnvOutput(output: string): RawEnv {
  const result: RawEnv = {};
  for (const line of output.split('\n')) {
    const idx = line.indexOf('=');
    if (idx > 0) {
      result[line.slice(0, idx)] = line.slice(idx + 1);
    }
  }
  return result;
}
