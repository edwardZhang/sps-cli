#!/usr/bin/env node

import { executeDoctor } from './commands/doctor.js';
import { executeTick } from './commands/tick.js';
import { executeSchedulerTick } from './commands/schedulerTick.js';
import { executePipelineTick } from './commands/pipelineTick.js';
import { executeWorkerLaunch } from './commands/workerLaunch.js';
import { executeProjectInit } from './commands/projectInit.js';
import { executeQaTick } from './commands/qaTick.js';
import { executeMonitorTick } from './commands/monitorTick.js';
import { executePmCommand } from './commands/pmCommand.js';
import { executeCardAdd } from './commands/cardAdd.js';

const VERSION = '0.6.0';

const COMMANDS: Record<string, { desc: string; usage: string }> = {
  tick:      { desc: 'Run continuous pipeline (--once for single tick)', usage: 'workflow tick <project> [--once]' },
  card:      { desc: 'Card management', usage: 'workflow card add <project> "<title>" ["desc"]' },
  doctor:    { desc: 'Project health check', usage: 'workflow doctor <project> [--json] [--skip-remote]' },
  scheduler: { desc: 'Planning → Backlog promotion', usage: 'workflow scheduler <tick|inspect|validate> <project>' },
  pipeline:  { desc: 'Execution chain (Backlog → Todo → Inprogress)', usage: 'workflow pipeline <tick|inspect> <project>' },
  worker:    { desc: 'Worker lifecycle management', usage: 'workflow worker <launch|release|inspect> <project> [seq|slot]' },
  pm:        { desc: 'PM backend operations', usage: 'workflow pm <scan|move|comment|checklist> <project> [args...]' },
  qa:        { desc: 'QA / closeout (QA → merge → Done)', usage: 'workflow qa <tick|inspect> <project>' },
  monitor:   { desc: 'Anomaly detection and diagnostics', usage: 'workflow monitor <tick|inspect-worker|inspect-card> <project>' },
  project:   { desc: 'Project init and validation', usage: 'workflow project <init|doctor|validate|paths> <project>' },
};

function printHelp() {
  console.log(`workflow v${VERSION} — JARVIS Workflow CLI\n`);
  console.log('Usage: workflow <command> [subcommand] <project> [options]\n');
  console.log('Commands:');
  for (const [cmd, info] of Object.entries(COMMANDS)) {
    console.log(`  ${cmd.padEnd(12)} ${info.desc}`);
  }
  console.log('\nGlobal options:');
  console.log('  --json         Output structured JSON');
  console.log('  --dry-run      Preview actions without executing');
  console.log('  --help         Show help');
  console.log('  --version      Show version');
}

interface ParsedArgs {
  command: string;
  subcommand: string | null;
  project: string | null;
  positionals: string[];
  flags: Record<string, boolean>;
}

// Commands that always have subcommands
const SUBCOMMAND_COMMANDS = new Set(['scheduler', 'pipeline', 'worker', 'pm', 'qa', 'monitor', 'project', 'card']);

function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, boolean> = {};
  const positionals: string[] = [];

  for (const arg of argv) {
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx > 0) {
        // --key=value → treat as boolean true (value parsed by command if needed)
        flags[arg.slice(2, eqIdx)] = true;
      } else {
        flags[arg.slice(2)] = true;
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

  if (args.flags.help || !args.command) {
    printHelp();
    process.exit(0);
  }

  // ─── tick (supports multiple projects) ──────────────────────
  if (args.command === 'tick') {
    // Collect all projects: project + positionals
    const projects: string[] = [];
    if (args.project) projects.push(args.project);
    projects.push(...args.positionals);
    if (projects.length === 0) {
      console.error('Usage: workflow tick <project> [project2] [project3] ...');
      process.exit(2);
    }
    await executeTick(projects, args.flags);
    return;
  }

  // ─── doctor (shorthand) ──────────────────────────────────────
  if (args.command === 'doctor') {
    const project = requireProject(args, 'workflow doctor <project>');
    await executeDoctor(project, args.flags);
    return;
  }

  // ─── project ─────────────────────────────────────────────────
  if (args.command === 'project' && args.subcommand === 'init') {
    if (!args.project) {
      console.error('Usage: workflow project init <project>');
      process.exit(2);
    }
    await executeProjectInit(args.project, args.flags);
    return;
  }

  if (args.command === 'project' && args.subcommand === 'doctor') {
    if (!args.project) {
      console.error('Usage: workflow project doctor <project>');
      process.exit(2);
    }
    await executeDoctor(args.project, args.flags);
    return;
  }

  // ─── scheduler ───────────────────────────────────────────────
  if (args.command === 'scheduler') {
    if (args.subcommand === 'tick') {
      if (!args.project) {
        console.error('Usage: workflow scheduler tick <project>');
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
        console.error('Usage: workflow pipeline tick <project>');
        process.exit(2);
      }
      await executePipelineTick(args.project, args.flags);
      return;
    }
  }

  // ─── worker ──────────────────────────────────────────────────
  if (args.command === 'worker') {
    if (args.subcommand === 'launch') {
      if (!args.project) {
        console.error('Usage: workflow worker launch <project> <seq>');
        process.exit(2);
      }
      const seq = args.positionals[0] || '';
      await executeWorkerLaunch(args.project, seq, args.flags);
      return;
    }
  }

  // ─── qa ─────────────────────────────────────────────────────
  if (args.command === 'qa') {
    if (args.subcommand === 'tick') {
      if (!args.project) {
        console.error('Usage: workflow qa tick <project>');
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
        console.error('Usage: workflow monitor tick <project>');
        process.exit(2);
      }
      await executeMonitorTick(args.project, args.flags);
      return;
    }
  }

  // ─── pm ─────────────────────────────────────────────────────
  if (args.command === 'pm') {
    if (!args.subcommand) {
      console.error('Usage: workflow pm <scan|move|comment|checklist> <project> [args...]');
      process.exit(2);
    }
    if (!args.project) {
      console.error(`Usage: workflow pm ${args.subcommand} <project> [args...]`);
      process.exit(2);
    }
    await executePmCommand(args.project, args.subcommand, args.positionals, args.flags);
    return;
  }

  // ─── card ───────────────────────────────────────────────────
  if (args.command === 'card') {
    if (args.subcommand === 'add') {
      if (!args.project) {
        console.error('Usage: workflow card add <project> "<title>" ["description"]');
        process.exit(2);
      }
      await executeCardAdd(args.project, args.positionals, args.flags);
      return;
    }
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
