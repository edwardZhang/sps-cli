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
import { createSessionContext } from '../core/sessionContext.js';
import { createSessionRuntime } from '../providers/registry.js';
import { waitAndStream } from './agentRenderer.js';
import type { ACPTool } from '../models/acp.js';

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';

function parseAgentArgs(argv: string[]): {
  subcommand: 'run' | 'chat' | 'status' | 'close';
  prompt: string;
  name: string;
  tool: ACPTool;
  cwd: string;
  json: boolean;
} {
  const flags: Record<string, string> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--chat') {
      flags.chat = 'true';
    } else if (arg === '--json') {
      flags.json = 'true';
    } else if (arg === '--tool' && i + 1 < argv.length) {
      flags.tool = argv[++i];
    } else if (arg === '--name' && i + 1 < argv.length) {
      flags.name = argv[++i];
    } else if (arg === '-s' && i + 1 < argv.length) {
      flags.name = argv[++i];
    } else if (arg === '--cwd' && i + 1 < argv.length) {
      flags.cwd = argv[++i];
    } else if (!arg.startsWith('-')) {
      positionals.push(arg);
    }
  }

  // Detect subcommand
  const first = positionals[0];
  if (first === 'status') {
    return { subcommand: 'status', prompt: '', name: flags.name || 'default', tool: (flags.tool || 'claude') as ACPTool, cwd: flags.cwd || process.cwd(), json: flags.json === 'true' };
  }
  if (first === 'close') {
    return { subcommand: 'close', prompt: '', name: flags.name || 'default', tool: (flags.tool || 'claude') as ACPTool, cwd: flags.cwd || process.cwd(), json: false };
  }

  const prompt = positionals.join(' ');
  const isChat = flags.chat === 'true' || !prompt;

  return {
    subcommand: isChat ? 'chat' : 'run',
    prompt,
    name: flags.name || 'default',
    tool: (flags.tool || 'claude') as ACPTool,
    cwd: flags.cwd || process.cwd(),
    json: flags.json === 'true',
  };
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
  if (args.subcommand === 'run') {
    await agentOneShot(args);
    return;
  }
  // chat
  await agentChat(args);
}

// ── One-shot mode ───────────────────────────────────────────────

async function agentOneShot(args: ReturnType<typeof parseAgentArgs>): Promise<void> {
  const ctx = createSessionContext({ cwd: args.cwd, tool: args.tool });
  const runtime = createSessionRuntime(ctx);
  const slot = `session-oneshot-${Date.now()}`;

  try {
    await runtime.ensureSession(slot, args.tool, args.cwd);
    await runtime.startRun(slot, args.prompt, args.tool, args.cwd);

    const result = await waitAndStream(runtime, slot);
    process.stdout.write('\n');

    if (result.status !== 'completed') {
      process.stderr.write(`${RED}Agent ${result.status}${RESET}\n`);
      process.exitCode = 1;
    }
  } finally {
    try { await runtime.stopSession(slot); } catch { /* cleanup */ }
  }
}

// ── Chat REPL mode ──────────────────────────────────────────────

async function agentChat(args: ReturnType<typeof parseAgentArgs>): Promise<void> {
  const ctx = createSessionContext({ cwd: args.cwd, tool: args.tool });
  const runtime = createSessionRuntime(ctx);
  const slot = `session-${args.name}`;

  await runtime.ensureSession(slot, args.tool, args.cwd);
  process.stderr.write(`${DIM}Session "${args.name}" started (${args.tool}) — type your messages, Ctrl+C to exit${RESET}\n\n`);

  // If initial prompt provided, run it first
  if (args.prompt) {
    await runTurn(runtime, slot, args);
  }

  // REPL loop
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    prompt: `${GREEN}>${RESET} `,
  });

  const cleanup = async () => {
    rl.close();
    process.stderr.write(`\n${DIM}Closing session...${RESET}\n`);
    try { await runtime.stopSession(slot); } catch { /* cleanup */ }
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

    await runTurn(runtime, slot, { ...args, prompt: input });
    rl.prompt();
  }

  await cleanup();
}

async function runTurn(
  runtime: Awaited<ReturnType<typeof createSessionRuntime>>,
  slot: string,
  args: ReturnType<typeof parseAgentArgs>,
): Promise<void> {
  try {
    await runtime.startRun(slot, args.prompt, args.tool, args.cwd);
    const result = await waitAndStream(runtime, slot);
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
    console.log(`${GREEN}Session "${args.name}" closed${RESET}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${RED}${msg}${RESET}`);
    process.exitCode = 1;
  }
}
