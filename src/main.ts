#!/usr/bin/env node
/**
 * @module        main
 * @description   SPS CLI 入口文件，注册全局错误处理与命令行解析
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-19
 * @updated       2026-04-03
 *
 * @role          entry
 * @layer         entry
 * @boundedContext cli
 */

// Global error handlers — catch unhandled rejections and uncaught exceptions
process.on('unhandledRejection', (reason) => {
  process.stderr.write(`[sps] Unhandled rejection: ${reason instanceof Error ? reason.stack || reason.message : String(reason)}\n`);
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  process.stderr.write(`[sps] Uncaught exception: ${err.stack || err.message}\n`);
  process.exit(1);
});

// Polyfill fetch for Node.js < 18.13 where it's not globally available.
if (typeof globalThis.fetch === 'undefined') {
  try {
    // Node 16.15+ / 18+ have undici bundled; use it as polyfill
    const { createRequire: _cr } = await import('node:module');
    const _req = _cr(import.meta.url);
    const undici = _req('undici') as Record<string, unknown>;
    Object.assign(globalThis, {
      fetch: undici.fetch,
      Request: undici.Request,
      Response: undici.Response,
      Headers: undici.Headers,
    });
  } catch {
    process.stderr.write(
      'Warning: fetch is not available. Upgrade to Node.js >= 18.13 or install undici.\n' +
      'GitLab API and Matrix notifications will not work.\n',
    );
  }
}

import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { executeAcpCommand } from './commands/acpCommand.js';
import { executeAgentCommand } from './commands/agentCommand.js';
import { executeCardAdd } from './commands/cardAdd.js';
import { executeCardDashboard } from './commands/cardDashboard.js';
import { executeCardMarkComplete } from './commands/cardMarkComplete.js';
import { executeCardMarkStarted } from './commands/cardMarkStarted.js';
import { executeDoctor } from './commands/doctor.js';
import { executeHook } from './commands/hookCommand.js';
import { executeLogs } from './commands/logs.js';
import { executeMonitorTick } from './commands/monitorTick.js';
import { executePipelineTick } from './commands/pipelineTick.js';
import { executePmCommand } from './commands/pmCommand.js';
import { executeProjectInit } from './commands/projectInit.js';
import { executeQaTick } from './commands/qaTick.js';
import { executeReset } from './commands/reset.js';
import { executeSchedulerTick } from './commands/schedulerTick.js';
import { executeSetup } from './commands/setup.js';
import { executeStatus } from './commands/status.js';
import { executeStop } from './commands/stop.js';
import { executeTick } from './commands/tick.js';
import { executeWorkerDashboard } from './commands/workerDashboard.js';
import { executeWorkerLaunch } from './commands/workerLaunch.js';
import { executeWorkerKill, executeWorkerPs } from './commands/workerPs.js';

const _require = createRequire(import.meta.url);
const VERSION: string = (_require('../package.json') as { version: string }).version;

interface CommandInfo {
  desc: string;
  usage: string;
  subs?: Record<string, string>;
  examples?: string[];
}

