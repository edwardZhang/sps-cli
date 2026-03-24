/**
 * CodexExecProvider — one-shot print-mode worker using `codex exec`.
 *
 * Eliminates all tmux interaction. Process lifecycle = task lifecycle.
 * Uses `codex exec resume <sessionId>` for context continuity.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectConfig } from '../core/config.js';
import type { WorkerProvider, LaunchResult } from '../interfaces/WorkerProvider.js';
import type { WorkerStatus } from '../models/types.js';
import {
  tailFile,
  parseCodexSessionId,
  isProcessAlive,
  killProcessGroup,
} from './outputParser.js';

/** Completion indicators. */
const COMPLETION_KEYWORDS =
  /\b(done|completed|finished|committed|pushed|MR created|merge request)\b/i;

/**
 * Track spawned child processes by session name.
 */
const activeProcesses = new Map<string, {
  child: ChildProcess;
  outputFile: string;
  exitCode: number | null;
}>();

export class CodexExecProvider implements WorkerProvider {
  private readonly config: ProjectConfig;

  constructor(config: ProjectConfig) {
    this.config = config;
  }

  async prepareEnv(worktree: string, _seq: string): Promise<void> {
    if (!existsSync(worktree)) {
      throw new Error(`Worktree directory does not exist: ${worktree}`);
    }
    try {
      execFileSync('git', ['-C', worktree, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error(`Directory is not a git worktree: ${worktree}`);
    }
  }

  async launch(session: string, worktree: string, promptFile: string): Promise<LaunchResult> {
    if (!existsSync(promptFile)) {
      throw new Error(`Prompt file does not exist: ${promptFile}`);
    }

    const prompt = readFileSync(promptFile, 'utf-8').trim();
    const outputFile = resolve(
      this.config.raw.LOGS_DIR || `/tmp/sps-${this.config.PROJECT_NAME}`,
      `${session}-${Date.now()}.jsonl`,
    );

    return this.spawnCodex(session, worktree, prompt, outputFile);
  }

  async inspect(session: string): Promise<{
    alive: boolean;
    paneText: string;
    pid?: number;
    exitCode?: number;
  }> {
    const proc = activeProcesses.get(session);
    if (!proc) {
      return { alive: false, paneText: '', pid: undefined, exitCode: undefined };
    }

    const pid = proc.child.pid ?? 0;
    const alive = pid > 0 && isProcessAlive(pid);
    const paneText = tailFile(proc.outputFile, 50);

    return { alive, paneText, pid, exitCode: proc.exitCode ?? undefined };
  }

  async detectCompleted(
    session: string,
    logDir: string,
    _branch: string,
  ): Promise<WorkerStatus> {
    const markerPath = `${logDir}/task_completed`;
    if (existsSync(markerPath)) {
      return 'COMPLETED';
    }

    const proc = activeProcesses.get(session);
    if (!proc) return 'DEAD';

    const pid = proc.child.pid ?? 0;
    if (pid > 0 && isProcessAlive(pid)) {
      return 'ALIVE';
    }

    // Process exited
    if (proc.exitCode === 0) {
      return 'COMPLETED';
    }

    return 'DEAD';
  }

  async detectWaiting(
    _session: string,
  ): Promise<{ waiting: boolean; destructive: boolean; prompt: string }> {
    // codex exec with --dangerously-bypass-approvals-and-sandbox never waits
    return { waiting: false, destructive: false, prompt: '' };
  }

  async detectBlocked(_session: string): Promise<boolean> {
    return false;
  }

  async sendFix(
    session: string,
    fixPrompt: string,
    resumeSessionId?: string,
  ): Promise<LaunchResult> {
    const worktree = '.';
    const outputFile = resolve(
      this.config.raw.LOGS_DIR || `/tmp/sps-${this.config.PROJECT_NAME}`,
      `${session}-fix-${Date.now()}.jsonl`,
    );

    return this.spawnCodex(session, worktree, fixPrompt, outputFile, resumeSessionId);
  }

  async resolveConflict(
    session: string,
    worktree: string,
    branch: string,
    resumeSessionId?: string,
  ): Promise<LaunchResult> {
    const instruction = [
      `There is a merge conflict on branch ${branch}.`,
      `Working directory: ${worktree}`,
      'Please resolve the conflict:',
      `1. Run: git fetch origin && git rebase origin/${this.config.GITLAB_MERGE_BRANCH}`,
      '2. Resolve any conflicts in the affected files',
      '3. Run: git add . && git rebase --continue',
      '4. Run: git push --force-with-lease',
    ].join('\n');

    const outputFile = resolve(
      this.config.raw.LOGS_DIR || `/tmp/sps-${this.config.PROJECT_NAME}`,
      `${session}-conflict-${Date.now()}.jsonl`,
    );

    return this.spawnCodex(session, worktree, instruction, outputFile, resumeSessionId);
  }

  async release(_session: string): Promise<void> {
    activeProcesses.delete(_session);
  }

  async stop(session: string): Promise<void> {
    const proc = activeProcesses.get(session);
    if (!proc) return;

    const pid = proc.child.pid;
    if (pid && isProcessAlive(pid)) {
      await killProcessGroup(pid);
    }
    activeProcesses.delete(session);
  }

  async collectSummary(session: string): Promise<string> {
    const proc = activeProcesses.get(session);
    if (!proc) return '';
    return tailFile(proc.outputFile, 100);
  }

  // ─── Internal ────────────────────────────────────────────────────

  private spawnCodex(
    session: string,
    worktree: string,
    prompt: string,
    outputFile: string,
    resumeSessionId?: string,
  ): LaunchResult {
    // Ensure output directory exists
    const { mkdirSync } = require('node:fs');
    const { dirname } = require('node:path');
    try { mkdirSync(dirname(outputFile), { recursive: true }); } catch { /* exists */ }

    const outStream = createWriteStream(outputFile, { flags: 'a' });

    let args: string[];
    if (resumeSessionId) {
      // codex exec resume <session_id> "prompt" --json ...
      args = [
        'exec', 'resume', resumeSessionId, '-',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
      ];
    } else {
      // codex exec "prompt" --json ...
      args = [
        'exec', '-',
        '--json',
        '--dangerously-bypass-approvals-and-sandbox',
      ];
    }

    const child = spawn('codex', args, {
      cwd: worktree,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env },
    });

    child.stdout?.pipe(outStream);
    child.stderr?.on('data', (chunk: Buffer) => {
      outStream.write(chunk);
    });

    // Write prompt to stdin and close
    child.stdin?.write(prompt);
    child.stdin?.end();

    const entry = { child, outputFile, exitCode: null as number | null };
    activeProcesses.set(session, entry);

    child.on('exit', (code) => {
      entry.exitCode = code ?? 1;
      outStream.end();
    });

    child.unref();

    this.log(`Spawned codex exec for ${session} (pid=${child.pid}), output=${outputFile}`);

    return {
      pid: child.pid ?? 0,
      outputFile,
      sessionId: resumeSessionId,
    };
  }

  async extractSessionIdAsync(session: string): Promise<string | null> {
    await new Promise((r) => setTimeout(r, 5_000));
    const proc = activeProcesses.get(session);
    if (!proc) return null;
    return parseCodexSessionId(proc.outputFile);
  }

  private log(msg: string): void {
    process.stderr.write(`[codex-exec] ${msg}\n`);
  }
}
