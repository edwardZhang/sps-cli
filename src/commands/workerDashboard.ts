import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { ProjectContext } from '../core/context.js';
// ACP SDK handles all worker interaction
import { readState, type WorkerSlotState } from '../core/state.js';
import { summarizeWorkerRuntime } from '../core/workerRuntimeSummary.js';
import {
  hasPersistedActiveRun,
  isACPBackedSlot,
  isProcessAlive,
  isPersistedSessionAlive,
} from '../core/sessionLiveness.js';
import { loadRuntimeSnapshot, type ProjectRuntimeSnapshot } from '../core/runtimeSnapshot.js';
import type { ACPSessionRecord } from '../models/acp.js';
import { tailFile } from '../providers/outputParser.js';
import { renderClaudeStreamLines, renderCodexStreamLines } from '../providers/streamRenderer.js';

const HOME = process.env.HOME || '/home/coral';


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
const STRIP_ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b\[[\?]?[0-9;]*[hlm]/g;

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
  return s.replace(STRIP_ANSI_RE, '');
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

type SnapshotMap = Map<string, ProjectRuntimeSnapshot>;

async function loadSnapshots(projects: string[]): Promise<SnapshotMap> {
  const snapshots: SnapshotMap = new Map();
  for (const projectName of projects) {
    try {
      snapshots.set(projectName, await loadRuntimeSnapshot(projectName, { projectWhenTickStopped: false }));
    } catch {
      // Read-only dashboard snapshots are best effort.
    }
  }
  return snapshots;
}

// ── Panel data ───────────────────────────────────────────────────────

interface WorkerPanel {
  projectName: string;
  slotName: string;
  slot: WorkerSlotState;
  sessionAlive: boolean;
  paneLines: string[];
}

interface ProcessMetrics {
  pid: number;
  state: string;
  cpu: number;
  elapsed: string;
}

interface ACPDiagnostics {
  screenStatus?: string;
  promptText?: string;
  process?: ProcessMetrics | null;
  lastOutputAgeSec?: number | null;
  stalledReason?: string | null;
}

function shortenPath(path: string | null | undefined): string {
  if (!path) return '';
  return path.startsWith(HOME) ? `~${path.slice(HOME.length)}` : path;
}

function cleanScreenLines(text: string): string[] {
  const lines = stripAnsi(text)
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => line.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const deduped: string[] = [];
  for (const line of lines) {
    if (deduped[deduped.length - 1] !== line) deduped.push(line);
  }
  return deduped;
}

function extractCodexScreenFacts(lines: string[]): {
  model?: string;
  directory?: string;
  prompt?: string;
  status?: string;
} {
  const facts: { model?: string; directory?: string; prompt?: string; status?: string } = {};
  for (const line of lines) {
    if (!facts.model) {
      const match = line.match(/model:\s+(.+?)(?:\s+\/model.*)?$/i);
      if (match) facts.model = match[1].trim();
    }
    if (!facts.directory) {
      const match = line.match(/directory:\s+(.+)$/i);
      if (match) facts.directory = match[1].trim();
    }
    if (!facts.prompt) {
      const match = line.match(/^[›❯>]\s+(.+)$/);
      if (match && !/^\d+\./.test(match[1])) facts.prompt = match[1].trim();
    }
    if (!facts.status) {
      if (/Do you trust the contents of this directory/i.test(line)) {
        facts.status = 'Trust confirmation required';
      } else if (/Press enter to continue/i.test(line)) {
        facts.status = 'Startup confirmation required';
      } else if (/OpenAI Codex/i.test(line)) {
        facts.status = 'Codex home screen';
      }
    }
  }
  return facts;
}

function extractClaudeScreenFacts(lines: string[]): {
  prompt?: string;
  status?: string;
} {
  const facts: { prompt?: string; status?: string } = {};
  for (const line of lines) {
    if (!facts.prompt) {
      const match = line.match(/^[›❯>]\s+(.+)$/);
      if (match) facts.prompt = match[1].trim();
    }
    if (!facts.status) {
      if (/trust this folder/i.test(line)) {
        facts.status = 'Trust confirmation required';
      } else if (/Enter to confirm|Esc to cancel/i.test(line)) {
        facts.status = 'Confirmation required';
      }
    }
  }
  return facts;
}

function getProcessMetrics(pid: number | null | undefined): ProcessMetrics | null {
  if (!pid || pid <= 0) return null;
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'pid=,state=,%cpu=,etime='], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (!out) return null;
    const match = out.match(/^\s*(\d+)\s+(\S+)\s+([\d.]+)\s+(.+)\s*$/);
    if (!match) return null;
    return {
      pid: Number(match[1]),
      state: match[2],
      cpu: Number(match[3]),
      elapsed: match[4].trim(),
    };
  } catch {
    return null;
  }
}