const COMMANDS: Record<string, CommandInfo> = {
  agent:     { desc: 'Agent interaction (zero-config, multi-turn chat)', usage: 'sps agent "<prompt>" | sps agent --chat',
    examples: ['sps agent "Explain this repo"', 'sps agent --chat', 'sps agent status'] },
  setup:     { desc: 'Initial environment setup (credentials, directories, config files)', usage: 'sps setup [--force]',
    examples: ['sps setup', 'sps setup --force'] },
  tick:      { desc: 'Run continuous pipeline', usage: 'sps tick <project> [--json]',
    examples: ['sps tick my-project', 'sps tick proj1 proj2'] },
  card:      { desc: 'Card management (create, board, mark started/complete)', usage: 'sps card <subcommand> <project> [args]', subs: {
    add: 'Create a new task card',
    dashboard: 'Show the card kanban board',
    'mark-started': 'Mark a card as started (used by the Claude UserPromptSubmit hook)',
    'mark-complete': 'Mark a card as complete (used by the Claude Stop hook)',
  }, examples: ['sps card add my-project "New task"', 'sps card mark-complete my-project 42'] },
  doctor:    { desc: 'Project health check and state repair', usage: 'sps doctor <project> [--json] [--fix] [--reset-state] [--skip-remote]',
    examples: ['sps doctor my-project', 'sps doctor my-project --json', 'sps doctor my-project --reset-state'] },
  scheduler: { desc: 'Scheduler: promote Planning → Backlog', usage: 'sps scheduler <subcommand> <project>', subs: {
    tick: 'Run one scheduler tick',
  }, examples: ['sps scheduler tick my-project'] },
  pipeline:  { desc: 'Pipeline management (start, stop, status, board, custom pipelines)', usage: 'sps pipeline <subcommand> [args]', subs: {
    start: 'Start the continuous pipeline (= sps tick)',
    stop: 'Stop the pipeline (= sps stop)',
    status: 'Show status (= sps status)',
    reset: 'Reset cards (= sps reset)',
    workers: 'Worker dashboard (= sps worker dashboard)',
    board: 'Card board (= sps card dashboard)',
    logs: 'View logs (= sps logs)',
    tick: 'Run one pipeline tick',
    list: 'List all custom pipelines',
    run: 'Run a custom pipeline',
    use: 'Switch the active pipeline for a project',
  }, examples: ['sps pipeline start my-project', 'sps pipeline list', 'sps pipeline use my-project develop'] },
  memory:    { desc: 'Project memory management', usage: 'sps memory <subcommand> <project>', subs: {
    context: 'Generate memory injection content (for worker prompts)',
    list: 'List project memory index',
    add: 'Add a memory entry',
  }, examples: ['sps memory context my-project', 'sps memory context my-project --card 42', 'sps memory list my-project'] },
  worker:    { desc: 'Worker lifecycle management', usage: 'sps worker <subcommand> <project> [seq]', subs: {
    ps: 'Show worker process status',
    kill: 'Terminate the specified worker',
    launch: 'Launch a worker instance',
    dashboard: 'Show the worker dashboard',
  }, examples: ['sps worker ps my-project', 'sps worker kill my-project 1', 'sps worker launch my-project 1'] },
  acp:       { desc: 'ACP session management', usage: 'sps acp <subcommand> <project> [args...]', subs: {
    ensure: 'Ensure an ACP session exists',
    run: 'Run an ACP command',
    prompt: 'Send a prompt to a session',
    status: 'Show session status',
    stop: 'Stop the ACP session',
    pending: 'Show pending messages',
    respond: 'Respond to a pending message',
  }, examples: ['sps acp status my-project', 'sps acp ensure my-project'] },
  pm:        { desc: 'PM backend operations (scan/move/comment/label)', usage: 'sps pm <subcommand> <project> [args...]', subs: {
    scan: 'Scan project cards',
    move: 'Move a card to a different state',
    comment: 'Add a comment to a card',
    checklist: 'Manage checklist',
  }, examples: ['sps pm scan my-project', 'sps pm move my-project'] },
  qa:        { desc: 'QA finalize: QA → merge → Done', usage: 'sps qa <subcommand> <project>', subs: {
    tick: 'Run one QA tick',
  }, examples: ['sps qa tick my-project'] },
  monitor:   { desc: 'Anomaly detection and diagnostics', usage: 'sps monitor <subcommand> <project>', subs: {
    tick: 'Run one monitor tick',
  }, examples: ['sps monitor tick my-project'] },
  project:   { desc: 'Project initialization and validation', usage: 'sps project <subcommand> <project>', subs: {
    init: 'Initialize a new project',
    doctor: 'Project health check',
  }, examples: ['sps project init my-project', 'sps project doctor my-project'] },
  logs:      { desc: 'Live log viewer', usage: 'sps logs [project] [--err] [--lines N] [--no-follow]',
    examples: ['sps logs', 'sps logs my-project', 'sps logs my-project --err --lines 50'] },
  stop:      { desc: 'Stop a running tick process', usage: 'sps stop <project> [--all]',
    examples: ['sps stop my-project', 'sps stop --all'] },
  reset:     { desc: 'Reset card state; clean up worktrees and branches; prepare to re-run', usage: 'sps reset <project> [--all] [--card N,N,N]',
    examples: ['sps reset my-project', 'sps reset my-project --all', 'sps reset my-project --card 5,6,7'] },
  skill:     { desc: 'Skill management (symlink dispatch into project .claude/skills/)', usage: 'sps skill <subcommand> [name] [--project <name>]', subs: {
    list: 'List user-level skills and per-project link status',
    add: 'Symlink a skill into the current project (auto-falls-back to cpSync)',
    remove: 'Remove a skill from the current project',
    freeze: 'symlink → real copy (allows per-project customization)',
    unfreeze: 'real copy → symlink (track the global copy again)',
    sync: '(1) bundled → ~/.coral/skills/ (fills missing by default; --force overwrites); (2) ~/.coral/skills/ → ~/.claude/skills/',
  }, examples: ['sps skill list', 'sps skill add python', 'sps skill freeze backend', 'sps skill sync', 'sps skill sync --force'] },
  console:   { desc: 'Launch the SPS Console web UI (in your local browser)', usage: 'sps console [--port 4311] [--host 127.0.0.1] [--no-open] [--dev] [--kill]',
    examples: ['sps console', 'sps console --port 5000', 'sps console --no-open', 'sps console --kill'] },
  status:    { desc: 'Show running status for all projects', usage: 'sps status [--json]',
    examples: ['sps status', 'sps status --json'] },
  hook:      { desc: 'Claude Code hook event wrapper (called from .claude/settings.json)', usage: 'sps hook <event>', subs: {
    stop: 'Mark the current card complete (COMPLETED-<stage> label)',
    'user-prompt-submit': 'If the card has skill:* labels, inject skill prompts',
  }, examples: ['sps hook stop', 'sps hook user-prompt-submit'] },
  wiki:      { desc: 'Wiki knowledge base (per-project)', usage: 'sps wiki <subcommand> <project> [args]', subs: {
    init: 'Scaffold the wiki/ directory (subdirs + WIKI.md + .gitignore)',
    update: 'Scan sources → diff manifest → output ingest plan (--finalize writes manifest)',
    read: '5-layer deterministic retrieval → render prompt-injection markdown',
    check: 'Lint: orphan / dead-link / fm-gap / stale',
    add: 'Copy an external source into wiki/.raw/<category>/',
    list: 'Filter pages by type/tag',
    get: 'Fetch a single page (frontmatter + body)',
    status: 'Source ↔ manifest ↔ pages diff overview',
  }, examples: [
    'sps wiki init my-project',
    'sps wiki update my-project',
    'sps wiki read my-project "pipeline race"',
    'sps wiki check my-project',
    'sps wiki add my-project ~/notes.md --category transcripts',
    'sps wiki list my-project --type lesson --tag pipeline',
    'sps wiki get my-project lessons/Stop-Hook-Race',
    'sps wiki status my-project',
  ] },
};

