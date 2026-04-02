/**
 * PipelineRunner — executes mode:steps pipelines.
 *
 * Sequentially runs steps (agent or shell), handles flow control
 * (abort/skip/retry/goto), variable substitution, and session reuse.
 * Agent steps run through DaemonClient (persistent daemon sessions).
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { StepsPipelineConfig, StepConfig } from '../core/pipelineConfig.js';
import { parseOnFail, parseTimeout } from '../core/pipelineConfig.js';
import { waitAndStream, type StreamResult } from './agentRenderer.js';
import { createSessionContext } from '../core/sessionContext.js';
import type { ACPTool } from '../models/acp.js';

const DIM = '\x1b[90m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

interface RunContext {
  userPrompt: string;
  cwd: string;
  verbose: boolean;
}

// ─── Variable Substitution ──────────────────────────────────────

function substituteVars(text: string, ctx: RunContext, stepName: string): string {
  return text
    .replace(/\$\{USER_PROMPT\}/g, ctx.userPrompt)
    .replace(/\$\{CWD\}/g, ctx.cwd)
    .replace(/\$\{STEP_NAME\}/g, stepName);
}

function resolvePrompt(step: StepConfig, ctx: RunContext): string {
  let prompt = '';
  if (step.prompt_file) {
    try {
      prompt = readFileSync(resolve(ctx.cwd, step.prompt_file), 'utf-8');
    } catch (err) {
      throw new Error(`Step "${step.name}": cannot read prompt_file "${step.prompt_file}": ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (step.prompt) {
    prompt = step.prompt;
  }
  return substituteVars(prompt, ctx, step.name);
}

// ─── Shell Step ─────────────────────────────────────────────────

function runShellStep(step: StepConfig, ctx: RunContext): { success: boolean; output: string } {
  const command = substituteVars(step.run!, ctx, step.name);
  const timeout = parseTimeout(step.timeout) ?? 300_000; // default 5min

  try {
    const output = execSync(command, {
      cwd: ctx.cwd,
      encoding: 'utf-8',
      timeout,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { success: true, output };
  } catch (err: any) {
    const output = (err.stdout || '') + (err.stderr || '');
    return { success: false, output };
  }
}

// ─── Agent Step ─────────────────────────────────────────────────

async function runAgentStep(
  step: StepConfig,
  ctx: RunContext,
  activeSessions: Map<string, boolean>,
): Promise<{ success: boolean; output: string }> {
  const { DaemonClient } = await import('../daemon/daemonClient.js');
  const { ensureDaemon } = await import('./agentDaemon.js');
  const client = new DaemonClient();

  // Ensure daemon is running
  if (!(await client.isRunning())) {
    if (process.env.SPS_DAEMON_SOCKET) {
      throw new Error(`Cannot connect to remote daemon at ${process.env.SPS_DAEMON_SOCKET}`);
    }
    await ensureDaemon();
  }

  const sessionName = step.session || `pipeline-${step.name}-${Date.now()}`;
  const slot = `session-${sessionName}`;
  const tool = (step.agent || 'claude') as ACPTool;
  const prompt = resolvePrompt(step, ctx);

  // Build prompt with optional profile
  let fullPrompt = prompt;
  if (step.profile) {
    const profileContent = loadProfile(step.profile);
    if (profileContent) {
      fullPrompt = `[System instruction from profile: ${step.profile}]\n${profileContent}\n\n${prompt}`;
    }
  }

  // Ensure session (reuse if same session name)
  const remoteCwd = process.env.SPS_DAEMON_SOCKET ? undefined : ctx.cwd;
  await client.ensureSession(slot, tool, remoteCwd);
  activeSessions.set(sessionName, !!step.session); // track: true = named (keep), false = ephemeral (cleanup)

  // Start run
  await client.startRun(slot, fullPrompt, tool, remoteCwd);

  // Stream output
  const sessionCtx = createSessionContext({ cwd: ctx.cwd, tool });
  const isRemote = !!process.env.SPS_DAEMON_SOCKET;
  const result: StreamResult = await waitAndStream(
    { inspect: (s?: string) => client.inspect(s) } as any,
    slot,
    {
      stateFile: isRemote ? undefined : sessionCtx.paths.stateFile,
      verbose: ctx.verbose,
      logsDir: isRemote ? undefined : sessionCtx.paths.logsDir,
    },
  );

  // Clear run so slot is reusable for next step
  try { await client.clearRun(slot); } catch { /* best effort */ }

  process.stdout.write('\n');

  return {
    success: result.status === 'completed',
    output: result.output,
  };
}

/**
 * Load a profile from profiles/ directory.
 */