function latestWorkerLogAgeSec(ctx: ProjectContext, slotName: string): number | null {
  try {
    const entries = readdirSync(ctx.paths.logsDir)
      .filter(name =>
        name.includes('-acp-') &&
        name.endsWith('.log'),
      )
      .map(name => resolve(ctx.paths.logsDir, name));
    if (entries.length === 0) return null;
    entries.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    const mtimeMs = statSync(entries[0]).mtimeMs;
    return Math.max(0, Math.floor((Date.now() - mtimeMs) / 1000));
  } catch {
    return null;
  }
}

function analyzeACPSession(
  ctx: ProjectContext,
  slotName: string,
  slot: WorkerSlotState,
  session: ACPSessionRecord | undefined,
  sessionAlive: boolean,
): ACPDiagnostics {
  const rawLines = cleanScreenLines(session?.lastPaneText || '');
  const tool = session?.tool || slot.agent || 'worker';
  const facts = tool === 'codex' ? extractCodexScreenFacts(rawLines) : extractClaudeScreenFacts(rawLines);
  const process = getProcessMetrics(session?.pid ?? slot.pid);
  const lastOutputAgeSec = latestWorkerLogAgeSec(ctx, slotName);

  let stalledReason: string | null = null;
  const runStatus = session?.currentRun?.status || slot.remoteStatus || 'unknown';
  const sessionState = session?.sessionState || slot.sessionState || 'offline';

  if (session?.stalledReason) {
    stalledReason = session.stalledReason;
  }

  if (
    tool === 'codex' &&
    sessionAlive &&
    sessionState === 'busy' &&
    runStatus === 'running' &&
    facts.status === 'Codex home screen' &&
    (lastOutputAgeSec ?? 0) >= 60 &&
    ((process?.cpu ?? 0) <= 0.1)
  ) {
    stalledReason = `stalled at Codex home screen (${formatDuration(lastOutputAgeSec ?? 0)} no output, cpu ${process?.cpu?.toFixed(1) ?? '0.0'}%)`;
  }

  if (
    !stalledReason &&
    sessionAlive &&
    runStatus === 'stalled_submit'
  ) {
    stalledReason = session?.stalledReason || 'prompt submission stalled';
  }

  return {
    screenStatus: facts.status,
    promptText: facts.prompt,
    process,
    lastOutputAgeSec,
    stalledReason,
  };
}

