#!/usr/bin/env node

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
      'Some features (Plane, Trello, GitLab API, Matrix) will not work.\n',
    );
  }
}

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
import { executeCardDashboard } from './commands/cardDashboard.js';
import { executeSetup } from './commands/setup.js';
import { executeWorkerDashboard } from './commands/workerDashboard.js';
import { executeWorkerPs, executeWorkerKill } from './commands/workerPs.js';
import { executeLogs } from './commands/logs.js';
import { executeStop } from './commands/stop.js';
import { executeReset } from './commands/reset.js';
import { executeStatus } from './commands/status.js';
import { executeAcpCommand } from './commands/acpCommand.js';
import { executeAgentCommand } from './commands/agentCommand.js';

import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const VERSION: string = (_require('../package.json') as { version: string }).version;

interface CommandInfo {
  desc: string;
  usage: string;
  subs?: Record<string, string>;
  examples?: string[];
}

const COMMANDS: Record<string, CommandInfo> = {
  agent:     { desc: 'Agent 交互（零配置，支持多轮对话）', usage: 'sps agent "<prompt>" | sps agent --chat',
    examples: ['sps agent "Explain this repo"', 'sps agent --chat', 'sps agent --tool codex "Fix tests"', 'sps agent status'] },
  setup:     { desc: '初始环境配置（凭证、目录、配置文件）', usage: 'sps setup [--force]',
    examples: ['sps setup', 'sps setup --force'] },
  tick:      { desc: '运行持续流水线', usage: 'sps tick <project> [--json]',
    examples: ['sps tick my-project', 'sps tick proj1 proj2'] },
  card:      { desc: '卡片管理（创建、看板）', usage: 'sps card <子命令> <project> [参数]', subs: {
    add: '创建新任务卡片',
    dashboard: '展示卡片看板',
  }, examples: ['sps card add my-project "New task"', 'sps card dashboard my-project'] },
  doctor:    { desc: '项目健康检查与状态修复', usage: 'sps doctor <project> [--json] [--fix] [--reset-state] [--skip-remote]',
    examples: ['sps doctor my-project', 'sps doctor my-project --json', 'sps doctor my-project --reset-state'] },
  scheduler: { desc: '调度器：Planning → Backlog 晋升', usage: 'sps scheduler <子命令> <project>', subs: {
    tick: '执行一次调度 tick',
  }, examples: ['sps scheduler tick my-project'] },
  pipeline:  { desc: '流水线管理（启动、停止、状态、看板、自定义管线）', usage: 'sps pipeline <子命令> [args]', subs: {
    start: '启动持续流水线（= sps tick）',
    stop: '停止流水线（= sps stop）',
    status: '查看状态（= sps status）',
    reset: '重置卡片（= sps reset）',
    workers: 'Worker 仪表板（= sps worker dashboard）',
    board: '卡片看板（= sps card dashboard）',
    logs: '日志查看（= sps logs）',
    tick: '执行一次流水线 tick',
    list: '列出所有自定义管线',
    run: '执行自定义管线',
  }, examples: ['sps pipeline start my-project', 'sps pipeline list', 'sps pipeline run discuss "微服务vs单体"'] },
  worker:    { desc: 'Worker 生命周期管理', usage: 'sps worker <子命令> <project> [seq]', subs: {
    ps: '查看 Worker 进程状态',
    kill: '终止指定 Worker',
    launch: '启动 Worker 实例',
    dashboard: '展示 Worker 仪表板',
  }, examples: ['sps worker ps my-project', 'sps worker kill my-project 1', 'sps worker launch my-project 1'] },
  acp:       { desc: 'ACP 会话管理', usage: 'sps acp <子命令> <project> [args...]', subs: {
    ensure: '确保 ACP 会话存在',
    run: '运行 ACP 命令',
    prompt: '发送 prompt 到会话',
    status: '查看会话状态',
    stop: '停止 ACP 会话',
    pending: '查看待处理消息',
    respond: '响应待处理消息',
  }, examples: ['sps acp status my-project', 'sps acp ensure my-project'] },
  pm:        { desc: 'PM 后端操作（scan/move/comment/label）', usage: 'sps pm <子命令> <project> [args...]', subs: {
    scan: '扫描项目卡片',
    move: '移动卡片状态',
    comment: '添加卡片评论',
    checklist: '管理检查清单',
  }, examples: ['sps pm scan my-project', 'sps pm move my-project'] },
  qa:        { desc: 'QA 收尾：QA → merge → Done', usage: 'sps qa <子命令> <project>', subs: {
    tick: '执行一次 QA tick',
  }, examples: ['sps qa tick my-project'] },
  monitor:   { desc: '异常检测与诊断', usage: 'sps monitor <子命令> <project>', subs: {
    tick: '执行一次监控 tick',
  }, examples: ['sps monitor tick my-project'] },
  project:   { desc: '项目初始化与验证', usage: 'sps project <子命令> <project>', subs: {
    init: '初始化新项目',
    doctor: '项目健康检查',
  }, examples: ['sps project init my-project', 'sps project doctor my-project'] },
  logs:      { desc: '实时日志查看器', usage: 'sps logs [project] [--err] [--lines N] [--no-follow]',
    examples: ['sps logs', 'sps logs my-project', 'sps logs my-project --err --lines 50'] },
  stop:      { desc: '停止运行中的 tick 进程', usage: 'sps stop <project> [--all]',
    examples: ['sps stop my-project', 'sps stop --all'] },
  reset:     { desc: '重置卡片状态，清理 worktree 和 branch，准备重跑', usage: 'sps reset <project> [--all] [--card N,N,N]',
    examples: ['sps reset my-project', 'sps reset my-project --all', 'sps reset my-project --card 5,6,7'] },
  status:    { desc: '显示所有项目运行状态', usage: 'sps status [--json]',
    examples: ['sps status', 'sps status --json'] },
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
  console.log('  --help         Show help (可配合命令使用，如 sps card --help)');
  console.log('  --version      Show version');
}

function printCommandHelp(cmd: string) {
  const info = COMMANDS[cmd];
  if (!info) return;

  console.log(`\n  ${cmd} — ${info.desc}\n`);
  console.log(`  Usage: ${info.usage}\n`);

  if (info.subs && Object.keys(info.subs).length > 0) {
    console.log('  子命令:');
    for (const [sub, desc] of Object.entries(info.subs)) {
      console.log(`    ${sub.padEnd(14)} ${desc}`);
    }
    console.log('');
  }

  if (info.examples && info.examples.length > 0) {
    console.log('  示例:');
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
const SUBCOMMAND_COMMANDS = new Set(['scheduler', 'pipeline', 'worker', 'acp', 'pm', 'qa', 'monitor', 'project', 'card']);

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
        console.log('No pipelines found. Create .sps/pipelines/<name>.yaml to get started.');
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

  // ─── status ─────────────────────────────────────────────────────
  if (args.command === 'status') {
    await executeStatus(args.flags);
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
