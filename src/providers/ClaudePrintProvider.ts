/**
 * ClaudePrintProvider — one-shot print-mode worker using `claude -p`.
 *
 * Eliminates all tmux interaction. Process lifecycle = task lifecycle.
 * Uses --resume <sessionId> for context continuity across tasks.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import type { ProjectConfig } from '../core/config.js';
import type { WorkerProvider, LaunchResult } from '../interfaces/WorkerProvider.js';
import type { WorkerStatus } from '../models/types.js';
import {
  tailFile,
  parseClaudeSessionId,
  isProcessAlive,
  killProcessGroup,
  extractLastAssistantText,
} from './outputParser.js';

/** Completion indicators in the final assistant message. */
const COMPLETION_KEYWORDS =
  /\b(done|完成|全部完成|MR created|merge request|已提交|已推送)\b|🎉/i;

/**
 * Track spawned child processes by session name.
 * Needed because inspect()/detectCompleted() receive session name, not PID.
 */
const activeProcesses = new Map<string, {
  child: ChildProcess;
  outputFile: string;
  exitCode: number | null;
}>();

export class ClaudePrintProvider implements WorkerProvider {
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

  /**
   * Spawn `claude -p` with the prompt piped via stdin.
   * Returns immediately — the process runs in background.
   */
  async launch(session: string, worktree: string, promptFile: string): Promise<LaunchResult> {
    if (!existsSync(promptFile)) {
      throw new Error(`Prompt file does not exist: ${promptFile}`);
    }

    const prompt = readFileSync(promptFile, 'utf-8').trim();
    const outputFile = resolve(
      this.config.raw.LOGS_DIR || `/tmp/sps-${this.config.PROJECT_NAME}`,
      `${session}-${Date.now()}.jsonl`,
    );

    return this.spawnClaude(session, worktree, prompt, outputFile);
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

    return {
      alive,
      paneText,
      pid,
      exitCode: proc.exitCode ?? undefined,
    };
  }

  async detectCompleted(
    session: string,
    logDir: string,
    _branch: string,
  ): Promise<WorkerStatus> {
    // Priority 1: marker file
    const markerPath = `${logDir}/task_completed`;
    if (existsSync(markerPath)) {
      return 'COMPLETED';
    }

    const proc = activeProcesses.get(session);
    if (!proc) {
      // No tracked process — treat as dead
      return 'DEAD';
    }

    const pid = proc.child.pid ?? 0;
    const alive = pid > 0 && isProcessAlive(pid);

    if (alive) {
      return 'ALIVE';
    }

    // Process has exited — check exit code + output
    if (proc.exitCode === 0) {
      // Verify completion by checking output for success indicators
      const lastText = extractLastAssistantText(proc.outputFile);
      if (COMPLETION_KEYWORDS.test(lastText)) {
        return 'COMPLETED';
      }
      // Exit 0 but no completion keyword — still consider completed
      // (claude -p exits 0 on normal completion)
      return 'COMPLETED';
    }

    // Non-zero exit — worker crashed or errored
    return 'DEAD';
  }

  /**
   * Print mode with --dangerously-skip-permissions never waits for input.
   */
  async detectWaiting(
    _session: string,
  ): Promise<{ waiting: boolean; destructive: boolean; prompt: string }> {
    return { waiting: false, destructive: false, prompt: '' };
  }

  async detectBlocked(_session: string): Promise<boolean> {
    return false;
  }

  /**
   * Send a fix prompt by spawning a NEW claude -p with --resume.
   * Returns a new LaunchResult with the new process info.
   */
  async sendFix(
    session: string,
    fixPrompt: string,
    resumeSessionId?: string,
  ): Promise<LaunchResult> {
    // Find worktree from the existing process or fall back
    const proc = activeProcesses.get(session);
    const worktree = proc ? (this.getWorktreeFromSession(session) || '.') : '.';

    const outputFile = resolve(
      this.config.raw.LOGS_DIR || `/tmp/sps-${this.config.PROJECT_NAME}`,
      `${session}-fix-${Date.now()}.jsonl`,
    );

    return this.spawnClaude(session, worktree, fixPrompt, outputFile, resumeSessionId);
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

    return this.spawnClaude(session, worktree, instruction, outputFile, resumeSessionId);
  }

  /**
   * No-op in print mode — process already exited.
   */
  async release(_session: string): Promise<void> {
    // Clean up tracking entry
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

  private spawnClaude(
    session: string,
    worktree: string,
    prompt: string,
    outputFile: string,
    resumeSessionId?: string,
  ): LaunchResult {
    const args = [
      '-p',  // print mode: reads prompt from stdin when no prompt arg given
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
    ];

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    }

    // Ensure output directory exists
    const { mkdirSync } = require('node:fs');
    const { dirname } = require('node:path');
    try { mkdirSync(dirname(outputFile), { recursive: true }); } catch { /* exists */ }

    const outStream = createWriteStream(outputFile, { flags: 'a' });

    const child = spawn('claude', args, {
      cwd: worktree,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true, // own process group for killProcessGroup()
      env: { ...process.env },
    });

    // Pipe stdout (stream-json) to output file
    child.stdout?.pipe(outStream);
    // Also capture stderr to output file
    child.stderr?.on('data', (chunk: Buffer) => {
      outStream.write(chunk);
    });

    // Write prompt to stdin and close
    child.stdin?.write(prompt);
    child.stdin?.end();

    // Track process
    const entry = { child, outputFile, exitCode: null as number | null };
    activeProcesses.set(session, entry);

    child.on('exit', (code) => {
      entry.exitCode = code ?? 1;
      outStream.end();
    });

    // Don't let this child block the parent from exiting
    child.unref();

    // Parse session ID from output once available (async)
    const sessionId = resumeSessionId || undefined;

    this.log(`Spawned claude -p for ${session} (pid=${child.pid}), output=${outputFile}`);

    return {
      pid: child.pid ?? 0,
      outputFile,
      sessionId,
    };
  }

  /**
   * Try to extract session ID from output file after process starts.
   * Called asynchronously — updates the tracking entry.
   */
  async extractSessionIdAsync(session: string): Promise<string | null> {
    // Wait a bit for output to be written
    await new Promise((r) => setTimeout(r, 3_000));
    const proc = activeProcesses.get(session);
    if (!proc) return null;
    return parseClaudeSessionId(proc.outputFile);
  }

  private getWorktreeFromSession(_session: string): string | null {
    // Could look up from state.json, but callers should provide worktree
    return null;
  }

  private log(msg: string): void {
    process.stderr.write(`[claude-print] ${msg}\n`);
  }
}
