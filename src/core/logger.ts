import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const COLORS = {
  reset: '\x1b[0m',
  gray: '\x1b[90m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
} as const;

export interface EventEntry {
  ts: string;
  project: string;
  component: string;
  action: string;
  entity: string;
  result: 'ok' | 'fail' | 'skip';
  meta?: Record<string, unknown>;
}

/**
 * Format a Date as local time: YYYY-MM-DD HH:mm:ss.SSS
 * Used for console and log file output (human-readable).
 */
function formatLocalTimestamp(d: Date): string {
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const pad3 = (n: number) => String(n).padStart(3, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
}

export class Logger {
  private component: string;
  private project: string;
  private logsDir: string | null;

  constructor(component: string, project: string = '', logsDir: string | null = null) {
    this.component = component;
    this.project = project;
    this.logsDir = logsDir;
  }

  info(msg: string) { this.log('INFO', msg, COLORS.green, 'ℹ'); }
  ok(msg: string) { this.log('OK', msg, COLORS.green, '✓'); }
  warn(msg: string) { this.log('WARN', msg, COLORS.yellow, '⚠'); }
  error(msg: string) { this.log('ERROR', msg, COLORS.red, '✗'); }
  debug(msg: string) {
    if (process.env.DEBUG) this.log('DEBUG', msg, COLORS.gray, '·');
  }

  private log(level: string, msg: string, color: string, icon: string) {
    const now = new Date();
    const localTs = formatLocalTimestamp(now);
    const utcTs = now.toISOString();
    const tag = this.project ? `${this.project}/${this.component}` : this.component;

    // Console: local time for readability
    const prefix = `${COLORS.gray}${localTs}${COLORS.reset} ${COLORS.cyan}[${tag}]${COLORS.reset}`;
    console.error(`${prefix} ${color}${icon} ${msg}${COLORS.reset}`);

    // File: local time for consistency with console
    if (this.logsDir) {
      const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      this.appendToFile(
        resolve(this.logsDir, `pipeline-${dateStr}.log`),
        `${localTs} [${tag}] ${level} ${msg}`
      );
      if (level === 'WARN' || level === 'ERROR') {
        this.appendToFile(
          resolve(this.logsDir, `error-${dateStr}.log`),
          `${localTs} [${tag}] ${level} ${msg}`
        );
      }
    }
  }

  event(entry: Omit<EventEntry, 'ts' | 'project'>) {
    const full: EventEntry = {
      ts: new Date().toISOString(),
      project: this.project,
      ...entry,
    };
    if (this.logsDir) {
      this.appendToFile(
        resolve(this.logsDir, 'events.jsonl'),
        JSON.stringify(full)
      );
    }
  }

  /**
   * Rotate current log files on tick restart.
   * Renames pipeline-*.log and error-*.log to *.<timestamp>.log
   * so each tick session gets a clean log file.
   */
  rotateLogs(): void {
    if (!this.logsDir) return;
    if (!existsSync(this.logsDir)) return;

    const now = new Date();
    const suffix = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;

    try {
      const files = readdirSync(this.logsDir);
      for (const file of files) {
        // Rotate pipeline-YYYY-MM-DD.log → pipeline-YYYY-MM-DD.HHmmss.log
        // Rotate error-YYYY-MM-DD.log → error-YYYY-MM-DD.HHmmss.log
        if (/^(pipeline|error)-\d{4}-\d{2}-\d{2}\.log$/.test(file)) {
          const base = file.replace('.log', '');
          const rotated = `${base}.${suffix}.log`;
          renameSync(
            resolve(this.logsDir, file),
            resolve(this.logsDir, rotated),
          );
        }
      }
    } catch {
      // Rotation failure should never block tick startup
    }
  }

  private appendToFile(filePath: string, line: string) {
    try {
      const dir = resolve(filePath, '..');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      appendFileSync(filePath, line + '\n');
    } catch {
      // Logging should never crash the process
    }
  }
}
