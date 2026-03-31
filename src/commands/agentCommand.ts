/**
 * sps agent — Harness mode: direct agent interaction without project config.
 *
 * Usage:
 *   sps agent "<prompt>"                    # one-shot
 *   sps agent --chat                        # multi-turn REPL
 *   sps agent --chat --name backend         # named session
 *   sps agent --tool codex "<prompt>"       # specify agent
 *   sps agent status                        # show sessions
 *   sps agent close [--name NAME]           # close session
 */
import * as readline from 'node:readline/promises';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createSessionContext } from '../core/sessionContext.js';
import { readState, writeState } from '../core/state.js';
import { createSessionRuntime } from '../providers/registry.js';
import { waitAndStream } from './agentRenderer.js';
import { loadAgentRegistry } from '../providers/adapters/AcpSdkAdapter.js';
import type { ACPTool } from '../models/acp.js';

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';

function parseAgentArgs(argv: string[]): {
  subcommand: 'run' | 'chat' | 'status' | 'close' | 'list' | 'add';
  prompt: string;
  name: string;
  tool: ACPTool;
  cwd: string;
  json: boolean;
  verbose: boolean;
  context: string[];
  system: string;
  profile: string;
  output: string;
} {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];
  const contextFiles: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--chat') {
      flags.chat = 'true';
    } else if (arg === '--json') {
      flags.json = 'true';
    } else if (arg === '--verbose' || arg === '-v') {
      flags.verbose = 'true';
    } else if (arg === '--tool' && i + 1 < argv.length) {
      flags.tool = argv[++i];
    } else if (arg === '--name' && i + 1 < argv.length) {
      flags.name = argv[++i];
    } else if (arg === '-s' && i + 1 < argv.length) {
      flags.name = argv[++i];
    } else if (arg === '--cwd' && i + 1 < argv.length) {
      flags.cwd = argv[++i];
    } else if (arg === '--context' && i + 1 < argv.length) {
      contextFiles.push(argv[++i]);
    } else if (arg === '--system' && i + 1 < argv.length) {
      flags.system = argv[++i];
    } else if (arg === '--profile' && i + 1 < argv.length) {
      flags.profile = argv[++i];
    } else if ((arg === '--output' || arg === '-o') && i + 1 < argv.length) {
      flags.output = argv[++i];
    } else if (!arg.startsWith('-')) {
      positionals.push(arg);
    }
  }

  // Detect subcommand
  const first = positionals[0];
  const common = {
    name: flags.name || 'default',
    tool: (flags.tool || 'claude') as ACPTool,
    cwd: flags.cwd || process.cwd(),
    verbose: flags.verbose === 'true',
    context: contextFiles,
    system: flags.system || '',
    profile: flags.profile || '',
    output: flags.output || '',
  };

  if (first === 'status') {
    return { subcommand: 'status', prompt: '', json: flags.json === 'true', ...common };
  }
  if (first === 'close') {
    return { subcommand: 'close', prompt: '', json: false, ...common };
  }
  if (first === 'list') {
    return { subcommand: 'list', prompt: '', json: flags.json === 'true', ...common };
  }
  if (first === 'add') {
    // sps agent add <name> <command> [args...]
    return { subcommand: 'add', prompt: positionals.slice(1).join(' '), json: false, ...common };
  }

  // Typo protection: if first word looks like a misspelled subcommand, warn
  const KNOWN_SUBS = ['status', 'close', 'list', 'add', 'daemon'];
  if (first && !first.includes(' ') && first.length < 12) {
    for (const sub of KNOWN_SUBS) {
      if (first !== sub && levenshtein(first, sub) <= 2) {
        process.stderr.write(`${YELLOW}Did you mean: sps agent ${sub}?${RESET}\n`);
        process.stderr.write(`${DIM}("${first}" was treated as a prompt. Use Ctrl+C to cancel.)${RESET}\n\n`);
        break;
      }
    }
  }

  const prompt = positionals.join(' ');
  const isChat = flags.chat === 'true' || !prompt;

  return {
    subcommand: isChat ? 'chat' : 'run',
    prompt,
    json: flags.json === 'true',
    ...common,
  };
}

/** Simple Levenshtein distance for typo detection. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Load a profile from profiles/ directory. Searches dist/profiles/ then cwd. */
function loadProfile(name: string): string | null {
  const candidates = [
    // Installed package profiles
    resolve(import.meta.url.replace('file://', '').replace(/\/commands\/agentCommand\.js$/, ''), '..', 'profiles', `${name}.md`),
    // CWD profiles
    resolve(process.cwd(), 'profiles', `${name}.md`),
    // Direct path
    name,
  ];
  for (const p of candidates) {
    try {
      return readFileSync(p, 'utf-8');
    } catch { /* try next */ }
  }
  process.stderr.write(`${DIM}Warning: profile "${name}" not found${RESET}\n`);
  return null;
}

