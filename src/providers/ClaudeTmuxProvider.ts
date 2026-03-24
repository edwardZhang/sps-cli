import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import type { ProjectConfig } from '../core/config.js';
import type { WorkerProvider, LaunchResult } from '../interfaces/WorkerProvider.js';
import type { WorkerStatus } from '../models/types.js';

/** Completion keywords detected in pane text (priority 3). */
const COMPLETION_KEYWORDS =
  /\b(done|完成|全部完成|MR created|merge request|已提交|已推送)\b|🎉/i;

/** Confirmation prompt patterns (priority 2 / detectWaiting). */
const CONFIRMATION_PROMPT =
  /(Do you want to proceed|y\/n|press enter|confirm|approve)/i;

/** Destructive operation indicators. */
const DESTRUCTIVE_PATTERN = /(delete|remove|drop|rm -rf|truncate|destroy)/i;

/** Blocked indicators in pane text. */
const BLOCKED_PATTERN =
  /(error|fatal|panic|BLOCKED|stuck|cannot proceed|timed out|rate.?limit)/i;

/**
 * Run a tmux command via execFileSync and return stdout.
 * Returns null when the command fails (e.g. session does not exist).
 * On "server exited unexpectedly", auto-cleans stale socket and retries once.
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
      // Stale tmux socket — clean up and retry
      try {
        const uid = process.getuid?.() ?? 1000;
        rmSync(`/tmp/tmux-${uid}`, { recursive: true, force: true });
        process.stderr.write('[worker] Cleaned stale tmux socket, retrying\n');
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

/** Check whether a tmux session exists. */
function sessionExists(session: string): boolean {
  return tmux(['has-session', '-t', session]) !== null;
}

/** Capture recent pane text from a tmux session. */
function capturePaneText(session: string, lines: number): string {
  return tmux(['capture-pane', '-t', session, '-p', '-S', `-${lines}`]) ?? '';
}

export class ClaudeTmuxProvider implements WorkerProvider {
  private readonly config: ProjectConfig;

  constructor(config: ProjectConfig) {
    this.config = config;
  }

