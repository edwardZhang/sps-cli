import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { ProjectConfig } from '../core/config.js';
import type { WorkerProvider } from '../interfaces/WorkerProvider.js';
import type { WorkerStatus } from '../models/types.js';

/**
 * Codex CLI patterns (differs from Claude):
 *
 * Ready prompt:   › <placeholder>
 *                 gpt-5.3-codex default · ...
 *
 * Completion:     returns to › prompt after task
 *
 * Update blocker: ✨ Update available!
 *                 › 1. Update now
 *                 2. Skip
 *                 3. Skip until next version
 *                 Press enter to continue
 *
 * Confirmation:   (none with --dangerously-bypass-approvals-and-sandbox)
 *
 * Exit command:   /quit (Claude uses /exit)
 */

/** Completion keywords in codex pane text. */
const COMPLETION_KEYWORDS =
  /\b(done|completed|finished|Next step:|committed|pushed|MR created|merge request)\b/i;

/** Codex ready prompt: › at start of line + model info line */
const CODEX_READY = /›\s.*$/m;
const CODEX_MODEL_LINE = /codex.*default.*·/i;

/** Codex update blocker pattern */
const CODEX_UPDATE_PROMPT = /Update available|Skip until next version/i;

/**
 * Run a tmux command. Returns null on failure.
 */
