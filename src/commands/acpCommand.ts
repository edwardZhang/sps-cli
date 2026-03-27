import { ProjectContext } from '../core/context.js';
import { ACPWorkerRuntime } from '../providers/ACPWorkerRuntime.js';
import { Logger } from '../core/logger.js';
import type { ACPTool } from '../models/acp.js';

function parseTool(value: string | undefined): ACPTool | undefined {
  if (!value) return undefined;
  if (value === 'claude' || value === 'codex') return value;
  return undefined;
}

function renderSessionSummary(session: {
  slot: string;
  tool: string;
  sessionId: string;
  status: string;
  sessionState: string;
  currentRun: { runId: string; status: string; promptPreview: string } | null;
}): string {
  const run = session.currentRun
    ? `run=${session.currentRun.runId} ${session.currentRun.status} "${session.currentRun.promptPreview}"`
    : 'run=none';
  return `${session.slot} ${session.tool} session=${session.sessionId} slot=${session.status} remote=${session.sessionState} ${run}`;
}

export async function executeAcpCommand(
  project: string,
  subcommand: string,
  positionals: string[],
  flags: Record<string, boolean>,
): Promise<void> {
  const log = new Logger('acp', project);
  const jsonOutput = !!flags.json;

  const ctx = ProjectContext.load(project);
  const runtime = new ACPWorkerRuntime(ctx);

  if (subcommand === 'ensure') {
    const slot = positionals[0];
    if (!slot) {
      throw new Error('Usage: sps acp ensure <project> <slot> [claude|codex]');
    }
    const tool = parseTool(positionals[1]);
    const session = await runtime.ensureSession(slot, tool);
    if (jsonOutput) {
      console.log(JSON.stringify(session, null, 2));
    } else {
      log.ok(`ACP session ready: ${renderSessionSummary(session)}`);
    }
    return;
  }

  if (subcommand === 'run' || subcommand === 'prompt') {
    const slot = positionals[0];
    if (!slot) {
      throw new Error('Usage: sps acp run <project> <slot> [claude|codex] "<prompt>"');
    }
    let tool = parseTool(positionals[1]);
    let promptStartIdx = 1;
    if (tool) {
      promptStartIdx = 2;
    } else {
      tool = undefined;
    }
    const prompt = positionals.slice(promptStartIdx).join(' ').trim();
    if (!prompt) {
      throw new Error('Prompt is required');
    }
    const session = await runtime.startRun(slot, prompt, tool);
    if (jsonOutput) {
      console.log(JSON.stringify(session, null, 2));
    } else {
      log.ok(`ACP run started: ${renderSessionSummary(session)}`);
    }
    return;
  }

  if (subcommand === 'status') {
    const slot = positionals[0];
    const state = await runtime.inspect(slot);
    if (jsonOutput) {
      console.log(JSON.stringify(state, null, 2));
    } else {
      const sessions = Object.values(state.sessions);
      if (sessions.length === 0) {
        log.info('No ACP sessions tracked');
      } else {
        for (const session of sessions) {
          log.info(renderSessionSummary(session));
        }
      }
    }
    return;
  }

  if (subcommand === 'stop') {
    const slot = positionals[0];
    if (!slot) {
      throw new Error('Usage: sps acp stop <project> <slot>');
    }
    await runtime.stopSession(slot);
    if (jsonOutput) {
      console.log(JSON.stringify({ ok: true, project, slot }, null, 2));
    } else {
      log.ok(`Stopped ACP session for ${slot}`);
    }
    return;
  }

  throw new Error('Usage: sps acp <ensure|run|prompt|status|stop> <project> [args...]');
}