  /**
   * Ensure worktree directory exists and is clean.
   * This is largely a no-op when the worktree is already prepared.
   */
  async prepareEnv(worktree: string, _seq: string): Promise<void> {
    if (!existsSync(worktree)) {
      throw new Error(`Worktree directory does not exist: ${worktree}`);
    }
    // Verify the directory is a git worktree / repo
    try {
      execFileSync('git', ['-C', worktree, 'rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf-8',
        timeout: 5_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      throw new Error(`Directory is not a git worktree: ${worktree}`);
    }
  }

  /**
   * Launch a Claude Code worker inside a tmux session.
   *
   * Session reuse strategy (WORKER_SESSION_REUSE=true):
   *   1. Session exists + Claude running → reuse: /clear + cd worktree (keep context hot)
   *   2. Session exists + Claude not running → reuse session: cd + start claude
   *   3. No session → create new session + start claude
   */
  async launch(session: string, worktree: string, promptFile: string): Promise<LaunchResult> {
    const claudeCmd = 'claude --dangerously-skip-permissions';

    if (sessionExists(session)) {
      const pane = capturePaneText(session, 10);
      const claudeAlive = /❯\s*$/m.test(pane) || /bypass permissions/i.test(pane) || /shortcuts/i.test(pane);

      if (claudeAlive) {
        this.log.info(`Reusing live Claude session ${session}`);
        tmux(['send-keys', '-t', session, '/clear', 'Enter']);
        await this.sleep(1_000);
        tmux(['send-keys', '-t', session, `cd ${worktree}`, 'Enter']);
        await this.sleep(500);
      } else {
        this.log.info(`Reusing tmux session ${session} (Claude not running)`);
        tmux(['send-keys', '-t', session, `cd ${worktree}`, 'Enter']);
        await this.sleep(500);
        tmux(['send-keys', '-t', session, claudeCmd, 'Enter']);
      }
    } else {
      const result = tmux(['new-session', '-d', '-s', session, '-c', worktree]);
      if (result === null && !sessionExists(session)) {
        throw new Error(`Failed to create tmux session: ${session}`);
      }
      tmux(['send-keys', '-t', session, claudeCmd, 'Enter']);
    }

    // Wait for ready + send task prompt (old three-step flow)
    const ready = await this.waitReady(session, 90_000);
    if (!ready) {
      throw new Error('Worker did not become ready within timeout');
    }
    await this.sendTask(session, promptFile);

    return { pid: 0, outputFile: '' };
  }

  private log = { info: (msg: string) => process.stderr.write(`[worker] ${msg}\n`) };

  /**
   * Poll tmux pane text until Claude's ready prompt appears.
   * Default timeout: 30 seconds, poll interval: 2 seconds.
   */
  async waitReady(session: string, timeoutMs = 30_000): Promise<boolean> {
    const pollInterval = 2_000;
    const deadline = Date.now() + timeoutMs;

    // Wait at least 3s for Claude to start loading before polling
    await this.sleep(3_000);

    while (Date.now() < deadline) {
      const text = capturePaneText(session, 15);
      // Match Claude Code's actual ready state:
      // - The ❯ prompt on its own line (Claude's input prompt)
      // - "bypass permissions" indicator (only appears after Claude is fully loaded)
      // - "? for shortcuts" (appears at bottom when ready)
      if (/bypass permissions/i.test(text) ||
          /\? for shortcuts/i.test(text) ||
          /tips for shortcuts/i.test(text)) {
        return true;
      }
      // Also match the ❯ prompt but only if Claude banner has appeared
      if (/Claude Code/i.test(text) && /❯\s*$/m.test(text)) {
        return true;
      }
      await this.sleep(pollInterval);
    }

    return false;
  }

  /**
   * Send a task prompt file to the Claude session.
   */
  async sendTask(session: string, promptFile: string): Promise<void> {
    if (!existsSync(promptFile)) {
      throw new Error(`Prompt file does not exist: ${promptFile}`);
    }
    // Write prompt content to a temp file, load into tmux buffer, paste, then Enter.
    const content = readFileSync(promptFile, 'utf-8').trim();
    const bufferFile = `/tmp/sps-task-${Date.now()}.txt`;
    const { writeFileSync: writeTmp, unlinkSync } = await import('node:fs');
    writeTmp(bufferFile, content);
    tmux(['load-buffer', bufferFile]);
    tmux(['paste-buffer', '-t', session]);
    try { unlinkSync(bufferFile); } catch { /* cleanup */ }

    // Wait for TUI to finish processing the paste (bracket paste mode).
    // 500ms was too short for large prompts or loaded systems.
    await this.sleep(1_500);
    tmux(['send-keys', '-t', session, 'Enter']);

    // Verify the prompt was submitted — if the ❯ prompt doesn't appear
    // (meaning the worker started processing), retry Enter up to 3 times.
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.sleep(2_000);
      const pane = capturePaneText(session, 15);
      // If we see activity indicators, the task was submitted successfully
      if (/╭|─|●|⠋|⠙|⠹|thinking|running/i.test(pane)) {
        return;
      }
      // If we still see the idle prompt with text in the input area,
      // the Enter likely didn't register — retry
      if (/❯\s*\S/m.test(pane) || /\? for shortcuts/i.test(pane)) {
        this.log.info(`Enter may not have registered (attempt ${attempt + 1}/3), retrying...`);
        tmux(['send-keys', '-t', session, 'Enter']);
      }
    }
  }

  /**
   * Inspect a tmux session: check if alive and capture pane text.
   */
  async inspect(session: string): Promise<{ alive: boolean; paneText: string }> {
    const alive = sessionExists(session);
    const paneText = alive ? capturePaneText(session, 50) : '';
    return { alive, paneText };
  }

  /**
   * Multi-layer completion detection chain.
   *
   * Priority order:
   *   1. task_completed marker file in logDir
   *   2. Waiting for confirmation prompts (delegates to detectWaiting)
   *   3. Completion keywords in pane text
   *   4. MR exists on GitLab (skipped — returns ALIVE)
   *   5. tmux session alive → ALIVE
   *   6. Session dead + restart limit exceeded → DEAD_EXCEEDED
   */
  async detectCompleted(
    session: string,
    logDir: string,
    _branch: string,
  ): Promise<WorkerStatus> {
    // Priority 1: task_completed marker file
    const markerPath = `${logDir}/task_completed`;
    if (existsSync(markerPath)) {
      return 'COMPLETED';
    }

    // Priority 2: waiting for confirmation
    const waitState = await this.detectWaiting(session);
    if (waitState.waiting) {
      return waitState.destructive ? 'NEEDS_INPUT' : 'AUTO_CONFIRM';
    }

    // Priority 3: completion keywords in pane text
    // Use 200 lines — completion keywords can be pushed off-screen by post-task
    // output (e.g. long-running commands the worker started after finishing).
    const paneText = capturePaneText(session, 200);
    if (COMPLETION_KEYWORDS.test(paneText)) {
      return 'COMPLETED';
    }

    // Priority 4: MR exists (skipped for now)

    // Priority 5: session alive
    if (sessionExists(session)) {
      return 'ALIVE';
    }

    // Priority 6: session dead — check restart limit
    // The restart count is tracked externally by the engine via state.json.
    // Here we simply report DEAD_EXCEEDED vs DEAD so the engine can decide.
    // Without access to the restart counter, report DEAD and let the caller
    // escalate to DEAD_EXCEEDED if the limit is reached.
    return 'DEAD';
  }

  /**
   * Detect whether the worker is waiting for user confirmation.
   * Returns whether the prompt is destructive (delete/remove/drop etc.).
   */
  async detectWaiting(
    session: string,
  ): Promise<{ waiting: boolean; destructive: boolean; prompt: string }> {
    const paneText = capturePaneText(session, 30);

    const match = paneText.match(CONFIRMATION_PROMPT);
    if (!match) {
      return { waiting: false, destructive: false, prompt: '' };
    }

    // Extract the line containing the prompt for context
    const lines = paneText.split('\n');
    const promptLine =
      lines.find((l) => CONFIRMATION_PROMPT.test(l))?.trim() ?? match[0];

    const destructive = DESTRUCTIVE_PATTERN.test(paneText);
    return { waiting: true, destructive, prompt: promptLine };
  }

  /**
   * Check pane text for blocked indicators (errors, stuck states).
   */
  async detectBlocked(session: string): Promise<boolean> {
    const paneText = capturePaneText(session, 30);
    return BLOCKED_PATTERN.test(paneText);
  }

  /**
   * Send a fix prompt to the Claude session (e.g. after CI failure).
   */
  async sendFix(session: string, fixPrompt: string, _resumeSessionId?: string): Promise<void> {
    // Escape any single quotes in the prompt for safe tmux transmission
    const escaped = fixPrompt.replace(/'/g, "'\\''");
    tmux(['send-keys', '-t', session, escaped, 'Enter']);
  }

  /**
   * Send conflict resolution instructions to the Claude session.
   */
  async resolveConflict(
    session: string,
    worktree: string,
    branch: string,
    _resumeSessionId?: string,
  ): Promise<void> {
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
   * Release a worker session after task completion.
   *
   * WORKER_SESSION_REUSE=true:  do nothing — keep Claude running so the
   *   next task can hot-reuse the session via /clear + cd (preserves
   *   session state, env vars, loaded MCP servers, etc.).
   *
   * WORKER_SESSION_REUSE=false: exit Claude but keep tmux session alive
   *   (next launch will restart Claude in the existing session).
   */
  async release(session: string): Promise<void> {
    if (!sessionExists(session)) return;

    if (this.config.WORKER_SESSION_REUSE) {
      // Keep everything alive — next launch() will /clear + cd + send prompt
      this.log.info(`Session ${session} kept alive for reuse`);
      return;
    }

    // Exit Claude but keep tmux session
    tmux(['send-keys', '-t', session, '/exit', 'Enter']);
  }

  /**
   * Force-stop a worker session (error recovery, cleanup).
   * Always exits Claude and kills the tmux session.
   */
  async stop(session: string): Promise<void> {
    if (!sessionExists(session)) return;

    tmux(['send-keys', '-t', session, '/exit', 'Enter']);
    for (let i = 0; i < 5; i++) {
      await this.sleep(1_000);
      if (!sessionExists(session)) return;
    }
    tmux(['kill-session', '-t', session]);
  }

  /**
   * Capture the last 100 lines of pane text as a summary.
   */
  async collectSummary(session: string): Promise<string> {
    return capturePaneText(session, 100);
  }

  /** Helper: sleep for the given milliseconds. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
