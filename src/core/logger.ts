import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
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