/** Build final prompt with optional system instruction, profile, and file context. */
function buildPrompt(userPrompt: string, contextFiles: string[], system: string, profile?: string): string {
  const parts: string[] = [];

  // Load profile as system prompt
  if (profile) {
    const profileContent = loadProfile(profile);
    if (profileContent) {
      parts.push(`[System instruction from profile: ${profile}]\n${profileContent}\n`);
    }
  }

  if (system) {
    parts.push(`[System instruction] ${system}\n`);
  }

  if (contextFiles.length > 0) {
    for (const file of contextFiles) {
      try {
        const filePath = resolve(file);
        const content = readFileSync(filePath, 'utf-8');
        parts.push(`[File: ${file}]\n\`\`\`\n${content}\n\`\`\`\n`);
      } catch {
        parts.push(`[File: ${file}] (could not read)\n`);
      }
    }
  }

  parts.push(userPrompt);
  return parts.join('\n');
}

export async function executeAgentCommand(argv: string[]): Promise<void> {
  const args = parseAgentArgs(argv);

  if (args.subcommand === 'status') {
    await agentStatus(args);
    return;
  }
  if (args.subcommand === 'close') {
    await agentClose(args);
    return;
  }
  if (args.subcommand === 'list') {
    agentList(args);
    return;
  }
  if (args.subcommand === 'add') {
    agentAdd(args);
    return;
  }
  if (args.subcommand === 'run') {
    await agentOneShot(args);
    return;
  }
  // chat
  await agentChat(args);
}

// ── One-shot mode ───────────────────────────────────────────────

async function agentOneShot(args: ReturnType<typeof parseAgentArgs>): Promise<void> {
  // Named sessions route through daemon for cross-invocation persistence
  if (args.name !== 'default') {
    return agentNamedOneShot(args);
  }

  const ctx = createSessionContext({ cwd: args.cwd, tool: args.tool });
  const runtime = createSessionRuntime(ctx);
  const slot = `session-oneshot-${Date.now()}`;

  try {
    await runtime.ensureSession(slot, args.tool, args.cwd);
    const prompt = buildPrompt(args.prompt, args.context, args.system, args.profile);
    await runtime.startRun(slot, prompt, args.tool, args.cwd);

    const result = await waitAndStream(runtime, slot, {
      stateFile: ctx.paths.stateFile,
      verbose: args.verbose,
      logsDir: ctx.paths.logsDir,
    });
    process.stdout.write('\n');

    // Write output to file if --output specified
    if (args.output && result.output) {
      writeFileSync(resolve(args.output), result.output, 'utf-8');
      process.stderr.write(`${DIM}Output saved to ${args.output}${RESET}\n`);
    }

    if (result.status !== 'completed') {
      process.stderr.write(`${RED}Agent ${result.status}${RESET}\n`);
      process.exitCode = 1;
    }
  } finally {
    // Get PID before cleaning state
    let sessionPid: number | null = null;
    try {
      const state = readState(ctx.paths.stateFile, 0);
      sessionPid = state.sessions?.[slot]?.pid ?? null;
      if (state.sessions?.[slot]) {
        delete state.sessions[slot];
        writeState(ctx.paths.stateFile, state, 'agent-oneshot-cleanup');
      }
    } catch { /* best effort */ }
    // Kill process tree by PID, then exit
    if (sessionPid) {
      try {
        const { execFileSync } = await import('node:child_process');
        // Kill all descendants first
        try {
          const children = execFileSync('pgrep', ['-P', String(sessionPid)], { encoding: 'utf-8', timeout: 2000 })
            .trim().split('\n').filter(Boolean).map(Number);
          for (const p of children) { try { process.kill(p, 'SIGKILL'); } catch { /* noop */ } }
        } catch { /* no children */ }
        try { process.kill(sessionPid, 'SIGKILL'); } catch { /* already dead */ }
      } catch { /* noop */ }
    }
    process.exit(process.exitCode ?? 0);
  }
}

// ── Named one-shot (via daemon, session persists) ───────────────

