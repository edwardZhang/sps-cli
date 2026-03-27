import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProjectContext } from '../core/context.js';
import { readState, type WorkerSlotState } from '../core/state.js';
import { readACPState } from '../core/acpState.js';
import { isProcessAlive, tailFile } from '../providers/outputParser.js';
import { renderClaudeStreamLines, renderCodexStreamLines } from '../providers/streamRenderer.js';

const HOME = process.env.HOME || '/home/coral';

// ── tmux helpers ──────────────────────────────────────────────────────

function tmux(args: string[]): string | null {
  try {
    return execFileSync('tmux', args, {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

function listTmuxSessions(): string[] {
  const out = tmux(['list-sessions', '-F', '#{session_name}']);
  if (!out) return [];
  return out.trim().split('\n').filter(Boolean);
}

function capturePaneText(session: string, lines: number): string {
  return tmux(['capture-pane', '-t', session, '-p', '-S', `-${lines}`]) ?? '';
}

function getSessionDimensions(session: string): { cols: number; rows: number } {
  const out = tmux(['display-message', '-t', session, '-p', '#{window_width},#{window_height}']);
  if (!out) return { cols: 0, rows: 0 };
  const [cols, rows] = out.trim().split(',').map(Number);
  return { cols: cols || 0, rows: rows || 0 };
}

// ── ANSI helpers ──────────────────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const FG = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
};
const BG = {
  black: '\x1b[40m',
};

function statusColor(status: string): string {
  switch (status) {
    case 'active': return FG.green;
    case 'idle': return FG.gray;
    case 'releasing': return FG.yellow;
    default: return FG.white;
  }
}

function statusIcon(status: string): string {
  switch (status) {
    case 'active': return '●';
    case 'idle': return '○';
    case 'releasing': return '◐';
    default: return '?';
  }
}

function sessionStatusIcon(alive: boolean): string {
  return alive ? `${FG.green}▶${RESET}` : `${FG.red}■${RESET}`;
}

// ── Strip ANSI escape codes for width calculations ────────────────────

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

// ── Pad / truncate to visible width ──────────────────────────────────

function padOrTruncate(s: string, width: number): string {
  const vLen = visibleLength(s);
  if (vLen > width) {
    // Truncate: walk character by character, tracking visible length
    let visible = 0;
    let result = '';
    let inEscape = false;
    for (const ch of s) {
      if (ch === '\x1b') { inEscape = true; result += ch; continue; }
      if (inEscape) { result += ch; if (/[a-zA-Z]/.test(ch)) inEscape = false; continue; }
      if (visible >= width - 1) { result += '…'; break; }
      result += ch;
      visible++;
    }
    return result;
  }
  return s + ' '.repeat(width - vLen);
}

// ── Discover all SPS projects from ~/.coral/projects/ ────────────────

function discoverProjects(): string[] {
  const projectsDir = resolve(HOME, '.coral', 'projects');
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

// ── Panel data ───────────────────────────────────────────────────────

interface WorkerPanel {
  projectName: string;
  slotName: string;
  slot: WorkerSlotState;
  sessionAlive: boolean;
  paneLines: string[];
}

function collectPanels(projects: string[]): WorkerPanel[] {
  const panels: WorkerPanel[] = [];
  const allSessions = new Set(listTmuxSessions());

  for (const projectName of projects) {
    let ctx: ProjectContext;
    try {
      ctx = ProjectContext.load(projectName);
    } catch {
      continue;
    }

    const state = readState(ctx.paths.stateFile, ctx.maxWorkers);
    const acpState = readACPState(ctx.paths.acpStateFile);

    for (const [slotName, slot] of Object.entries(state.workers)) {
      const sessionName = slot.tmuxSession || `${projectName}-${slotName}`;
      const isPrintMode = slot.mode === 'print';
      const isAcpMode = slot.mode === 'acp' || slot.transport === 'acp';

      let sessionAlive: boolean;
      let paneLines: string[];

      if (isAcpMode) {
        const session = acpState.sessions[slotName];
        const runStatus = session?.currentRun?.status || slot.remoteStatus || 'unknown';
        sessionAlive = !!(session && session.sessionState !== 'offline');
        paneLines = session?.lastPaneText
          ? session.lastPaneText.split('\n')
          : [`(acp ${slot.agent || 'worker'} ${sessionAlive ? 'connected' : 'offline'})`, `run: ${runStatus}`];
      } else if (isPrintMode) {
        // Print mode: check PID liveness + tail output file
        sessionAlive = !!(slot.pid && slot.pid > 0 && isProcessAlive(slot.pid));
        if (slot.outputFile) {
          const rawLines = tailFile(slot.outputFile, 40).split('\n');
          // Render JSONL into human-readable lines
          const rendered = slot.tmuxSession?.includes('codex')
            ? renderCodexStreamLines(rawLines)
            : renderClaudeStreamLines(rawLines);
          paneLines = rendered.length > 0 ? rendered : rawLines;
        } else {
          paneLines = sessionAlive ? ['(worker running, no output yet)'] : ['(no output file)'];
        }
      } else {
        // Interactive (tmux) mode
        sessionAlive = allSessions.has(sessionName);
        const paneText = sessionAlive ? capturePaneText(sessionName, 30) : '';
        paneLines = paneText.split('\n');
      }

      // Skip idle slots with no live session/process
      if (slot.status === 'idle' && !sessionAlive) continue;

      // Skip "active" slots where the worker PID is actually dead (stale state)
      if (slot.status === 'active' && !sessionAlive) continue;

      // Show "merging" slots (no live output but useful to see in dashboard)
      // Show "resolving" slots (resume worker may have output)

      panels.push({
        projectName,
        slotName,
        slot,
        sessionAlive,
        paneLines,
      });
    }
  }

  return panels;
}

// ── Render dashboard ─────────────────────────────────────────────────

function renderHeader(termWidth: number): string[] {
  const title = ' SPS Worker Dashboard ';
  const now = new Date().toLocaleTimeString();
  const rightInfo = `${DIM}${now}  q=quit  r=refresh${RESET}`;
  const rightLen = visibleLength(rightInfo);
  const leftPad = Math.max(0, Math.floor((termWidth - title.length) / 2));

  return [
    `${BOLD}${FG.cyan}${'─'.repeat(termWidth)}${RESET}`,
    `${' '.repeat(leftPad)}${BOLD}${FG.cyan}${title}${RESET}${' '.repeat(Math.max(0, termWidth - leftPad - title.length - rightLen))}${rightInfo}`,
    `${BOLD}${FG.cyan}${'─'.repeat(termWidth)}${RESET}`,
  ];
}

function renderPanel(panel: WorkerPanel, panelWidth: number, panelHeight: number): string[] {
  const lines: string[] = [];
  const innerWidth = panelWidth - 2; // borders

  // ── Header bar ──
  const sIcon = statusIcon(panel.slot.status);
  const sColor = statusColor(panel.slot.status);
  const aliveIcon = sessionStatusIcon(panel.sessionAlive);
  const seqInfo = panel.slot.seq !== null ? ` seq:${panel.slot.seq}` : '';
  const branchInfo = panel.slot.branch ? ` ${DIM}${panel.slot.branch}${RESET}` : '';
  const headerText = `${sColor}${sIcon} ${BOLD}${panel.projectName}/${panel.slotName}${RESET}${seqInfo} ${aliveIcon}${branchInfo}`;
  const headerLine = ` ${padOrTruncate(headerText, innerWidth)} `;

  // ── Time info ──
  const elapsed = panel.slot.claimedAt
    ? formatElapsed(new Date(panel.slot.claimedAt))
    : '';
  const heartbeat = panel.slot.lastHeartbeat
    ? `hb: ${formatElapsed(new Date(panel.slot.lastHeartbeat))} ago`
    : '';
  const modeInfo = panel.slot.mode === 'print'
    ? `pid:${panel.slot.pid || '?'}${panel.slot.exitCode != null ? ` exit:${panel.slot.exitCode}` : ''}`
    : panel.slot.mode === 'acp'
      ? `acp:${panel.slot.sessionState || 'unknown'}${panel.slot.remoteStatus ? `/${panel.slot.remoteStatus}` : ''}`
      : '';
  const timeLine = elapsed || heartbeat || modeInfo
    ? ` ${DIM}${[elapsed, heartbeat, modeInfo].filter(Boolean).join(' │ ')}${RESET}`
    : '';

  // Top border
  lines.push(`${FG.gray}┌${'─'.repeat(panelWidth - 2)}┐${RESET}`);
  lines.push(`${FG.gray}│${RESET}${padOrTruncate(headerText, innerWidth)}${FG.gray}│${RESET}`);
  if (timeLine) {
    lines.push(`${FG.gray}│${RESET}${padOrTruncate(timeLine, innerWidth)}${FG.gray}│${RESET}`);
  }
  lines.push(`${FG.gray}├${'─'.repeat(panelWidth - 2)}┤${RESET}`);

  // ── Pane content ──
  const contentHeight = panelHeight - lines.length - 1; // -1 for bottom border
  const trimmedLines = panel.paneLines
    .filter(l => l.trim() !== '') // skip empty lines
    .slice(-contentHeight); // show last N lines

  for (let i = 0; i < contentHeight; i++) {
    const raw = trimmedLines[i] ?? '';
    const content = padOrTruncate(`${DIM}${raw}${RESET}`, innerWidth);
    lines.push(`${FG.gray}│${RESET}${content}${FG.gray}│${RESET}`);
  }

  // Bottom border
  lines.push(`${FG.gray}└${'─'.repeat(panelWidth - 2)}┘${RESET}`);

  return lines;
}

function renderIdleSummary(projects: string[], termWidth: number): string[] {
  const lines: string[] = [];
  for (const projectName of projects) {
    let ctx: ProjectContext;
    try {
      ctx = ProjectContext.load(projectName);
    } catch { continue; }

    const state = readState(ctx.paths.stateFile, ctx.maxWorkers);
    const total = Object.keys(state.workers).length;
    // Verify PID liveness for active workers
    let realActive = 0;
    let stale = 0;
    let merging = 0;
    for (const w of Object.values(state.workers)) {
      if (w.status === 'active') {
        const wPid = (w as unknown as { pid?: number | null }).pid ?? null;
        if (wPid && isProcessAlive(wPid)) {
          realActive++;
        } else {
          stale++;
        }
      } else if (w.status === 'merging' || w.status === 'resolving') {
        merging++;
      }
    }
    const idle = Object.values(state.workers).filter(w => w.status === 'idle').length;
    const activeCards = Object.keys(state.activeCards).length;
    const extraParts: string[] = [];
    if (merging > 0) extraParts.push(`${FG.yellow}${merging} merging${RESET}`);
    if (stale > 0) extraParts.push(`${FG.yellow}${stale} stale${RESET}`);
    const extraStr = extraParts.length > 0 ? ` / ${extraParts.join(' / ')}` : '';

    lines.push(
      `  ${BOLD}${projectName}${RESET}: ${FG.green}${realActive} active${RESET} / ${FG.gray}${idle} idle${RESET}${extraStr} / ${total} total  │  ${FG.cyan}${activeCards} cards${RESET}`
    );
  }
  return lines;
}

function renderEmptyState(termWidth: number): string[] {
  return [
    '',
    `${DIM}  No active workers found.${RESET}`,
    `${DIM}  All worker slots are idle across all projects.${RESET}`,
    '',
    `${DIM}  Tip: Start a pipeline with ${RESET}sps tick <project>${DIM} to launch workers.${RESET}`,
    '',
  ];
}

function formatElapsed(from: Date): string {
  const ms = Date.now() - from.getTime();
  if (ms < 0) return '';
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${mins % 60}m`;
}

function getTerminalSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 40,
  };
}

function renderDashboard(projects: string[]): string {
  const { cols: termWidth, rows: termHeight } = getTerminalSize();
  const output: string[] = [];

  // Header
  output.push(...renderHeader(termWidth));

  // Summary line
  output.push('');
  output.push(...renderIdleSummary(projects, termWidth));
  output.push('');

  // Collect active panels
  const panels = collectPanels(projects);

  if (panels.length === 0) {
    output.push(...renderEmptyState(termWidth));
    return output.join('\n');
  }

  // Calculate grid layout
  const gridCols = panels.length <= 2 ? panels.length : panels.length <= 4 ? 2 : 3;
  const gridRows = Math.ceil(panels.length / gridCols);
  const panelWidth = Math.floor((termWidth - 1) / gridCols); // -1 for spacing
  const usedHeaderRows = output.length;
  const availableRows = termHeight - usedHeaderRows - 1; // -1 for safety
  const panelHeight = Math.max(6, Math.floor(availableRows / gridRows));

  // Render panels row by row
  for (let row = 0; row < gridRows; row++) {
    const rowPanels: string[][] = [];
    for (let col = 0; col < gridCols; col++) {
      const idx = row * gridCols + col;
      if (idx < panels.length) {
        rowPanels.push(renderPanel(panels[idx], panelWidth, panelHeight));
      } else {
        // Empty filler
        rowPanels.push(Array(panelHeight + 2).fill(' '.repeat(panelWidth)));
      }
    }

    // Merge columns side by side
    const maxLines = Math.max(...rowPanels.map(p => p.length));
    for (let line = 0; line < maxLines; line++) {
      const merged = rowPanels
        .map(p => p[line] ?? ' '.repeat(panelWidth))
        .join(' ');
      output.push(merged);
    }
  }

  // Truncate to terminal height to prevent scrolling
  if (output.length > termHeight) {
    output.length = termHeight;
  }

  return output.join('\n');
}

// ── JSON output ──────────────────────────────────────────────────────

interface DashboardJson {
  timestamp: string;
  projects: {
    name: string;
    workers: {
      slot: string;
      status: string;
      seq: number | null;
      branch: string | null;
      tmuxSession: string | null;
      sessionAlive: boolean;
      claimedAt: string | null;
      lastHeartbeat: string | null;
      panePreview: string;
    }[];
    activeCards: Record<string, unknown>;
  }[];
  tmuxSessions: string[];
}

function buildJsonOutput(projects: string[]): DashboardJson {
  const allSessions = new Set(listTmuxSessions());
  const result: DashboardJson = {
    timestamp: new Date().toISOString(),
    projects: [],
    tmuxSessions: [...allSessions].sort(),
  };

  for (const projectName of projects) {
    let ctx: ProjectContext;
    try {
      ctx = ProjectContext.load(projectName);
    } catch { continue; }

    const state = readState(ctx.paths.stateFile, ctx.maxWorkers);
    const acpState = readACPState(ctx.paths.acpStateFile);
    const workers: DashboardJson['projects'][0]['workers'] = [];

    for (const [slotName, slot] of Object.entries(state.workers)) {
      const sessionName = slot.tmuxSession || `${projectName}-${slotName}`;
      const isPrintMode = slot.mode === 'print';
      const isAcpMode = slot.mode === 'acp' || slot.transport === 'acp';
      const acpSession = acpState.sessions[slotName];
      const sessionAlive = isAcpMode
        ? !!(acpSession && acpSession.sessionState !== 'offline')
        : isPrintMode
          ? !!(slot.pid && slot.pid > 0 && isProcessAlive(slot.pid))
          : allSessions.has(sessionName);
      const panePreview = isAcpMode
        ? (acpSession?.lastPaneText || '').trim()
        : sessionAlive && !isPrintMode
          ? capturePaneText(sessionName, 5).trim()
          : '';

      workers.push({
        slot: slotName,
        status: slot.status,
        seq: slot.seq,
        branch: slot.branch,
        tmuxSession: slot.tmuxSession,
        sessionAlive,
        claimedAt: slot.claimedAt,
        lastHeartbeat: slot.lastHeartbeat,
        panePreview,
      });
    }

    result.projects.push({
      name: projectName,
      workers,
      activeCards: state.activeCards,
    });
  }

  return result;
}

// ── Live mode (watch) ────────────────────────────────────────────────

async function runLive(projects: string[], intervalMs: number): Promise<never> {
  // Switch to alternate screen buffer + hide cursor (like top/htop/vim)
  process.stdout.write('\x1b[?1049h\x1b[?25l');

  // Restore main screen + cursor on exit
  const cleanup = () => {
    process.stdout.write('\x1b[?25h');   // show cursor
    process.stdout.write('\x1b[?1049l'); // switch back to main screen
    process.stdout.write('\x1b[0m');     // reset colors
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  // Enable raw mode for keypress detection
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (key: string) => {
      if (key === 'q' || key === '\x03') { // q or Ctrl+C
        cleanup();
      }
      if (key === 'r') {
        // Force immediate refresh
        draw();
      }
    });
  }

  const draw = () => {
    const screen = renderDashboard(projects);
    // Move cursor to top-left and clear from cursor to end of screen.
    // No \x1b[2J needed — alternate screen buffer prevents scrollback pollution.
    process.stdout.write('\x1b[H\x1b[J');
    process.stdout.write(screen);
  };

  draw();
  setInterval(draw, intervalMs);

  // Block forever
  return new Promise(() => {});
}

// ── Main entry point ─────────────────────────────────────────────────

export async function executeWorkerDashboard(
  projects: string[],
  flags: Record<string, boolean>,
): Promise<void> {
  const jsonOutput = !!flags.json;
  const watch = !flags.once; // default to live mode unless --once

  // If no projects specified, discover all
  if (projects.length === 0) {
    projects = discoverProjects();
  }

  if (projects.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), projects: [], tmuxSessions: [] }));
    } else {
      console.error('No projects found in ~/.coral/projects/');
    }
    process.exit(1);
  }

  if (jsonOutput) {
    console.log(JSON.stringify(buildJsonOutput(projects), null, 2));
    return;
  }

  if (watch) {
    const intervalMs = parseInt(process.env.SPS_DASHBOARD_INTERVAL || '3000', 10);
    await runLive(projects, intervalMs);
  } else {
    console.log(renderDashboard(projects));
  }
}
