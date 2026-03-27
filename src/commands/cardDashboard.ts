import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPersistedSessionAlive } from '../core/sessionLiveness.js';
import { summarizeWorkerRuntime } from '../core/workerRuntimeSummary.js';
import type { Card, CardState } from '../models/types.js';
import type { TaskLease, WorktreeEvidence } from '../core/state.js';
import { loadRuntimeSnapshot } from '../core/runtimeSnapshot.js';
import { createTaskBackend } from '../providers/registry.js';

const HOME = process.env.HOME || '/home/coral';

const STATES: CardState[] = ['Planning', 'Backlog', 'Todo', 'Inprogress', 'QA', 'Done'];
const STATE_LABELS: Record<CardState, string> = {
  Planning: 'Planning',
  Backlog: 'Backlog',
  Todo: 'Todo',
  Inprogress: 'In Progress',
  QA: 'QA',
  Done: 'Done',
};

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

const STRIP_ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][AB012]|\x1b\[[\?]?[0-9;]*[hlm]/g;

interface CardSnapshot {
  seq: string;
  title: string;
  state: CardState;
  labels: string[];
  workerSlot: string | null;
  runtimeStatus: string | null;
  branch: string | null;
  blockedReason: string | null;
  updatedAt: string | null;
}

interface ProjectBoardSnapshot {
  project: string;
  displayName: string;
  cards: CardSnapshot[];
  counts: Record<CardState, number>;
  activeWorkers: number;
  mergingWorkers: number;
  staleWorkers: number;
  workingWorkers: number;
  waitingCards: number;
  conflictCards: number;
  error?: string;
}

interface DashboardJson {
  timestamp: string;
  projects: ProjectBoardSnapshot[];
}

function stripAnsi(text: string): string {
  return text.replace(STRIP_ANSI_RE, '');
}

function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

function padOrTruncate(text: string, width: number): string {
  const len = visibleLength(text);
  if (len > width) {
    let visible = 0;
    let result = '';
    let inEscape = false;
    for (const ch of text) {
      if (ch === '\x1b') {
        inEscape = true;
        result += ch;
        continue;
      }
      if (inEscape) {
        result += ch;
        if (/[a-zA-Z]/.test(ch)) inEscape = false;
        continue;
      }
      if (visible >= width - 1) {
        result += '…';
        break;
      }
      result += ch;
      visible++;
    }
    return result;
  }
  return text + ' '.repeat(width - len);
}

function centerText(text: string, width: number): string {
  const len = visibleLength(text);
  if (len >= width) return padOrTruncate(text, width);
  const left = Math.floor((width - len) / 2);
  return ' '.repeat(left) + text + ' '.repeat(width - len - left);
}

function stateColor(state: CardState): string {
  switch (state) {
    case 'Planning': return FG.gray;
    case 'Backlog': return FG.blue;
    case 'Todo': return FG.cyan;
    case 'Inprogress': return FG.green;
    case 'QA': return FG.yellow;
    case 'Done': return FG.white;
  }
}

function discoverProjects(): string[] {
  const projectsDir = resolve(HOME, '.coral', 'projects');
  if (!existsSync(projectsDir)) return [];
  try {
    return readdirSync(projectsDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && existsSync(resolve(projectsDir, entry.name, 'conf')))
      .map(entry => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function getTerminalSize(): { cols: number; rows: number } {
  return {
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 40,
  };
}

function wrapText(text: string, width: number, maxLines: number): string[] {
  const clean = stripAnsi(text).replace(/\s+/g, ' ').trim();
  if (!clean) return Array(maxLines).fill('');
  const words = clean.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length > maxLines) lines.length = maxLines;
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    const last = lines[maxLines - 1];
    lines[maxLines - 1] = last.length >= width ? `${last.slice(0, Math.max(0, width - 1))}…` : `${last.slice(0, Math.max(0, width - 1))}…`;
  }
  while (lines.length < maxLines) lines.push('');
  return lines.map(line => padOrTruncate(line, width));
}

function labelSummary(labels: string[]): string {
  const filtered = labels.filter(label => !['AI-PIPELINE', 'CLAIMED'].includes(label));
  if (filtered.length === 0) return 'AI-PIPELINE';
  return filtered.slice(0, 2).join(', ');
}

function deriveBlockedReason(
  labels: string[],
  runtimeStatus: string | null,
  lease: TaskLease | null,
  evidence: WorktreeEvidence | null,
): string | null {
  if (labels.includes('CONFLICT')) return 'CONFLICT';
  if (labels.includes('WAITING-CONFIRMATION') || runtimeStatus === 'waiting_input' || runtimeStatus === 'needs_confirmation') return 'WAITING';
  if (lease?.phase === 'suspended' && (evidence?.worktreeExists || evidence?.branchExists)) return 'RESUMABLE';
  if (runtimeStatus === 'stale') return 'STALE';
  if (labels.includes('NEEDS-FIX')) return 'NEEDS-FIX';
  if (labels.includes('STALE-RUNTIME')) return 'STALE';
  return null;
}

async function buildProjectBoard(projectName: string): Promise<ProjectBoardSnapshot> {
  try {
    const snapshot = await loadRuntimeSnapshot(projectName);
    const { ctx, state } = snapshot;
    const taskBackend = createTaskBackend(ctx.config);
    const cards = await taskBackend.listAll();
    const snapshots: CardSnapshot[] = cards.map(card => {
      const active = state.activeCards[card.seq];
      const lease = state.leases[card.seq] || null;
      const evidence = state.worktreeEvidence[card.seq] || null;
      const workerSlot = active?.worker ?? null;
      const worker = workerSlot ? state.workers[workerSlot] : null;
      const session = workerSlot ? state.sessions[workerSlot] : null;
      const runtimeOwned = !!worker && worker.status !== 'idle';
      const effectiveState = runtimeOwned ? ((active?.state as CardState | undefined) || card.state) : card.state;
      const sessionAlive = worker ? isPersistedSessionAlive(worker, session) : false;
      const runtimeStatus = !runtimeOwned
        ? null
        : worker?.status === 'active' && worker && !sessionAlive
        ? 'stale'
        : session?.pendingInput
          ? (session.pendingInput.type === 'input' ? 'waiting_input' : 'needs_confirmation')
          : session?.currentRun?.status || worker?.remoteStatus || (worker?.status === 'active' ? 'running' : null);
      const blockedReason = deriveBlockedReason(card.labels, runtimeStatus, lease, evidence);
      return {
        seq: card.seq,
        title: card.name,
        state: effectiveState,
        labels: card.labels,
        workerSlot: runtimeOwned ? workerSlot : null,
        runtimeStatus,
        branch: runtimeOwned ? (worker?.branch || null) : null,
        blockedReason,
        updatedAt: runtimeOwned ? (session?.updatedAt || worker?.lastHeartbeat || active?.startedAt || null) : null,
      };
    }).sort((a, b) => parseInt(a.seq, 10) - parseInt(b.seq, 10));

    const counts = Object.fromEntries(STATES.map(stateName => [stateName, 0])) as Record<CardState, number>;
    for (const card of snapshots) counts[card.state] += 1;

    const workerSummary = summarizeWorkerRuntime(state);

    const waitingCards = snapshots.filter(card => ['waiting_input', 'needs_confirmation'].includes(card.runtimeStatus || '') || card.blockedReason === 'WAITING').length;
    const conflictCards = snapshots.filter(card => card.blockedReason === 'CONFLICT').length;

    return {
      project: projectName,
      displayName: ctx.config.PROJECT_NAME || projectName,
      cards: snapshots,
      counts,
      activeWorkers: workerSummary.active,
      mergingWorkers: workerSummary.merging,
      staleWorkers: workerSummary.stale,
      workingWorkers: workerSummary.working,
      waitingCards,
      conflictCards,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const counts = Object.fromEntries(STATES.map(state => [state, 0])) as Record<CardState, number>;
    return {
      project: projectName,
      displayName: projectName,
      cards: [],
      counts,
      activeWorkers: 0,
      mergingWorkers: 0,
      staleWorkers: 0,
      workingWorkers: 0,
      waitingCards: 0,
      conflictCards: 0,
      error: msg,
    };
  }
}

async function buildSnapshot(projects: string[]): Promise<ProjectBoardSnapshot[]> {
  return Promise.all(projects.map(project => buildProjectBoard(project)));
}

function renderHeader(termWidth: number): string[] {
  const title = ' SPS Card Dashboard ';
  const now = new Date().toLocaleTimeString();
  const right = `${DIM}${now}  q=quit  r=refresh${RESET}`;
  return [
    `${BOLD}${FG.cyan}${'─'.repeat(termWidth)}${RESET}`,
    `${centerText(`${BOLD}${FG.cyan}${title}${RESET}`, termWidth - visibleLength(right))}${right}`,
    `${BOLD}${FG.cyan}${'─'.repeat(termWidth)}${RESET}`,
  ];
}

function renderProjectSummary(board: ProjectBoardSnapshot): string {
  const parts = [
    `${FG.green}${board.activeWorkers} active${RESET}`,
    `${FG.yellow}${board.mergingWorkers} merging${RESET}`,
    `${FG.red}${board.staleWorkers} stale${RESET}`,
    `${FG.cyan}${board.cards.length} cards${RESET}`,
  ];
  if (board.waitingCards > 0) parts.push(`${FG.yellow}${board.waitingCards} waiting${RESET}`);
  if (board.conflictCards > 0) parts.push(`${FG.red}${board.conflictCards} conflict${RESET}`);
  return `  ${BOLD}${board.displayName}${RESET}: ${parts.join(` ${DIM}│${RESET} `)}`;
}

function renderCardTile(card: CardSnapshot, width: number): string[] {
  const innerWidth = width - 2;
  const titleLines = wrapText(`#${card.seq} ${card.title}`, innerWidth, 2);
  const labelLine = padOrTruncate(`${DIM}${labelSummary(card.labels)}${RESET}`, innerWidth);
  let statusLine = '';
  if (card.blockedReason) {
    statusLine = `${FG.red}${card.blockedReason}${RESET}`;
  } else if (card.workerSlot && card.runtimeStatus) {
    statusLine = `${FG.green}${card.workerSlot}${RESET} ${DIM}${card.runtimeStatus}${RESET}`;
  } else if (card.runtimeStatus) {
    statusLine = `${DIM}${card.runtimeStatus}${RESET}`;
  } else {
    statusLine = `${DIM}${card.state}${RESET}`;
  }

  return [
    `${FG.gray}╭${'─'.repeat(width - 2)}╮${RESET}`,
    `${FG.gray}│${RESET}${titleLines[0]}${FG.gray}│${RESET}`,
    `${FG.gray}│${RESET}${titleLines[1]}${FG.gray}│${RESET}`,
    `${FG.gray}│${RESET}${labelLine}${FG.gray}│${RESET}`,
    `${FG.gray}│${RESET}${padOrTruncate(statusLine, innerWidth)}${FG.gray}│${RESET}`,
    `${FG.gray}╰${'─'.repeat(width - 2)}╯${RESET}`,
  ];
}

function renderColumn(board: ProjectBoardSnapshot, state: CardState, width: number, height: number): string[] {
  const title = `${stateColor(state)}${STATE_LABELS[state]} (${board.counts[state]})${RESET}`;
  const lines: string[] = [
    `${FG.gray}┌${'─'.repeat(width - 2)}┐${RESET}`,
    `${FG.gray}│${RESET}${padOrTruncate(title, width - 2)}${FG.gray}│${RESET}`,
    `${FG.gray}├${'─'.repeat(width - 2)}┤${RESET}`,
  ];
  const cards = board.cards.filter(card => card.state === state);
  const available = height - lines.length - 1;
  const tileHeight = 7;
  const maxTiles = Math.max(0, Math.floor(available / tileHeight));
  const visibleCards = cards.slice(0, maxTiles);
  const tileWidth = Math.max(14, width - 4);

  for (const card of visibleCards) {
    const tileLines = renderCardTile(card, tileWidth);
    for (const tileLine of tileLines) {
      lines.push(`${FG.gray}│${RESET} ${padOrTruncate(tileLine, width - 4)} ${FG.gray}│${RESET}`);
    }
  }

  const remaining = cards.length - visibleCards.length;
  const fillerTarget = height - 1;
  if (remaining > 0 && lines.length < fillerTarget) {
    lines.push(`${FG.gray}│${RESET}${padOrTruncate(`${DIM}+${remaining} more${RESET}`, width - 2)}${FG.gray}│${RESET}`);
  }
  while (lines.length < fillerTarget) {
    lines.push(`${FG.gray}│${RESET}${' '.repeat(width - 2)}${FG.gray}│${RESET}`);
  }
  lines.push(`${FG.gray}└${'─'.repeat(width - 2)}┘${RESET}`);
  return lines;
}

function renderSingleProject(board: ProjectBoardSnapshot, termWidth: number, termHeight: number): string {
  const output: string[] = [];
  output.push(...renderHeader(termWidth));
  output.push('');
  output.push(centerText(`${BOLD}${board.displayName}${RESET}`, termWidth));
  output.push('');
  output.push(renderProjectSummary(board));
  output.push('');

  const gridCols = termWidth >= 150 ? 6 : 3;
  const rows = Math.ceil(STATES.length / gridCols);
  const colWidth = Math.max(22, Math.floor((termWidth - (gridCols - 1)) / gridCols));
  const availableRows = Math.max(12, termHeight - output.length - 2);
  const panelHeight = Math.max(10, Math.floor(availableRows / rows));

  for (let row = 0; row < rows; row++) {
    const rowColumns: string[][] = [];
    for (let col = 0; col < gridCols; col++) {
      const idx = row * gridCols + col;
      if (idx < STATES.length) {
        rowColumns.push(renderColumn(board, STATES[idx], colWidth, panelHeight));
      } else {
        rowColumns.push(Array(panelHeight).fill(' '.repeat(colWidth)));
      }
    }
    for (let lineIdx = 0; lineIdx < panelHeight; lineIdx++) {
      output.push(rowColumns.map(column => column[lineIdx] ?? ' '.repeat(colWidth)).join(' '));
    }
    output.push('');
  }

  output.push(`${DIM}  r=refresh  q=quit${RESET}`);
  if (output.length > termHeight) output.length = termHeight;
  return output.join('\n');
}

function compactStateRow(board: ProjectBoardSnapshot, states: CardState[]): string {
  return states
    .map(state => `${stateColor(state)}${STATE_LABELS[state].replace('In Progress', 'Progress')}:${board.counts[state]}${RESET}`)
    .join(` ${DIM}│${RESET} `);
}

function renderMiniProject(board: ProjectBoardSnapshot, width: number, height: number): string[] {
  const lines: string[] = [];
  lines.push(`${FG.gray}┌${'─'.repeat(width - 2)}┐${RESET}`);
  lines.push(`${FG.gray}│${RESET}${padOrTruncate(`${BOLD}${board.displayName}${RESET}`, width - 2)}${FG.gray}│${RESET}`);
  lines.push(`${FG.gray}├${'─'.repeat(width - 2)}┤${RESET}`);

  if (board.error) {
    lines.push(`${FG.gray}│${RESET}${padOrTruncate(`${FG.red}${board.error}${RESET}`, width - 2)}${FG.gray}│${RESET}`);
  } else {
    const summary = [
      `${FG.green}${board.activeWorkers} active${RESET}`,
      `${FG.yellow}${board.mergingWorkers} merging${RESET}`,
      `${FG.red}${board.staleWorkers} stale${RESET}`,
      `${FG.cyan}${board.cards.length} cards${RESET}`,
    ].join(` ${DIM}│${RESET} `);
    lines.push(`${FG.gray}│${RESET}${padOrTruncate(summary, width - 2)}${FG.gray}│${RESET}`);
    lines.push(`${FG.gray}│${RESET}${padOrTruncate(compactStateRow(board, ['Planning', 'Backlog', 'Todo']), width - 2)}${FG.gray}│${RESET}`);
    lines.push(`${FG.gray}│${RESET}${padOrTruncate(compactStateRow(board, ['Inprogress', 'QA', 'Done']), width - 2)}${FG.gray}│${RESET}`);
    const hotCards = board.cards
      .filter(card => card.blockedReason || ['running', 'waiting_input', 'needs_confirmation', 'stalled_submit'].includes(card.runtimeStatus || ''))
      .slice(0, 2)
      .map(card => `#${card.seq} ${card.blockedReason || card.runtimeStatus}`)
      .join(' · ');
    lines.push(`${FG.gray}│${RESET}${padOrTruncate(hotCards ? `${DIM}${hotCards}${RESET}` : `${DIM}No hot cards${RESET}`, width - 2)}${FG.gray}│${RESET}`);
  }

  while (lines.length < height - 1) {
    lines.push(`${FG.gray}│${RESET}${' '.repeat(width - 2)}${FG.gray}│${RESET}`);
  }
  lines.push(`${FG.gray}└${'─'.repeat(width - 2)}┘${RESET}`);
  return lines;
}

function renderMultiProject(boards: ProjectBoardSnapshot[], termWidth: number, termHeight: number): string {
  const output: string[] = [];
  output.push(...renderHeader(termWidth));
  output.push('');
  output.push(`${DIM}  Multi-project compact board view${RESET}`);
  output.push('');

  const cols = boards.length <= 2 ? boards.length : boards.length <= 4 ? 2 : 3;
  const rows = Math.ceil(boards.length / cols);
  const panelWidth = Math.max(30, Math.floor((termWidth - (cols - 1)) / cols));
  const availableRows = Math.max(10, termHeight - output.length - 2);
  const panelHeight = Math.max(8, Math.floor(availableRows / rows));

  for (let row = 0; row < rows; row++) {
    const rowPanels: string[][] = [];
    for (let col = 0; col < cols; col++) {
      const idx = row * cols + col;
      if (idx < boards.length) rowPanels.push(renderMiniProject(boards[idx], panelWidth, panelHeight));
      else rowPanels.push(Array(panelHeight).fill(' '.repeat(panelWidth)));
    }
    for (let line = 0; line < panelHeight; line++) {
      output.push(rowPanels.map(panel => panel[line] ?? ' '.repeat(panelWidth)).join(' '));
    }
    output.push('');
  }

  output.push(`${DIM}  r=refresh  q=quit${RESET}`);
  if (output.length > termHeight) output.length = termHeight;
  return output.join('\n');
}

function renderDashboard(boards: ProjectBoardSnapshot[]): string {
  const { cols, rows } = getTerminalSize();
  if (boards.length === 1) return renderSingleProject(boards[0], cols, rows);
  return renderMultiProject(boards, cols, rows);
}

async function runLive(projects: string[], intervalMs: number): Promise<never> {
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  let drawing = false;

  const cleanup = () => {
    process.stdout.write('\x1b[?25h');
    process.stdout.write('\x1b[?1049l');
    process.stdout.write('\x1b[0m');
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  const draw = async () => {
    if (drawing) return;
    drawing = true;
    try {
      const boards = await buildSnapshot(projects);
      process.stdout.write('\x1b[H\x1b[J');
      process.stdout.write(renderDashboard(boards));
    } finally {
      drawing = false;
    }
  };

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (key: string) => {
      if (key === 'q' || key === '\x03') cleanup();
      if (key === 'r') void draw();
    });
  }

  await draw();
  setInterval(() => { void draw(); }, intervalMs);
  return new Promise(() => {});
}

export async function executeCardDashboard(
  projects: string[],
  flags: Record<string, boolean>,
): Promise<void> {
  const jsonOutput = !!flags.json;
  const watch = !flags.once;

  if (projects.length === 0) projects = discoverProjects();
  if (projects.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ timestamp: new Date().toISOString(), projects: [] }, null, 2));
    } else {
      console.error('No projects found in ~/.coral/projects/');
    }
    process.exit(1);
  }

  const boards = await buildSnapshot(projects);
  if (jsonOutput) {
    const payload: DashboardJson = {
      timestamp: new Date().toISOString(),
      projects: boards,
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  if (watch) {
    const intervalMs = parseInt(process.env.SPS_CARD_DASHBOARD_INTERVAL || '5000', 10);
    await runLive(projects, intervalMs);
    return;
  }

  console.log(renderDashboard(boards));
}