async function agentNamedOneShot(args: ReturnType<typeof parseAgentArgs>): Promise<void> {
  process.stderr.write(`${DIM}[debug] agentNamedOneShot: entering${RESET}\n`);
  const ctx = createSessionContext({ cwd: args.cwd, tool: args.tool });
  const { DaemonClient } = await import('../daemon/daemonClient.js');
  const { ensureDaemon } = await import('./agentDaemon.js');
  const client = new DaemonClient();

  if (!(await client.isRunning())) {
    if (process.env.SPS_DAEMON_SOCKET) {
      // Remote mode — don't auto-start local daemon
      process.stderr.write(`${RED}Cannot connect to remote daemon at ${process.env.SPS_DAEMON_SOCKET}${RESET}\n`);
      process.exit(1);
    }
    await ensureDaemon();
  }

  const slot = `session-${args.name}`;
  const stateFile = ctx.paths.stateFile;

  await client.ensureSession(slot, args.tool, args.cwd);
  const prompt = buildPrompt(args.prompt, args.context, args.system, args.profile);
  await client.startRun(slot, prompt, args.tool, args.cwd);

  const result = await waitAndStream(
    { inspect: (s?: string) => client.inspect(s) } as any,
    slot,
    { stateFile, verbose: args.verbose, logsDir: ctx.paths.logsDir },
  );
  process.stdout.write('\n');

  if (args.output && result.output) {
    writeFileSync(resolve(args.output), result.output, 'utf-8');
    process.stderr.write(`${DIM}Output saved to ${args.output}${RESET}\n`);
  }

  if (result.status !== 'completed') {
    process.stderr.write(`${RED}Agent ${result.status}${RESET}\n`);
    process.exitCode = 1;
  }
  // Don't stop session — daemon keeps it for future calls
  process.exit(process.exitCode ?? 0);
}

// ── Chat REPL mode ──────────────────────────────────────────────

async function agentChat(args: ReturnType<typeof parseAgentArgs>): Promise<void> {
  const ctx = createSessionContext({ cwd: args.cwd, tool: args.tool });
  const slot = `session-${args.name}`;
  const stateFile = ctx.paths.stateFile;

  // Try daemon mode: auto-start daemon if not running
  const { DaemonClient } = await import('../daemon/daemonClient.js');
  const { ensureDaemon } = await import('./agentDaemon.js');
  const client = new DaemonClient();
  let useDaemon = await client.isRunning();

  if (!useDaemon) {
    if (process.env.SPS_DAEMON_SOCKET) {
      process.stderr.write(`${RED}Cannot connect to remote daemon at ${process.env.SPS_DAEMON_SOCKET}${RESET}\n`);
      process.exit(1);
    }
    useDaemon = await ensureDaemon();
  }

  // Create session (daemon or local)
  let runtime: Awaited<ReturnType<typeof createSessionRuntime>> | null = null;
  if (useDaemon) {
    await client.ensureSession(slot, args.tool, args.cwd);
    process.stderr.write(`${DIM}Session "${args.name}" started via daemon (${args.tool}) — type your messages, Ctrl+C to exit${RESET}\n\n`);
  } else {
    runtime = createSessionRuntime(ctx);
    await runtime.ensureSession(slot, args.tool, args.cwd);
    process.stderr.write(`${DIM}Session "${args.name}" started (${args.tool}) — type your messages, Ctrl+C to exit${RESET}\n\n`);
  }

  // Unified turn runner
  const turn = async (prompt: string) => {
    const fullPrompt = buildPrompt(prompt, args.context, args.system, args.profile);
    if (useDaemon) {
      await client.startRun(slot, fullPrompt, args.tool, args.cwd);
      // Poll daemon's state.json for output
      await waitAndStream(
        { inspect: (s?: string) => client.inspect(s) } as any,
        slot,
        { stateFile, verbose: args.verbose, logsDir: ctx.paths.logsDir },
      );
    } else {
      await runtime!.startRun(slot, fullPrompt, args.tool, args.cwd);
      await waitAndStream(runtime!, slot, {
        stateFile, verbose: args.verbose, logsDir: ctx.paths.logsDir,
      });
    }
    process.stdout.write('\n\n');
  };

  // If initial prompt provided, run it first
  if (args.prompt) {
    await turn(args.prompt);
  }

  // REPL loop
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: `${GREEN}>${RESET} `,
  });

  const cleanup = async () => {
    rl.close();
    process.stderr.write(`\n${DIM}Detaching from session (daemon keeps it alive)...${RESET}\n`);
    // Don't stop session — daemon keeps it alive
    // Only stop if running locally (no daemon)
    if (!useDaemon && runtime) {
      try { await runtime.stopSession(slot); } catch { /* cleanup */ }
    }
    process.exit(0);
  };

  process.on('SIGINT', () => { cleanup(); });

  rl.prompt();
  for await (const line of rl) {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      continue;
    }
    if (input === '/exit' || input === '/quit') {
      await cleanup();
      return;
    }
    if (input === '/close') {
      // Explicitly close session
      if (useDaemon) {
        try { await client.stopSession(slot); } catch { /* noop */ }
      } else if (runtime) {
        try { await runtime.stopSession(slot); } catch { /* noop */ }
      }
      process.stderr.write(`${DIM}Session closed.${RESET}\n`);
      process.exit(0);
    }

    try {
      await turn(input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${RED}Error: ${msg}${RESET}\n`);
    }
    rl.prompt();
  }

  await cleanup();
}

async function runTurn(
  runtime: Awaited<ReturnType<typeof createSessionRuntime>>,
  slot: string,
  args: ReturnType<typeof parseAgentArgs>,
  stateFile?: string,
  logsDir?: string,
): Promise<void> {
  try {
    const prompt = buildPrompt(args.prompt, args.context, args.system, args.profile);
    await runtime.startRun(slot, prompt, args.tool, args.cwd);
    const result = await waitAndStream(runtime, slot, {
      stateFile, verbose: args.verbose, logsDir,
    });
    process.stdout.write('\n\n');

    if (result.status !== 'completed') {
      process.stderr.write(`${DIM}(${result.status})${RESET}\n`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${RED}Error: ${msg}${RESET}\n`);
  }
}

