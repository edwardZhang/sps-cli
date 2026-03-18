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
    const ts = new Date().toISOString();
    const tag = this.project ? `${this.project}/${this.component}` : this.component;
    const prefix = `${COLORS.gray}${ts}${COLORS.reset} ${COLORS.cyan}[${tag}]${COLORS.reset}`;
    console.error(`${prefix} ${color}${icon} ${msg}${COLORS.reset}`);

    if (this.logsDir) {
      this.appendToFile(
        resolve(this.logsDir, `pipeline-${ts.slice(0, 10)}.log`),
        `${ts} [${tag}] ${level} ${msg}`
      );
      if (level === 'WARN' || level === 'ERROR') {
        this.appendToFile(
          resolve(this.logsDir, `error-${ts.slice(0, 10)}.log`),
          `${ts} [${tag}] ${level} ${msg}`
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
