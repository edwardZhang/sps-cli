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
  branchCommitsAhead,
  branchPushed,
} from './outputParser.js';
import { readState } from '../core/state.js';

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
    // Try in-memory tracking first
    const proc = activeProcesses.get(session);
    if (proc) {
      const pid = proc.child.pid ?? 0;
      const alive = pid > 0 && isProcessAlive(pid);
      return {
        alive,
        paneText: tailFile(proc.outputFile, 50),
        pid,
        exitCode: proc.exitCode ?? undefined,
      };
    }

    // Fallback: recover from state.json (SPS process may have restarted)
    const slotInfo = this.findSlotBySession(session);
    if (slotInfo?.pid) {
      const alive = isProcessAlive(slotInfo.pid);
      const paneText = slotInfo.outputFile ? tailFile(slotInfo.outputFile, 50) : '';
      return {
        alive,
        paneText,
        pid: slotInfo.pid,
        exitCode: alive ? undefined : (slotInfo.exitCode ?? undefined),
      };
    }

    return { alive: false, paneText: '', pid: undefined, exitCode: undefined };
  }

  async detectCompleted(
    session: string,
    logDir: string,
    branch: string,
  ): Promise<WorkerStatus> {
    // Priority 1: marker file
    const markerPath = `${logDir}/task_completed`;
    if (existsSync(markerPath)) {
      return 'COMPLETED';
    }

    // Resolve process info — in-memory or state.json fallback
    const proc = activeProcesses.get(session);
    const slotInfo = !proc ? this.findSlotBySession(session) : null;
    const pid = proc?.child.pid ?? slotInfo?.pid ?? 0;
    const outputFile = proc?.outputFile ?? slotInfo?.outputFile ?? null;
    const exitCode = proc?.exitCode ?? slotInfo?.exitCode ?? null;

    if (!pid && !proc) {
      // No process tracked at all — treat as dead
      return 'DEAD';
    }

    // Priority 2: process still running
    if (pid > 0 && isProcessAlive(pid)) {
      return 'ALIVE';
    }

    // ── Process has exited — verify with artifacts ──
    // The key question: did the worker actually complete the task?
    // Exit code 0 alone is NOT enough — worker may have:
    //   - Hit token/budget limit and exited gracefully
    //   - Said "I can't do this" and exited
    //   - Completed coding but not pushed / not created MR

    // Check git artifacts: branch pushed with commits ahead of base
    const worktree = slotInfo?.worktree ?? null;
    const baseBranch = this.config.GITLAB_MERGE_BRANCH;

    if (worktree && branch) {
      const pushed = branchPushed(worktree, branch);
      const commitsAhead = pushed
        ? branchCommitsAhead(worktree, branch, baseBranch)
        : 0;

      if (pushed && commitsAhead > 0) {
        // Branch has been pushed with new commits — worker did real work.
        // ExecutionEngine will additionally check MR existence before moving to QA.
        return 'COMPLETED';
      }
    }

    // Check output text for completion keywords as secondary signal
    if (outputFile) {
      const lastText = extractLastAssistantText(outputFile);
      if (COMPLETION_KEYWORDS.test(lastText)) {
        return 'COMPLETED';
      }
    }

    // Process exited but no artifacts found
    if (exitCode === 0) {
      // Graceful exit but nothing to show for it
      return 'EXITED_INCOMPLETE';
    }

    // Non-zero exit — worker crashed
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
    // Find worktree from state.json
    const slotInfo = this.findSlotBySession(session);
    const worktree = slotInfo?.worktree || '.';

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

  /**
   * Look up worker slot info from state.json by tmuxSession name.
   * Used as fallback when activeProcesses map is empty (SPS restarted).
   */
  private findSlotBySession(session: string): {
    pid: number | null;
    outputFile: string | null;
    exitCode: number | null;
    sessionId: string | null;
    worktree: string | null;
  } | null {
    try {
      const stateFile = resolve(
        process.env.HOME || '~',
        '.projects',
        this.config.PROJECT_NAME,
        'runtime',
        'state.json',
      );
      if (!existsSync(stateFile)) return null;
      const state = readState(stateFile, this.config.MAX_CONCURRENT_WORKERS);
      for (const slot of Object.values(state.workers)) {
        if (slot.tmuxSession === session && slot.mode === 'print') {
          return {
            pid: slot.pid ?? null,
            outputFile: slot.outputFile ?? null,
            exitCode: slot.exitCode ?? null,
            sessionId: slot.sessionId ?? null,
            worktree: slot.worktree ?? null,
          };
        }
      }
    } catch { /* state read error */ }
    return null;
  }

  private log(msg: string): void {
    process.stderr.write(`[claude-print] ${msg}\n`);
  }
}
