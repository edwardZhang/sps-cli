/**
 * CodexExecProvider — one-shot print-mode worker using `codex exec`.
 *
 * Eliminates all tmux interaction. Process lifecycle = task lifecycle.
 * Uses `codex exec resume <sessionId>` for context continuity.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import type { ProjectConfig } from '../core/config.js';
import type { WorkerProvider, LaunchResult } from '../interfaces/WorkerProvider.js';
import type { WorkerStatus } from '../models/types.js';
import {
  tailFile,
  parseCodexSessionId,
  isProcessAlive,
  killProcessGroup,
  extractLastAssistantText,
  branchCommitsAhead,
  branchPushed,
} from './outputParser.js';
import { readState } from '../core/state.js';

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

    // Fallback: recover from state.json
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
    const markerPath = `${logDir}/task_completed`;
    if (existsSync(markerPath)) {
      return 'COMPLETED';
    }

    // Resolve process info — in-memory AND state.json (need both)
    const proc = activeProcesses.get(session);
    const slotInfo = this.findSlotBySession(session);
    const pid = proc?.child.pid ?? slotInfo?.pid ?? 0;
    const exitCode = proc?.exitCode ?? slotInfo?.exitCode ?? null;

    if (!pid && !proc) {
      return 'DEAD';
    }

    // Process still running
    if (pid > 0 && isProcessAlive(pid)) {
      return 'ALIVE';
    }

    // Process exited — verify with git artifacts
    const worktree = slotInfo?.worktree ?? null;
    const outputFile = proc?.outputFile ?? slotInfo?.outputFile ?? null;
    const baseBranch = this.config.GITLAB_MERGE_BRANCH;

    if (worktree && branch) {
      const pushed = branchPushed(worktree, branch);
      const commitsAhead = pushed
        ? branchCommitsAhead(worktree, branch, baseBranch)
        : 0;

      if (pushed && commitsAhead > 0) {
        return 'COMPLETED';
      }

      // Worker may have committed locally but not pushed.
      // Check for local commits ahead of base and auto-push.
      if (!pushed) {
        const localAhead = branchCommitsAhead(worktree, branch, baseBranch);
        if (localAhead > 0) {
          this.log(`Branch ${branch} has ${localAhead} local commits but not pushed, auto-pushing`);
          try {
            execFileSync('git', ['-C', worktree, 'push', '-u', 'origin', branch], {
              encoding: 'utf-8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'],
            });
            this.log(`Auto-push succeeded for branch ${branch}`);
            return 'COMPLETED';
          } catch (pushErr) {
            this.log(`Auto-push failed for branch ${branch}: ${pushErr}`);
            // Fall through to other checks
          }
        }
      }
    }

    // Check output text for completion keywords — only when git verification
    // is unavailable (no worktree or branch).
    if (outputFile && (!worktree || !branch)) {
      const lastText = extractLastAssistantText(outputFile);
      if (COMPLETION_KEYWORDS.test(lastText)) {
        return 'COMPLETED';
      }
    }

    if (exitCode === 0) {
      return 'EXITED_INCOMPLETE';
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

  /**
   * Look up worker slot info from state.json by tmuxSession name.
   * Fallback when activeProcesses map is empty (SPS restarted).
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
        '.coral',
        'projects',
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
    process.stderr.write(`[codex-exec] ${msg}\n`);
  }
}