function tmux(args: string[]): string | null {
  try {
    return execFileSync('tmux', args, {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    if (stderr.includes('server exited unexpectedly') || stderr.includes('no server running')) {
      try {
        const uid = process.getuid?.() ?? 1000;
        const { rmSync } = require('node:fs');
        rmSync(`/tmp/tmux-${uid}`, { recursive: true, force: true });
        process.stderr.write('[codex-worker] Cleaned stale tmux socket, retrying\n');
        return execFileSync('tmux', args, {
          encoding: 'utf-8',
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        return null;
      }
    }
    return null;
  }
}

function sessionExists(session: string): boolean {
  return tmux(['has-session', '-t', session]) !== null;
}

function capturePaneText(session: string, lines: number): string {
  return tmux(['capture-pane', '-t', session, '-p', '-S', `-${lines}`]) ?? '';
}

export class CodexWorkerProvider implements WorkerProvider {
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
   * Launch Codex in a tmux session (interactive mode).
   * Handles session reuse and update prompt auto-skip.
   */
  async launch(session: string, worktree: string): Promise<void> {
    const codexCmd = 'codex --sandbox danger-full-access -a never --no-alt-screen';

    if (sessionExists(session)) {
      const pane = capturePaneText(session, 10);
      const codexAlive = CODEX_READY.test(pane) && CODEX_MODEL_LINE.test(pane);

      if (codexAlive) {
        // Codex running — clear conversation + switch worktree
        process.stderr.write(`[codex-worker] Reusing live Codex session ${session}\n`);
        tmux(['send-keys', '-t', session, '/clear', 'Enter']);
        await this.sleep(1_000);
        // Codex doesn't support cd mid-session, but we can try
        tmux(['send-keys', '-t', session, `/cd ${worktree}`, 'Enter']);
        await this.sleep(500);
        return;
      }

      // Session exists but Codex not running
      process.stderr.write(`[codex-worker] Reusing tmux session ${session}\n`);
      tmux(['send-keys', '-t', session, `cd ${worktree}`, 'Enter']);
      await this.sleep(500);
      tmux(['send-keys', '-t', session, codexCmd, 'Enter']);
      return;
    }

    // New session
    const result = tmux(['new-session', '-d', '-s', session, '-c', worktree]);
    if (result === null && !sessionExists(session)) {
      throw new Error(`Failed to create tmux session: ${session}`);
    }
    tmux(['send-keys', '-t', session, codexCmd, 'Enter']);
  }

  /**
   * Wait for Codex to be ready.
   * Must handle the update prompt blocker (auto-skip).
   */
  async waitReady(session: string, timeoutMs = 90_000): Promise<boolean> {
    const pollInterval = 3_000;
    const deadline = Date.now() + timeoutMs;
    let updateSkipped = false;

    // Codex is slower to start than Claude — wait longer before first check
    await this.sleep(5_000);

    while (Date.now() < deadline) {
      const text = capturePaneText(session, 30);

      // Handle update prompt — send Enter to dismiss, then skip
      if (!updateSkipped && CODEX_UPDATE_PROMPT.test(text)) {
        process.stderr.write('[codex-worker] Detected update prompt, skipping\n');
        // If showing numbered options (1/2/3), select 3 "Skip until next version"
        if (/1\. Update now/i.test(text)) {
          tmux(['send-keys', '-t', session, 'Down']);
          await this.sleep(300);
          tmux(['send-keys', '-t', session, 'Down']);
          await this.sleep(300);
        }
        tmux(['send-keys', '-t', session, 'Enter']);
        updateSkipped = true;
        await this.sleep(5_000);
        continue;
      }

      // Handle "Press enter to continue" after update banner
      if (/Press enter to continue/i.test(text)) {
        tmux(['send-keys', '-t', session, 'Enter']);
        await this.sleep(3_000);
        continue;
      }

      // Check if Codex is ready: › prompt + model info line
      if (CODEX_MODEL_LINE.test(text) && CODEX_READY.test(text)) {
        process.stderr.write('[codex-worker] Codex ready\n');
        return true;
      }

      // Also match "OpenAI Codex" banner + › prompt
      if (/OpenAI Codex/i.test(text) && /›/m.test(text)) {
        process.stderr.write('[codex-worker] Codex ready (banner match)\n');
        return true;
      }

      await this.sleep(pollInterval);
    }

    process.stderr.write(`[codex-worker] waitReady timed out after ${timeoutMs}ms\n`);
    return false;
  }

  /**
   * Send task prompt to Codex via tmux paste-buffer.
   */
  async sendTask(session: string, promptFile: string): Promise<void> {
    if (!existsSync(promptFile)) {
      throw new Error(`Prompt file does not exist: ${promptFile}`);
    }
    const content = readFileSync(promptFile, 'utf-8').trim();
    const bufferFile = `/tmp/workflow-task-${Date.now()}.txt`;
    const { writeFileSync: writeTmp, unlinkSync } = await import('node:fs');
    writeTmp(bufferFile, content);
    tmux(['load-buffer', bufferFile]);
    tmux(['paste-buffer', '-t', session]);
    try { unlinkSync(bufferFile); } catch { /* cleanup */ }
    await this.sleep(500);
    tmux(['send-keys', '-t', session, 'Enter']);
  }

  async inspect(session: string): Promise<{ alive: boolean; paneText: string }> {
    const alive = sessionExists(session);
    const paneText = alive ? capturePaneText(session, 50) : '';
    return { alive, paneText };
  }

  /**
   * Codex with --dangerously-bypass-approvals-and-sandbox doesn't need confirmation.
   * But if run without that flag, it may show approval prompts.
   * For now, always return not waiting since we use bypass mode.
   */
  async detectWaiting(session: string): Promise<{ waiting: boolean; destructive: boolean; prompt: string }> {
    // Codex in bypass mode doesn't have confirmation prompts
    // But check for any "Press enter" or similar blockers
    const pane = capturePaneText(session, 15);

    // Update prompt blocker
    if (CODEX_UPDATE_PROMPT.test(pane)) {
      return { waiting: true, destructive: false, prompt: 'Codex update prompt' };
    }

    return { waiting: false, destructive: false, prompt: '' };
  }

  /**
   * Detect completion by checking if Codex returned to › prompt after working.
   */
  async detectCompleted(
    session: string,
    logDir: string,
    _branch: string,
  ): Promise<WorkerStatus> {
    // Priority 1: task_completed marker file (same as Claude)
    const markerPath = `${logDir}/task_completed`;
    if (existsSync(markerPath)) {
      return 'COMPLETED';
    }

    // Priority 2: check for update prompt (needs auto-skip, not completion)
    const pane = capturePaneText(session, 20);
    if (CODEX_UPDATE_PROMPT.test(pane)) {
      return 'NEEDS_INPUT'; // will trigger auto-confirm to skip update
    }

    // Priority 3: completion keywords + back at › prompt
    if (COMPLETION_KEYWORDS.test(pane) && CODEX_READY.test(pane) && CODEX_MODEL_LINE.test(pane)) {
      return 'COMPLETED';
    }

    // Priority 4: session alive
    if (sessionExists(session)) {
      return 'ALIVE';
    }

    return 'DEAD';
  }

  async detectBlocked(session: string): Promise<boolean> {
    const pane = capturePaneText(session, 30);
    return /(error|fatal|rate.?limit|quota exceeded)/i.test(pane);
  }

  async sendFix(session: string, fixPrompt: string): Promise<void> {
    const escaped = fixPrompt.replace(/'/g, "'\\''");
    tmux(['send-keys', '-t', session, escaped, 'Enter']);
  }

  async resolveConflict(session: string, worktree: string, branch: string): Promise<void> {
    const instruction = [
      `There is a merge conflict on branch ${branch}.`,
      `Working directory: ${worktree}`,
      'Please resolve the conflict:',
      `1. Run: git fetch origin && git rebase origin/${this.config.GITLAB_MERGE_BRANCH}`,
      '2. Resolve any conflicts in the affected files',
      '3. Run: git add . && git rebase --continue',
      '4. Run: git push --force-with-lease',
    ].join('\n');
    tmux(['send-keys', '-t', session, instruction, 'Enter']);
  }

  /**
   * Stop Codex. Uses /quit (Codex's exit command, not /exit like Claude).
   */
  async stop(session: string): Promise<void> {
    if (!sessionExists(session)) return;

    if (this.config.WORKER_SESSION_REUSE) {
      // Keep session, just quit Codex
      tmux(['send-keys', '-t', session, '/quit', 'Enter']);
      return;
    }

    tmux(['send-keys', '-t', session, '/quit', 'Enter']);
    for (let i = 0; i < 5; i++) {
      await this.sleep(1_000);
      if (!sessionExists(session)) return;
    }
    tmux(['kill-session', '-t', session]);
  }

  async collectSummary(session: string): Promise<string> {
    return capturePaneText(session, 100);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