function printHelp() {
  console.log('');
  console.log('   ██████╗ ██████╗ ██████╗  █████╗ ██╗         ███████╗██████╗ ███████╗');
  console.log('  ██╔════╝██╔═══██╗██╔══██╗██╔══██╗██║         ██╔════╝██╔══██╗██╔════╝');
  console.log('  ██║     ██║   ██║██████╔╝███████║██║         ███████╗██████╔╝███████╗');
  console.log('  ██║     ██║   ██║██╔══██╗██╔══██║██║         ╚════██║██╔═══╝ ╚════██║');
  console.log('  ╚██████╗╚██████╔╝██║  ██║██║  ██║███████╗    ███████║██║     ███████║');
  console.log('   ╚═════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝    ╚══════╝╚═╝     ╚══════╝');
  console.log('');
  console.log(`  sps v${VERSION} — AI-Driven Development Pipeline Orchestrator`);
  console.log('  ──────────────────────────────────────────────────────────────────────');
  console.log('');
  console.log('Usage: sps <command> [subcommand] <project> [options]\n');
  console.log('Commands:');
  for (const [cmd, info] of Object.entries(COMMANDS)) {
    console.log(`  ${cmd.padEnd(12)} ${info.desc}`);
  }
  console.log('\nGlobal options:');
  console.log('  --json         Output structured JSON');
  console.log('  --dry-run      Preview actions without executing');
  console.log('  --help         Show help (combine with a command, e.g. sps card --help)');
  console.log('  --version      Show version');
}

function printCommandHelp(cmd: string) {
  const info = COMMANDS[cmd];
  if (!info) return;

  console.log(`\n  ${cmd} — ${info.desc}\n`);
  console.log(`  Usage: ${info.usage}\n`);

  if (info.subs && Object.keys(info.subs).length > 0) {
    console.log('  Subcommands:');
    for (const [sub, desc] of Object.entries(info.subs)) {
      console.log(`    ${sub.padEnd(14)} ${desc}`);
    }
    console.log('');
  }

  if (info.examples && info.examples.length > 0) {
    console.log('  Examples:');
    for (const ex of info.examples) {
      console.log(`    $ ${ex}`);
    }
    console.log('');
  }
}

