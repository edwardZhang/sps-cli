/**
 * sps logs — Real-time log viewer for all projects (pm2-style).
 *
 * Usage:
 *   sps logs                     # all projects, follow mode
 *   sps logs <project>           # single project
 *   sps logs --lines 50          # show last 50 lines initially
 *   sps logs --err               # error logs only
 *   sps logs --no-follow         # dump and exit (no tailing)
 */
import { existsSync, readdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';

const HOME = process.env.HOME || '/home/coral';

// ── ANSI colors (one per project, cycles) ────────────────────────────

const PROJECT_COLORS = [
  '\x1b[36m', // cyan
  '\x1b[33m', // yellow
  '\x1b[35m', // magenta
  '\x1b[32m', // green
  '\x1b[34m', // blue
  '\x1b[91m', // bright red
  '\x1b[93m', // bright yellow
  '\x1b[95m', // bright magenta
  '\x1b[96m', // bright cyan
];
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

// ── Discover projects ────────────────────────────────────────────────

function discoverProjects(): string[] {
  const projectsDir = resolve(HOME, '.projects');
  if (!existsSync(projectsDir)) return [];
  try {
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && existsSync(resolve(projectsDir, d.name, 'conf')))
      .map(d => d.name)
      .sort();
  } catch {
    return [];
  }
}

// ── Get today's log file path ────────────────────────────────────────

function getLogFile(projectName: string, errOnly: boolean): string {
  const date = new Date().toISOString().slice(0, 10);
  const prefix = errOnly ? 'error' : 'pipeline';
  return resolve(HOME, '.projects', projectName, 'logs', `${prefix}-${date}.log`);
}

// ── Read last N lines from a file ────────────────────────────────────

function tailLines(filePath: string, n: number): string[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter(l => l.length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

// ── Color a log line based on level ──────────────────────────────────

function colorLevel(line: string): string {
  if (line.includes(' ERROR ')) return `\x1b[31m${line}${RESET}`;
  if (line.includes(' WARN '))  return `\x1b[33m${line}${RESET}`;
  if (line.includes(' OK '))    return `\x1b[32m${line}${RESET}`;
  if (line.includes(' DEBUG ')) return `${DIM}${line}${RESET}`;
  return line;
}

// ── File watcher state ───────────────────────────────────────────────

interface WatchedFile {
  projectName: string;
  filePath: string;
  color: string;
  offset: number;
  lastDate: string;
}

function getFileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

function readNewBytes(filePath: string, fromOffset: number): string {
  try {
    const size = getFileSize(filePath);
    if (size <= fromOffset) return '';
    const buf = Buffer.alloc(size - fromOffset);
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, buf, 0, buf.length, fromOffset);
    } finally {
      closeSync(fd);
    }
    return buf.toString('utf-8');
  } catch {
    return '';
  }
}

// ── Main entry ───────────────────────────────────────────────────────

export async function executeLogs(
  projects: string[],
  flags: Record<string, boolean>,
  initialLines: number,
): Promise<void> {
  const errOnly = !!flags.err;
  const follow = !flags['no-follow'];

  if (projects.length === 0) {
    projects = discoverProjects();
  }

  if (projects.length === 0) {
    console.error('No projects found in ~/.projects/');
    process.exit(1);
  }

  // Assign colors to projects
  const colorMap = new Map<string, string>();
  projects.forEach((p, i) => {
    colorMap.set(p, PROJECT_COLORS[i % PROJECT_COLORS.length]);
  });

  // Print header
  const mode = errOnly ? 'error' : 'pipeline';
  console.error(
    `${DIM}── sps logs ── ${mode} ── ${projects.join(', ')} ── ${follow ? 'following' : 'dump'} ──${RESET}\n`
  );

  // Show initial tail for each project
  const watched: WatchedFile[] = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const projectName of projects) {
    const color = colorMap.get(projectName)!;
    const filePath = getLogFile(projectName, errOnly);
    const tag = `${color}[${projectName}]${RESET}`;

    // Print last N lines
    const lines = tailLines(filePath, initialLines);
    for (const line of lines) {
      process.stdout.write(`${tag} ${colorLevel(line)}\n`);
    }

    watched.push({
      projectName,
      filePath,
      color,
      offset: getFileSize(filePath),
      lastDate: today,
    });
  }

  if (!follow) return;

  // ── Follow mode: poll for new data ─────────────────────────────────

  // Handle exit
  const cleanup = () => {
    process.stdout.write(RESET);
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Enable raw mode for 'q' to quit
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (key: string) => {
      if (key === 'q' || key === '\x03') cleanup();
    });
  }

  while (true) {
    const now = new Date().toISOString().slice(0, 10);

    for (const w of watched) {
      // Date rollover — switch to new log file
      if (now !== w.lastDate) {
        w.filePath = getLogFile(w.projectName, errOnly);
        w.offset = 0;
        w.lastDate = now;
      }

      // Check for new file if current doesn't exist yet
      if (!existsSync(w.filePath)) {
        w.filePath = getLogFile(w.projectName, errOnly);
        w.offset = 0;
        continue;
      }

      const newData = readNewBytes(w.filePath, w.offset);
      if (newData.length === 0) continue;

      w.offset += Buffer.byteLength(newData, 'utf-8');
      const tag = `${w.color}[${w.projectName}]${RESET}`;
      const lines = newData.split('\n').filter(l => l.length > 0);
      for (const line of lines) {
        process.stdout.write(`${tag} ${colorLevel(line)}\n`);
      }
    }

    await new Promise(r => setTimeout(r, 500));
  }
}