// ── Status ──────────────────────────────────────────────────────

async function agentStatus(args: ReturnType<typeof parseAgentArgs>): Promise<void> {
  const ctx = createSessionContext({ cwd: args.cwd, tool: args.tool });
  const runtime = createSessionRuntime(ctx);

  try {
    const state = await runtime.inspect();
    const sessions = Object.entries(state.sessions);

    if (args.json) {
      console.log(JSON.stringify(state.sessions, null, 2));
      return;
    }

    if (sessions.length === 0) {
      console.log(`${DIM}No active sessions${RESET}`);
      return;
    }

    for (const [name, session] of sessions) {
      const run = session.currentRun;
      const runInfo = run ? `${run.status} "${run.promptPreview}"` : 'idle';
      console.log(`  ${name} ${session.tool} ${session.sessionState} — ${runInfo}`);
    }
  } catch {
    console.log(`${DIM}No active sessions${RESET}`);
  }
}

// ── Close ───────────────────────────────────────────────────────

async function agentClose(args: ReturnType<typeof parseAgentArgs>): Promise<void> {
  const ctx = createSessionContext({ cwd: args.cwd, tool: args.tool });
  const runtime = createSessionRuntime(ctx);
  const slot = `session-${args.name}`;

  try {
    await runtime.stopSession(slot);
  } catch { /* session may not exist in runtime */ }

  // Remove from state.json
  try {
    const state = readState(ctx.paths.stateFile, 0);
    if (state.sessions?.[slot]) {
      delete state.sessions[slot];
      writeState(ctx.paths.stateFile, state, 'agent-close');
    }
    console.log(`${GREEN}Session "${args.name}" closed${RESET}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${RED}${msg}${RESET}`);
    process.exitCode = 1;
  }
}

// ── List ─────────────────────────────────────────────────────────

function agentList(args: ReturnType<typeof parseAgentArgs>): void {
  const registry = loadAgentRegistry();

  if (args.json) {
    console.log(JSON.stringify(registry, null, 2));
    return;
  }

  console.log(`\n  Available agents:\n`);
  for (const [name, entry] of Object.entries(registry)) {
    const cmd = `${entry.command} ${entry.args.join(' ')}`.trim();
    const isBuiltin = ['claude', 'codex', 'gemini'].includes(name);
    const tag = isBuiltin ? DIM + '(builtin)' + RESET : GREEN + '(custom)' + RESET;
    console.log(`  ${name.padEnd(12)} ${cmd}  ${tag}`);
  }
  console.log('');
}

// ── Add ──────────────────────────────────────────────────────────

function agentAdd(args: ReturnType<typeof parseAgentArgs>): void {
  // prompt contains: "<name> <command> [args...]"
  const parts = args.prompt.split(/\s+/);
  const name = parts[0];
  const command = parts[1];
  const cmdArgs = parts.slice(2);

  if (!name || !command) {
    console.error('Usage: sps agent add <name> <command> [args...]');
    console.error('Example: sps agent add cursor "cursor-agent" acp');
    process.exitCode = 1;
    return;
  }

  const home = process.env.HOME || '/home/coral';
  const agentsFile = resolve(home, '.coral', 'agents.json');

  let existing: Record<string, { command: string; args: string[] }> = {};
  try {
    existing = JSON.parse(readFileSync(agentsFile, 'utf-8'));
  } catch { /* new file */ }

  existing[name] = { command, args: cmdArgs };

  mkdirSync(resolve(home, '.coral'), { recursive: true });
  writeFileSync(agentsFile, JSON.stringify(existing, null, 2) + '\n');
  console.log(`${GREEN}Agent "${name}" registered: ${command} ${cmdArgs.join(' ')}${RESET}`);
}