interface ParsedArgs {
  command: string;
  subcommand: string | null;
  project: string | null;
  positionals: string[];
  flags: Record<string, boolean>;
}

// Commands that always have subcommands
const SUBCOMMAND_COMMANDS = new Set(['scheduler', 'pipeline', 'worker', 'acp', 'pm', 'qa', 'monitor', 'project', 'card', 'skill', 'memory', 'hook', 'wiki']);

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, boolean> = {};
  const positionals: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        // --key=value → store value
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1) as any;
      } else {
        const key = arg.slice(2);
        // Peek next arg: if it exists and doesn't start with --, treat as value
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next as any;
          i++; // skip next
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(arg);
    }
  }

  const command = positionals[0] || '';
  const hasSubcommand = SUBCOMMAND_COMMANDS.has(command);

  if (hasSubcommand) {
    return {
      command,
      subcommand: positionals[1] || null,
      project: positionals[2] || null,
      positionals: positionals.slice(3),
      flags,
    };
  }

  // Commands without subcommands: tick, doctor
  return {
    command,
    subcommand: null,
    project: positionals[1] || null,
    positionals: positionals.slice(2),
    flags,
  };
}

function requireProject(args: ParsedArgs, usage: string): string {
  const project = args.project || args.subcommand;
  if (!project) {
    console.error(`Usage: ${usage}`);
    process.exit(2);
  }
  return project;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.flags.version) {
    console.log(VERSION);
    process.exit(0);
  }

  if (args.flags.help) {
    if (args.command && args.command in COMMANDS) {
      printCommandHelp(args.command);
    } else {
      printHelp();
    }
    process.exit(0);
  }

  if (!args.command) {
    printHelp();
    process.exit(0);
  }

  // ─── setup ─────────────────────────────────────────────────
  if (args.command === 'setup') {
    await executeSetup(args.flags);
    return;
  }

  // ─── agent (harness mode — custom arg parsing) ──────────────
  if (args.command === 'agent') {
    const agentArgs = process.argv.slice(3);
    // Handle daemon subcommand
    if (agentArgs[0] === 'daemon') {
      const { executeDaemonCommand } = await import('./commands/agentDaemon.js');
      await executeDaemonCommand(agentArgs[1] || '');
      return;
    }
    await executeAgentCommand(agentArgs);
    return;
  }

  // ─── pipeline (aliases for tick/stop/status/reset/workers/board/card/logs)
  if (args.command === 'pipeline') {
    const sub = args.subcommand;
    if (sub === 'start') {
      const projects: string[] = [];
      if (args.project) projects.push(args.project);
      projects.push(...args.positionals);
      if (projects.length === 0) { console.error('Usage: sps pipeline start <project>'); process.exit(2); }
      await executeTick(projects, args.flags);
      return;
    }
    if (sub === 'stop') {
      const projects: string[] = [];
      if (args.project) projects.push(args.project);
      projects.push(...args.positionals);
      await executeStop(projects, args.flags);
      return;
    }
    if (sub === 'status') {
      await executeStatus(args.flags);
      return;
    }
    if (sub === 'reset') {
      const project = args.project;
      if (!project) { console.error('Usage: sps pipeline reset <project>'); process.exit(2); }
      await executeReset(project, args.flags);
      return;
    }
    if (sub === 'workers') {
      const projects: string[] = [];
      if (args.project) projects.push(args.project);
      projects.push(...args.positionals);
      await executeWorkerDashboard(projects, args.flags);
      return;
    }
    if (sub === 'board') {
      const projects: string[] = [];
      if (args.project) projects.push(args.project);
      projects.push(...args.positionals);
      await executeCardDashboard(projects, args.flags);
      return;
    }
    if (sub === 'card' && args.project === 'add') {
      const project = args.positionals[0];
      if (!project) { console.error('Usage: sps pipeline card add <project> "<title>"'); process.exit(2); }
      await executeCardAdd(project, args.positionals.slice(1), args.flags);
      return;
    }
    if (sub === 'logs') {
      const projects: string[] = [];
      if (args.project) projects.push(args.project);
      projects.push(...args.positionals);
      await executeLogs(projects, args.flags, 30);
      return;
    }
    if (sub === 'list') {
      const { listPipelines } = await import('./core/pipelineConfig.js');
      const pipelines = listPipelines();
      if (pipelines.length === 0) {
        console.log('No pipelines found. Create ~/.coral/projects/<project>/pipelines/<name>.yaml to get started.');
      } else {
        console.log(`\n  Available pipelines:\n`);
        for (const p of pipelines) {
          const desc = p.description ? `  ${p.description}` : '';
          console.log(`  ${p.name.padEnd(20)} ${p.mode.padEnd(8)} ${desc}`);
        }
        console.log('');
      }
      return;
    }
    if (sub === 'use') {
      const project = args.project;
      const pipelineName = args.positionals[0];
      if (!project || !pipelineName) {
        console.error('Usage: sps pipeline use <project> <pipeline-name>');
        process.exit(2);
      }
      const { getPipelinesDir } = await import('./core/pipelineConfig.js');
      const { setActivePipeline } = await import('./core/projectPipelineAdapter.js');
      const pipelinesDir = getPipelinesDir(project);
      const found = ['.yaml', '.yml'].some(ext => existsSync(resolve(pipelinesDir, pipelineName + ext)));
      if (!found) {
        console.error(`Pipeline "${pipelineName}" not found in ${pipelinesDir}/`);
        if (existsSync(pipelinesDir)) {
          const files = readdirSync(pipelinesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'));
          if (files.length > 0) {
            console.error(`Available: ${files.map(f => f.replace(/\.ya?ml$/, '')).join(', ')}`);
          }
        }
        process.exit(1);
      }
      setActivePipeline(project, pipelineName);
      console.log(`  ✓ Active pipeline for ${project}: ${pipelineName}`);
      return;
    }
    if (sub === 'run') {
      const pipelineName = args.project;
      if (!pipelineName) {
        console.error('Usage: sps pipeline run <name> ["prompt"]');
        process.exit(2);
      }
      const { loadPipelineConfig } = await import('./core/pipelineConfig.js');
      const config = loadPipelineConfig(pipelineName);
      if (config.mode === 'steps') {
        const { executePipelineRun } = await import('./commands/pipelineRunner.js');
        const userPrompt = args.positionals.join(' ');
        await executePipelineRun(config, userPrompt, args.flags);
      } else {
        console.error(`Pipeline "${pipelineName}" is mode "${config.mode}" — use "sps pipeline start" for project pipelines`);
        process.exit(2);
      }
      return;
    }
    console.error('Usage: sps pipeline <start|stop|status|reset|workers|board|card|logs|list|run> [project]');
    process.exit(2);
  }

  // ─── init (alias for project init) ──────────────────────────
  if (args.command === 'init') {
    const project = args.project || args.positionals[0];
    if (!project) { console.error('Usage: sps init <project>'); process.exit(2); }
    await executeProjectInit(project, args.flags);
    return;
  }

  // ─── tick (supports multiple projects) ──────────────────────
  if (args.command === 'tick') {
    // Collect all projects: project + positionals
    const projects: string[] = [];
    if (args.project) projects.push(args.project);
    projects.push(...args.positionals);
    if (projects.length === 0) {
      console.error('Usage: sps tick <project> [project2] [project3] ...');
      process.exit(2);
    }
    await executeTick(projects, args.flags);
    return;
  }

  // ─── logs ──────────────────────────────────────────────────────
  if (args.command === 'logs') {
    const projects: string[] = [];
    if (args.project) projects.push(args.project);
    projects.push(...args.positionals);
    // Parse --lines N from argv (flag parser doesn't handle values)
    const linesIdx = process.argv.indexOf('--lines');
    const initialLines = linesIdx >= 0 ? parseInt(process.argv[linesIdx + 1] || '20', 10) : 20;
    await executeLogs(projects, args.flags, initialLines);
    return;
  }

  // ─── skill ──────────────────────────────────────────────────────
  if (args.command === 'skill') {
    if (!args.subcommand) {
      console.error('Usage: sps skill <list|add|remove|freeze|unfreeze|sync> [name] [--project <name>]');
      process.exit(2);
    }
    const { executeSkillCommand } = await import('./commands/skillCommand.js');
    // 首个 positional 在 SUBCOMMAND_COMMANDS 解析下是 args.project（name 参数）
    const positionals: string[] = [];
    if (args.project) positionals.push(args.project);
    positionals.push(...args.positionals);
    await executeSkillCommand(args.subcommand, positionals, args.flags as unknown as Record<string, unknown>);
    return;
  }

  // ─── console ───────────────────────────────────────────────────
  if (args.command === 'console') {
    const { executeConsole } = await import('./commands/consoleCommand.js');
    await executeConsole(args.flags as unknown as Record<string, unknown>);
    return;
  }

  // ─── status ─────────────────────────────────────────────────────
  if (args.command === 'status') {
    await executeStatus(args.flags);
    return;
  }

  // ─── hook ──────────────────────────────────────────────────────
  if (args.command === 'hook') {
    // Usage: sps hook <event>   (no project arg; context comes from SPS_* env vars)
    const event = args.subcommand || args.project || '';
    if (!event) {
      console.error('Usage: sps hook <stop|user-prompt-submit>');
      process.exit(2);
    }
    await executeHook(event, args.flags as unknown as Record<string, unknown>);
    return;
  }

  // ─── stop ──────────────────────────────────────────────────────
  if (args.command === 'stop') {
    const projects: string[] = [];
    if (args.project) projects.push(args.project);
    projects.push(...args.positionals);
    await executeStop(projects, args.flags);
    return;
  }

  // ─── reset ─────────────────────────────────────────────────────
  if (args.command === 'reset') {
    const project = requireProject(args, 'sps reset <project> [--all] [--card N,N]');
    // --card value: parse from raw argv since flags parser is boolean-only
    const rawCardIdx = process.argv.indexOf('--card');
    const cardArg = rawCardIdx >= 0 && rawCardIdx + 1 < process.argv.length
      ? process.argv[rawCardIdx + 1]
      : undefined;
    await executeReset(project, args.flags, cardArg);
    return;
  }

  // ─── doctor (shorthand) ──────────────────────────────────────
  if (args.command === 'doctor') {
    const project = requireProject(args, 'sps doctor <project>');
    await executeDoctor(project, args.flags);
    return;
  }

  // ─── project ─────────────────────────────────────────────────
  if (args.command === 'project' && args.subcommand === 'init') {
    if (!args.project) {
      console.error('Usage: sps project init <project>');
      process.exit(2);
    }
    await executeProjectInit(args.project, args.flags);
    return;
  }

  if (args.command === 'project' && args.subcommand === 'doctor') {
    if (!args.project) {
      console.error('Usage: sps project doctor <project>');
      process.exit(2);
    }
    await executeDoctor(args.project, args.flags);
    return;
  }

  // ─── scheduler ───────────────────────────────────────────────
  if (args.command === 'scheduler') {
    if (args.subcommand === 'tick') {
      if (!args.project) {
        console.error('Usage: sps scheduler tick <project>');
        process.exit(2);
      }
      await executeSchedulerTick(args.project, args.flags);
      return;
    }
  }

  // ─── pipeline ────────────────────────────────────────────────
  if (args.command === 'pipeline') {
    if (args.subcommand === 'tick') {
      if (!args.project) {
        console.error('Usage: sps pipeline tick <project>');
        process.exit(2);
      }
      await executePipelineTick(args.project, args.flags);
      return;
    }
  }

  // ─── worker ──────────────────────────────────────────────────
  if (args.command === 'worker') {
    if (args.subcommand === 'ps') {
      if (!args.project) {
        console.error('Usage: sps worker ps <project>');
        process.exit(2);
      }
      await executeWorkerPs(args.project, args.flags);
      return;
    }
    if (args.subcommand === 'kill') {
      if (!args.project) {
        console.error('Usage: sps worker kill <project> <seq>');
        process.exit(2);
      }
      const seq = args.positionals[0] || '';
      await executeWorkerKill(args.project, seq, args.flags);
      return;
    }
    if (args.subcommand === 'launch') {
      if (!args.project) {
        console.error('Usage: sps worker launch <project> <seq>');
        process.exit(2);
      }
      const seq = args.positionals[0] || '';
      await executeWorkerLaunch(args.project, seq, args.flags);
      return;
    }
    if (args.subcommand === 'dashboard') {
      // Collect projects: project + positionals (all optional, auto-discovers if empty)
      const projects: string[] = [];
      if (args.project) projects.push(args.project);
      projects.push(...args.positionals);
      await executeWorkerDashboard(projects, args.flags);
      return;
    }
  }

  // ─── acp ─────────────────────────────────────────────────────
  if (args.command === 'acp') {
    if (!args.subcommand) {
      console.error('Usage: sps acp <ensure|run|prompt|status|stop> <project> [args...]');
      process.exit(2);
    }
    if (!args.project) {
      console.error(`Usage: sps acp ${args.subcommand} <project> [args...]`);
      process.exit(2);
    }
    await executeAcpCommand(args.project, args.subcommand, args.positionals, args.flags);
    return;
  }

  // ─── qa ─────────────────────────────────────────────────────
  if (args.command === 'qa') {
    if (args.subcommand === 'tick') {
      if (!args.project) {
        console.error('Usage: sps qa tick <project>');
        process.exit(2);
      }
      await executeQaTick(args.project, args.flags);
      return;
    }
  }

  // ─── monitor ────────────────────────────────────────────────
  if (args.command === 'monitor') {
    if (args.subcommand === 'tick') {
      if (!args.project) {
        console.error('Usage: sps monitor tick <project>');
        process.exit(2);
      }
      await executeMonitorTick(args.project, args.flags);
      return;
    }
  }

  // ─── pm ─────────────────────────────────────────────────────
  if (args.command === 'pm') {
    if (!args.subcommand) {
      console.error('Usage: sps pm <scan|move|comment|checklist> <project> [args...]');
      process.exit(2);
    }
    if (!args.project) {
      console.error(`Usage: sps pm ${args.subcommand} <project> [args...]`);
      process.exit(2);
    }
    await executePmCommand(args.project, args.subcommand, args.positionals, args.flags);
    return;
  }

  // ─── memory ─────────────────────────────────────────────────
  if (args.command === 'memory') {
    const { buildFullMemoryContext, readMemoryIndex, addMemory, ensureMemoryDir, MEMORY_TYPES, getProjectMemoryDir } = await import('./core/memory.js');

    if (args.subcommand === 'context') {
      if (!args.project) {
        console.error('Usage: sps memory context <project> [--card <seq>] [--agent <id>]');
        process.exit(2);
      }
      const cardSeq = args.flags.card as unknown as string | undefined;
      const agentId = args.flags.agent as unknown as string | undefined;
      const context = buildFullMemoryContext({ project: args.project, cardSeq, agentId });
      if (context) {
        console.log(context);
      } else {
        console.log('(no project memories found)');
      }
      return;
    }

    if (args.subcommand === 'list') {
      const { getUserMemoryDir, getAgentMemoryDir } = await import('./core/memory.js');

      // Show all layers
      const userIndex = readMemoryIndex(getUserMemoryDir());
      if (userIndex) {
        console.log('── User Memory ──');
        console.log(userIndex);
        console.log('');
      }

      const agentId = args.flags.agent as unknown as string | undefined;
      if (agentId) {
        const agentIndex = readMemoryIndex(getAgentMemoryDir(agentId));
        if (agentIndex) {
          console.log(`── Agent Memory (${agentId}) ──`);
          console.log(agentIndex);
          console.log('');
        }
      }

      if (args.project) {
        const projectIndex = readMemoryIndex(getProjectMemoryDir(args.project));
        if (projectIndex) {
          console.log(`── Project Memory (${args.project}) ──`);
          console.log(projectIndex);
        } else {
          console.log(`── Project Memory (${args.project}) ──`);
          console.log('(no memories yet)');
        }
      } else {
        if (!userIndex) console.log('(no memories found)');
      }
      return;
    }

    if (args.subcommand === 'add') {
      if (!args.project) {
        console.error('Usage: sps memory add <project> --type <type> --name <name> [--body <text>]');
        process.exit(2);
      }
      const type = (args.flags.type as unknown as string) || '';
      const name = (args.flags.name as unknown as string) || args.positionals[0] || '';
      const body = (args.flags.body as unknown as string) || args.positionals.slice(1).join(' ') || '';
      const description = (args.flags.description as unknown as string) || name;

      if (!type || !MEMORY_TYPES.includes(type as any) || !name) {
        console.error(`Usage: sps memory add <project> --type <${MEMORY_TYPES.join('|')}> --name "<title>" [--body "<content>"]`);
        process.exit(2);
      }

      ensureMemoryDir(args.project);
      const filePath = addMemory(args.project, {
        name,
        description,
        type: type as any,
        body: body || name,
      });
      console.log(`Memory saved: ${filePath}`);
      return;
    }

    console.error('Usage: sps memory <context|list|add> <project>');
    process.exit(2);
  }

  // ─── card ───────────────────────────────────────────────────
  if (args.command === 'card') {
    if (args.subcommand === 'add') {
      if (!args.project) {
        console.error('Usage: sps card add <project> "<title>" ["description"]');
        process.exit(2);
      }
      await executeCardAdd(args.project, args.positionals, args.flags);
      return;
    }
    if (args.subcommand === 'dashboard') {
      const projects: string[] = [];
      if (args.project) projects.push(args.project);
      projects.push(...args.positionals);
      await executeCardDashboard(projects, args.flags);
      return;
    }
    if (args.subcommand === 'mark-complete') {
      if (!args.project) {
        console.error('Usage: sps card mark-complete <project> <seq> [--stage <name>]');
        process.exit(2);
      }
      await executeCardMarkComplete(args.project, args.positionals, args.flags as unknown as Record<string, unknown>);
      return;
    }
    if (args.subcommand === 'mark-started') {
      if (!args.project) {
        console.error('Usage: sps card mark-started <project> [seq] [--stage <name>]');
        process.exit(2);
      }
      await executeCardMarkStarted(args.project, args.positionals, args.flags as unknown as Record<string, unknown>);
      return;
    }
  }

  // ─── wiki ────────────────────────────────────────────────────
  if (args.command === 'wiki') {
    if (!args.subcommand) {
      console.error('Usage: sps wiki <init|update|read> <project> [args]');
      process.exit(2);
    }
    if (!args.project) {
      console.error(`Usage: sps wiki ${args.subcommand} <project> [args]`);
      process.exit(2);
    }
    const { executeWikiCommand } = await import('./commands/wikiCommand.js');
    // Parse list-valued flags from raw argv (boolean flag parser doesn't keep these).
    const rawSkillsIdx = process.argv.indexOf('--skills');
    const skills = rawSkillsIdx >= 0 && rawSkillsIdx + 1 < process.argv.length
      ? process.argv[rawSkillsIdx + 1]!.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const rawPinnedIdx = process.argv.indexOf('--pinned');
    const pinned = rawPinnedIdx >= 0 && rawPinnedIdx + 1 < process.argv.length
      ? process.argv[rawPinnedIdx + 1]!.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;
    const rawBudgetIdx = process.argv.indexOf('--budget');
    const budgetTokens = rawBudgetIdx >= 0 && rawBudgetIdx + 1 < process.argv.length
      ? parseInt(process.argv[rawBudgetIdx + 1] || '0', 10) || undefined
      : undefined;
    const rawTypeIdx = process.argv.indexOf('--type');
    const typeFilter = rawTypeIdx >= 0 && rawTypeIdx + 1 < process.argv.length
      ? process.argv[rawTypeIdx + 1]
      : undefined;
    const rawTagIdx = process.argv.indexOf('--tag');
    const tagFilter = rawTagIdx >= 0 && rawTagIdx + 1 < process.argv.length
      ? process.argv[rawTagIdx + 1]
      : undefined;
    const rawCategoryIdx = process.argv.indexOf('--category');
    const category = rawCategoryIdx >= 0 && rawCategoryIdx + 1 < process.argv.length
      ? process.argv[rawCategoryIdx + 1]
      : undefined;
    try {
      executeWikiCommand({
        subcommand: args.subcommand,
        project: args.project,
        positionals: args.positionals,
        flags: args.flags,
        skills,
        pinned,
        budgetTokens,
        type: typeFilter,
        tag: tagFilter,
        category,
      });
    } catch (err) {
      // LintFailure has a structured exit; preserve message but exit 1
      const isLintFail = err instanceof Error && err.name === 'LintFailure';
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(isLintFail ? 1 : 2);
    }
    return;
  }

  // ─── Unknown or not-yet-implemented ──────────────────────────
  if (!(args.command in COMMANDS)) {
    console.error(`Unknown command: ${args.command}\n`);
    printHelp();
    process.exit(2);
  }

  console.error(`[${args.command}${args.subcommand ? ' ' + args.subcommand : ''}] Not yet implemented.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