function loadProfile(name: string): string | null {
  const candidates = [
    resolve(import.meta.url.replace('file://', '').replace(/\/commands\/pipelineRunner\.js$/, ''), '..', 'profiles', `${name}.md`),
    resolve(process.cwd(), 'profiles', `${name}.md`),
    name,
  ];
  for (const p of candidates) {
    try { return readFileSync(p, 'utf-8'); } catch { /* try next */ }
  }
  process.stderr.write(`${DIM}Warning: profile "${name}" not found${RESET}\n`);
  return null;
}

// ─── Pipeline Runner ────────────────────────────────────────────

export async function executePipelineRun(
  config: StepsPipelineConfig,
  userPrompt: string,
  flags: Record<string, boolean>,
): Promise<void> {
  const ctx: RunContext = {
    userPrompt,
    cwd: process.cwd(),
    verbose: !!flags.verbose,
  };

  const steps = config.steps;
  const activeSessions = new Map<string, boolean>(); // sessionName → isNamed

  process.stderr.write(`${CYAN}▶ Pipeline: ${config.name}${RESET}`);
  if (config.description) process.stderr.write(` ${DIM}(${config.description})${RESET}`);
  process.stderr.write(`\n${DIM}  ${steps.length} steps${RESET}\n\n`);

  let stepIdx = 0;
  const retryCounts = new Map<string, number>();

  try {
    while (stepIdx < steps.length) {
      const step = steps[stepIdx];
      const isAgent = !!step.agent;
      const stepLabel = isAgent ? `${step.agent}${step.profile ? `:${step.profile}` : ''}` : 'shell';

      process.stderr.write(`${CYAN}── Step ${stepIdx + 1}/${steps.length}: ${step.name} (${stepLabel})${RESET}\n`);

      let result: { success: boolean; output: string };

      try {
        if (isAgent) {
          result = await runAgentStep(step, ctx, activeSessions);
        } else {
          result = runShellStep(step, ctx);
          // Print shell output
          if (result.output) {
            process.stdout.write(result.output);
            if (!result.output.endsWith('\n')) process.stdout.write('\n');
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`${RED}  Step "${step.name}" error: ${msg}${RESET}\n`);
        result = { success: false, output: msg };
      }

      if (result.success) {
        process.stderr.write(`${GREEN}  ✓ ${step.name} passed${RESET}\n\n`);
        retryCounts.delete(step.name);

        if (step.final) {
          process.stderr.write(`${GREEN}▶ Pipeline "${config.name}" completed${RESET}\n`);
          return;
        }

        stepIdx++;
        continue;
      }

      // Step failed — handle on_fail
      const onFail = parseOnFail(step.on_fail);

      if (onFail === 'abort') {
        process.stderr.write(`${RED}  ✗ ${step.name} failed — aborting pipeline${RESET}\n`);
        process.exitCode = 1;
        return;
      }

      if (onFail === 'skip') {
        process.stderr.write(`${YELLOW}  ⊘ ${step.name} failed — skipping${RESET}\n\n`);
        stepIdx++;
        continue;
      }

      if (typeof onFail === 'object' && 'retry' in onFail) {
        const count = (retryCounts.get(step.name) ?? 0) + 1;
        retryCounts.set(step.name, count);
        if (count >= onFail.retry) {
          process.stderr.write(`${RED}  ✗ ${step.name} failed after ${count} retries — aborting${RESET}\n`);
          process.exitCode = 1;
          return;
        }
        process.stderr.write(`${YELLOW}  ↻ ${step.name} failed — retry ${count}/${onFail.retry}${RESET}\n\n`);
        continue; // re-execute same step
      }

      if (typeof onFail === 'object' && 'goto' in onFail) {
        const targetIdx = steps.findIndex(s => s.name === onFail.goto);
        if (targetIdx < 0) {
          process.stderr.write(`${RED}  ✗ goto target "${onFail.goto}" not found — aborting${RESET}\n`);
          process.exitCode = 1;
          return;
        }
        process.stderr.write(`${YELLOW}  ↩ ${step.name} failed — goto ${onFail.goto}${RESET}\n\n`);
        stepIdx = targetIdx;
        continue;
      }

      // Default: abort
      process.stderr.write(`${RED}  ✗ ${step.name} failed — aborting pipeline${RESET}\n`);
      process.exitCode = 1;
      return;
    }

    process.stderr.write(`${GREEN}▶ Pipeline "${config.name}" completed (all steps passed)${RESET}\n`);
  } finally {
    // Cleanup ephemeral sessions (not named/reused ones)
    await cleanupSessions(activeSessions);
  }
}

async function cleanupSessions(sessions: Map<string, boolean>): Promise<void> {
  try {
    const { DaemonClient } = await import('../daemon/daemonClient.js');
    const client = new DaemonClient();
    if (!(await client.isRunning())) return;

    for (const [name, isNamed] of sessions) {
      if (isNamed) continue; // keep named sessions for future reuse
      const slot = `session-${name}`;
      try { await client.stopSession(slot); } catch { /* best effort */ }
    }
  } catch { /* daemon not running, nothing to clean */ }
}