/** Read last N lines from the most recent ACP log file for this session. */
function tailAcpLogFile(ctx: ProjectContext, sessionName: string | undefined, n: number): string[] {
  if (!sessionName) return [];
  try {
    const entries = readdirSync(ctx.paths.logsDir)
      .filter(name => name.includes('-acp-') && name.endsWith('.log'))
      .map(name => resolve(ctx.paths.logsDir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (entries.length === 0) return [];
    const content = readFileSync(entries[0], 'utf-8');
    return content.split('\n').filter(l => l.length > 0).slice(-n);
  } catch {
    return [];
  }
}

function buildACPPanelLines(
  ctx: ProjectContext,
  slotName: string,
  slot: WorkerSlotState,
  session: ACPSessionRecord | undefined,
  sessionAlive: boolean,
): string[] {
  const lines: string[] = [];
  const tool = session?.tool || slot.agent || 'worker';
  const runStatus = session?.currentRun?.status || slot.remoteStatus || 'unknown';
  const sessionState = session?.sessionState || slot.sessionState || 'offline';
  const worktree = shortenPath(slot.worktree || session?.cwd || '');
  // For ACP-SDK: prefer log file tail over lastPaneText (more real-time)
  const isAcpSdk = slot.transport === 'acp-sdk' || slot.mode === 'acp-sdk';
  const paneText = session?.lastPaneText || '';
  const rawLines = isAcpSdk && !paneText
    ? tailAcpLogFile(ctx, session?.sessionName, 20)
    : cleanScreenLines(paneText);
  const codexFacts = extractCodexScreenFacts(rawLines);
  const claudeFacts = extractClaudeScreenFacts(rawLines);
  const facts = tool === 'codex' ? codexFacts : claudeFacts;
  const diagnostics = analyzeACPSession(ctx, slotName, slot, session, sessionAlive);

  lines.push(`${BOLD}tool:${RESET} ${tool}`);
  lines.push(`${BOLD}session:${RESET} ${sessionState} / ${runStatus}`);
  if (tool === 'codex' && codexFacts.model) {
    lines.push(`${BOLD}model:${RESET} ${codexFacts.model}`);
  }
  lines.push(`${BOLD}cwd:${RESET} ${worktree || '(unknown)'}`);
  if (diagnostics.process) {
    lines.push(`${BOLD}proc:${RESET} pid ${diagnostics.process.pid} · ${diagnostics.process.state} · cpu ${diagnostics.process.cpu.toFixed(1)}% · etime ${diagnostics.process.elapsed}`);
  }
  if (diagnostics.lastOutputAgeSec != null) {
    lines.push(`${BOLD}output:${RESET} last worker output ${formatDuration(diagnostics.lastOutputAgeSec)} ago`);
  }
  if (diagnostics.stalledReason) {
    lines.push(`${FG.yellow}${BOLD}health:${RESET}${FG.yellow} ${diagnostics.stalledReason}${RESET}`);
  }

  if (session?.pendingInput) {
    const danger = session.pendingInput.dangerous ? ' (dangerous)' : '';
    lines.push(`${FG.yellow}${BOLD}waiting:${RESET}${FG.yellow} ${session.pendingInput.type}${danger}${RESET}`);
    lines.push(`${DIM}${session.pendingInput.prompt}${RESET}`);
    return lines;
  }

  if (diagnostics.screenStatus) {
    lines.push(`${BOLD}screen:${RESET} ${diagnostics.screenStatus}`);
  }
  if (diagnostics.promptText) {
    lines.push(`${DIM}${diagnostics.promptText}${RESET}`);
  } else if (session?.currentRun?.promptPreview) {
    // For ACP-SDK mode, promptPreview is the full prompt (not useful for display)
    const isAcp = slot.transport === 'acp-sdk' || slot.mode === 'acp-sdk';
    if (!isAcp) {
      lines.push(`${DIM}${session.currentRun.promptPreview}${RESET}`);
    }
  }

  const liveTail = rawLines
    .filter(line => line !== diagnostics.screenStatus && line !== diagnostics.promptText)
    .slice(-4);
  if (liveTail.length === 0 && (slot.transport === 'acp-sdk' || slot.mode === 'acp-sdk')) {
    lines.push(`${DIM}(waiting for agent output...)${RESET}`);
  }
  for (const line of liveTail) {
    lines.push(`${DIM}${line}${RESET}`);
  }

  return lines;
}

function buildPrintPanelLines(slot: WorkerSlotState, rawLines: string[]): string[] {
  const lines = rawLines
    .map(line => line.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim())
    .filter(Boolean)
    .slice(-8);

  return lines.length > 0 ? lines : ['(worker running, no output yet)'];
}

function collectPanels(projects: string[], snapshots: SnapshotMap): WorkerPanel[] {
  const panels: WorkerPanel[] = [];

  for (const projectName of projects) {
    const snapshot = snapshots.get(projectName);
    if (!snapshot) continue;
    const { ctx, state } = snapshot;

    for (const [slotName, slot] of Object.entries(state.workers)) {
      const isPrintMode = slot.mode === 'print';
      const isAcpMode = slot.mode === 'acp' || slot.mode === 'acp-sdk' || slot.transport === 'acp' || slot.transport === 'acp-sdk';

      let sessionAlive: boolean;
      let paneLines: string[];

      if (isAcpMode) {
        const session = state.sessions[slotName];
        const runStatus = session?.currentRun?.status || slot.remoteStatus || 'unknown';
        sessionAlive = isPersistedSessionAlive(slot, session);
        paneLines = buildACPPanelLines(ctx, slotName, slot, session, sessionAlive);
        if (paneLines.length === 0) {
          paneLines = [`(acp ${slot.agent || 'worker'} ${sessionAlive ? 'connected' : 'offline'})`, `run: ${runStatus}`];
        }
      } else if (isPrintMode) {
        // Print mode: check PID liveness + tail output file
        sessionAlive = !!(slot.pid && slot.pid > 0 && isProcessAlive(slot.pid));
        if (slot.outputFile) {
          const rawLines = tailFile(slot.outputFile, 40).split('\n');
          // Render JSONL into human-readable lines
          const rendered = (slot.agent === 'codex')
            ? renderCodexStreamLines(rawLines)
            : renderClaudeStreamLines(rawLines);
          paneLines = buildPrintPanelLines(slot, rendered.length > 0 ? rendered : rawLines);
        } else {
          paneLines = sessionAlive ? ['(worker running, no output yet)'] : ['(no output file)'];
        }
      } else {
        // Fallback: no live output
        sessionAlive = false;
        paneLines = ['(no output)'];
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
  const rightInfo = `${DIM}${now}  q=quit  r=refresh  :=respond${RESET}`;
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
    : (panel.slot.mode === 'acp' || panel.slot.mode === 'acp-sdk')
      ? `${panel.slot.mode}:${panel.slot.sessionState || 'unknown'}${panel.slot.remoteStatus ? `/${panel.slot.remoteStatus}` : ''}`
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
    const content = padOrTruncate(raw, innerWidth);
    lines.push(`${FG.gray}│${RESET}${content}${FG.gray}│${RESET}`);
  }

  // Bottom border
  lines.push(`${FG.gray}└${'─'.repeat(panelWidth - 2)}┘${RESET}`);

  return lines;
}

function renderIdleSummary(projects: string[], termWidth: number, snapshots: SnapshotMap): string[] {
  const lines: string[] = [];
  for (const projectName of projects) {
    void termWidth;
    const snapshot = snapshots.get(projectName);
    if (!snapshot) continue;
    const { state } = snapshot;
    const summary = summarizeWorkerRuntime(state);
    const activeCards = Object.keys(state.activeCards).length;
    const extraParts: string[] = [];
    if (summary.merging > 0) extraParts.push(`${FG.yellow}${summary.merging} merging${RESET}`);
    if (summary.stale > 0) extraParts.push(`${FG.yellow}${summary.stale} stale${RESET}`);
    const extraStr = extraParts.length > 0 ? ` / ${extraParts.join(' / ')}` : '';

    lines.push(
      `  ${BOLD}${projectName}${RESET}: ${FG.green}${summary.active} active${RESET} / ${FG.gray}${summary.idle} idle${RESET}${extraStr} / ${summary.total} total  │  ${FG.cyan}${activeCards} cards${RESET}`
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

function formatDuration(totalSecs: number): string {
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  if (mins < 60) return `${mins}m${totalSecs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h${mins % 60}m`;
}

function getTerminalSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 40,
  };
}

function renderDashboard(projects: string[], snapshots: SnapshotMap): string {
  const { cols: termWidth, rows: termHeight } = getTerminalSize();
  const output: string[] = [];

  // Header
  output.push(...renderHeader(termWidth));

  // Summary line
  output.push('');
  output.push(...renderIdleSummary(projects, termWidth, snapshots));
  output.push('');

  // Collect active panels
  const panels = collectPanels(projects, snapshots);

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
      sessionAlive: boolean;
      claimedAt: string | null;
      lastHeartbeat: string | null;
      processCpu?: number | null;
      processState?: string | null;
      lastOutputAgeSec?: number | null;
      stalledReason?: string | null;
      panePreview: string;
    }[];
    activeCards: Record<string, unknown>;
  }[];
}

function buildJsonOutput(projects: string[], snapshots: SnapshotMap): DashboardJson {
  const result: DashboardJson = {
    timestamp: new Date().toISOString(),
    projects: [],
  };

  for (const projectName of projects) {
    const snapshot = snapshots.get(projectName);
    if (!snapshot) continue;
    const { state } = snapshot;
    const workers: DashboardJson['projects'][0]['workers'] = [];

    for (const [slotName, slot] of Object.entries(state.workers)) {
      const isPrintMode = slot.mode === 'print';
      const isAcpMode = slot.mode === 'acp' || slot.mode === 'acp-sdk' || slot.transport === 'acp' || slot.transport === 'acp-sdk';
      const acpSession = state.sessions[slotName];
      const sessionAlive = isAcpMode
        ? isPersistedSessionAlive(slot, acpSession)
        : isPrintMode
          ? !!(slot.pid && slot.pid > 0 && isProcessAlive(slot.pid))
          : false;
      const panePreview = isAcpMode
        ? buildACPPanelLines(snapshot.ctx, slotName, slot, acpSession, sessionAlive).join(' | ')
        : '';
      const diagnostics = isAcpMode
        ? analyzeACPSession(snapshot.ctx, slotName, slot, acpSession, sessionAlive)
        : null;

      const projectedStatus = isAcpMode && !sessionAlive && slot.status !== 'idle'
        ? 'stale'
        : slot.status;

      workers.push({
        slot: slotName,
        status: projectedStatus,
        seq: slot.seq,
        branch: slot.branch,
        sessionAlive,
        claimedAt: slot.claimedAt,
        lastHeartbeat: slot.lastHeartbeat,
        processCpu: diagnostics?.process?.cpu ?? null,
        processState: diagnostics?.process?.state ?? null,
        lastOutputAgeSec: diagnostics?.lastOutputAgeSec ?? null,
        stalledReason: diagnostics?.stalledReason ?? null,
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

// ── Pending confirmations helper ─────────────────────────────────────

interface PendingItem {
  project: string;
  slot: string;
  prompt: string;
  options?: string[];
  dangerous?: boolean;
  transport: string;
  sessionName: string;
}

function collectPendingInputs(projects: string[]): PendingItem[] {
  const items: PendingItem[] = [];
  for (const projectName of projects) {
    let ctx: ProjectContext;
    try { ctx = ProjectContext.load(projectName); } catch { continue; }
    const state = readState(ctx.paths.stateFile, ctx.maxWorkers);
    const transport = ctx.config.raw.WORKER_TRANSPORT || 'acp';
    for (const [slotName, session] of Object.entries(state.sessions)) {
      if (!session.pendingInput) continue;
      items.push({
        project: projectName,
        slot: slotName,
        prompt: session.pendingInput.prompt,
        options: session.pendingInput.options,
        dangerous: session.pendingInput.dangerous,
        transport,
        sessionName: session.sessionName || `sps-acp-${projectName}-${slotName}`,
      });
    }
  }
  return items;
}

function sendResponse(item: PendingItem, response: string): boolean {
  try {
    // Send response via ACP runtime
    const ctx = ProjectContext.load(item.project);
    const { createAgentRuntime } = require('../providers/registry.js');
    const runtime = createAgentRuntime(ctx);
    // Fire and forget — dashboard is synchronous UI
    runtime.resumeRun(item.slot, response).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

// ── Live mode (watch) ────────────────────────────────────────────────

async function runLive(projects: string[], intervalMs: number): Promise<never> {
  // Switch to alternate screen buffer + hide cursor
  process.stdout.write('\x1b[?1049h\x1b[?25l');

  let inputMode = false;
  let inputBuffer = '';
  let statusMessage = '';

  const cleanup = () => {
    process.stdout.write('\x1b[?25h');   // show cursor
    process.stdout.write('\x1b[?1049l'); // switch back to main screen
    process.stdout.write('\x1b[0m');     // reset colors
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const draw = async () => {
    const snapshots = await loadSnapshots(projects);
    const { cols: termWidth } = getTerminalSize();
    const screen = renderDashboard(projects, snapshots);
    process.stdout.write('\x1b[H\x1b[J');
    process.stdout.write(screen);

    // Render pending list + input bar at bottom
    const pending = collectPendingInputs(projects);
    if (pending.length > 0) {
      process.stdout.write(`\n${FG.yellow}  Pending confirmations:${RESET}\n`);
      pending.forEach((p, i) => {
        const danger = p.dangerous ? `${FG.red} DANGEROUS${RESET}` : '';
        const opts = p.options ? ` [${p.options.map((o, j) => `${j + 1}=${o}`).join(', ')}]` : '';
        process.stdout.write(`  ${BOLD}${i + 1}.${RESET} ${p.project}/${p.slot}${danger}: ${p.prompt}${DIM}${opts}${RESET}\n`);
      });
    }

    if (inputMode) {
      process.stdout.write(`\n${FG.cyan}  > respond ${RESET}${inputBuffer}\x1b[?25h`); // show cursor in input mode
    } else if (statusMessage) {
      process.stdout.write(`\n  ${statusMessage}\n`);
    } else {
      const hint = pending.length > 0
        ? `${DIM}  :=respond  r=refresh  q=quit${RESET}`
        : `${DIM}  r=refresh  q=quit${RESET}`;
      process.stdout.write(`\n${hint}\n`);
    }
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (key: string) => {
      if (inputMode) {
        if (key === '\x1b') {
          // Escape — cancel input
          inputMode = false;
          inputBuffer = '';
          process.stdout.write('\x1b[?25l'); // hide cursor
          void draw();
          return;
        }
        if (key === '\r') {
          // Enter — execute command
          inputMode = false;
          process.stdout.write('\x1b[?25l'); // hide cursor
          const cmd = inputBuffer.trim();
          inputBuffer = '';

          // Parse: "<slot> <response>" or "<number> <response>"
          const parts = cmd.split(/\s+/);
          if (parts.length >= 2) {
            const pending = collectPendingInputs(projects);
            const target = parts[0];
            const response = parts.slice(1).join(' ');

            // Try by index (1-based)
            const idx = parseInt(target, 10);
            let item: PendingItem | undefined;
            if (!isNaN(idx) && idx >= 1 && idx <= pending.length) {
              item = pending[idx - 1];
            } else {
              // Try by slot name
              item = pending.find(p => p.slot === target || p.slot === `worker-${target}`);
            }

            if (item) {
              const ok = sendResponse(item, response);
              statusMessage = ok
                ? `${FG.green}  Sent "${response}" to ${item.project}/${item.slot}${RESET}`
                : `${FG.red}  Failed to send to ${item.project}/${item.slot}${RESET}`;
              // Clear status after 3s
              setTimeout(() => { statusMessage = ''; void draw(); }, 3000);
            } else {
              statusMessage = `${FG.red}  Target not found: ${target}${RESET}`;
              setTimeout(() => { statusMessage = ''; void draw(); }, 3000);
            }
          } else {
            statusMessage = `${FG.red}  Usage: <slot-or-number> <response>${RESET}`;
            setTimeout(() => { statusMessage = ''; void draw(); }, 3000);
          }
          void draw();
          return;
        }
        if (key === '\x7f') {
          // Backspace
          inputBuffer = inputBuffer.slice(0, -1);
          void draw();
          return;
        }
        // Regular character
        if (key.length === 1 && key.charCodeAt(0) >= 32) {
          inputBuffer += key;
          void draw();
          return;
        }
        return;
      }

      // Normal mode
      if (key === 'q' || key === '\x03') {
        cleanup();
      }
      if (key === 'r') {
        void draw();
      }
      if (key === ':') {
        const pending = collectPendingInputs(projects);
        if (pending.length > 0) {
          inputMode = true;
          inputBuffer = '';
          void draw();
        }
      }
    });
  }

  await draw();
  setInterval(() => { void draw(); }, intervalMs);

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
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), projects: [] }));
    } else {
      console.error('No projects found in ~/.coral/projects/');
    }
    process.exit(1);
  }

  const snapshots = await loadSnapshots(projects);

  if (jsonOutput) {
    console.log(JSON.stringify(buildJsonOutput(projects, snapshots), null, 2));
    return;
  }

  if (watch) {
    const intervalMs = parseInt(process.env.SPS_DASHBOARD_INTERVAL || '3000', 10);
    await runLive(projects, intervalMs);
  } else {
    console.log(renderDashboard(projects, snapshots));
  }
}
