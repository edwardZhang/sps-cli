/**
 * @module        outputParser
 * @description   Worker 输出解析工具，提供日志尾读、会话 ID 解析与进程检查
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-25
 * @updated       2026-04-03
 *
 * @role          provider
 * @layer         provider
 * @boundedContext worker-runtime
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

/**
 * Read the last N lines from a file efficiently.
 * Returns empty string if file doesn't exist.
 */
export function tailFile(filePath: string, lines: number): string {
  if (!existsSync(filePath)) return '';
  try {
    const content = readFileSync(filePath, 'utf-8');
    const allLines = content.split('\n');
    return allLines.slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * Get file size in bytes (for checking if output is being written).
 */
export function fileSize(filePath: string): number {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Parse session ID from a Claude stream-json output file.
 *
 * Claude --output-format stream-json emits lines like:
 *   {"type":"result",...,"session_id":"uuid",...}
 *
 * We also check the very first system message.
 */
export function parseClaudeSessionId(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.session_id) return obj.session_id;
      } catch {
        // not valid JSON, skip
      }
    }
  } catch {
    // file read error
  }
  return null;
}

/**
 * Parse session ID from a Codex exec --json JSONL output file.
 *
 * Codex emits JSONL events. Look for session/conversation ID.
 */
export function parseCodexSessionId(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const content = readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        // Codex uses conversation_id or session_id
        if (obj.conversation_id) return obj.conversation_id;
        if (obj.session_id) return obj.session_id;
        if (obj.id && typeof obj.id === 'string' && obj.type === 'session_start') return obj.id;
      } catch {
        // not valid JSON
      }
    }
  } catch {
    // file read error
  }
  return null;
}

/**
 * Check if a process is alive by sending signal 0.
 */
export function isProcessAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Kill a process group. First SIGTERM, then SIGKILL after timeout.
 * Uses negative PID to signal the entire process group.
 */
export async function killProcessGroup(pid: number, timeoutMs = 5_000): Promise<void> {
  if (!isProcessAlive(pid)) return;

  try {
    // Signal the process group
    process.kill(-pid, 'SIGTERM');
  } catch {
    // Process group may not exist, try direct kill
    try { process.kill(pid, 'SIGTERM'); } catch { return; }
  }

  // Wait for graceful shutdown
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await new Promise((r) => setTimeout(r, 500));
  }

  // Force kill
  try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ }
}

// ─── Git Artifact Verification ─────────────────────────────────────

/**
 * Check if a branch has commits ahead of a base branch.
 * This is the most reliable signal that the worker actually did work.
 *
 * Returns the number of commits ahead, or -1 on error.
 */
export function branchCommitsAhead(worktree: string, branch: string, baseBranch: string): number {
  try {
    // Fetch latest remote state (best-effort, may fail offline)
    try {
      execFileSync('git', ['-C', worktree, 'fetch', 'origin', '--quiet'], {
        timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { /* offline or no remote — ok, use local state */ }

    const output = execFileSync(
      'git',
      ['-C', worktree, 'rev-list', '--count', `origin/${baseBranch}..${branch}`],
      { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    return parseInt(output, 10) || 0;
  } catch {
    return -1; // git error
  }
}

/**
 * Check if branch has been pushed to remote (remote tracking ref exists).
 */
export function branchPushed(worktree: string, branch: string): boolean {
  try {
    execFileSync(
      'git',
      ['-C', worktree, 'rev-parse', '--verify', `origin/${branch}`],
      { encoding: 'utf-8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract the last assistant message text from Claude stream-json output.
 * Useful for verifying task completion.
 */
export function extractLastAssistantText(filePath: string): string {
  if (!existsSync(filePath)) return '';
  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());
    let lastText = '';
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        // Claude stream-json: assistant messages have content as array of blocks
        if (obj.type === 'assistant' && Array.isArray(obj.message?.content)) {
          for (const block of obj.message.content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              lastText = block.text;
            }
          }
        }
        // Claude stream-json: assistant messages may have content as string (older format)
        if (obj.type === 'assistant' && typeof obj.message?.content === 'string') {
          lastText = obj.message.content;
        }
        // Result type (session end)
        if (obj.type === 'result' && typeof obj.result === 'string') {
          lastText = obj.result;
        }
        // Content block delta (streaming)
        if (obj.type === 'content_block_delta' && obj.delta?.text) {
          lastText += obj.delta.text;
        }
      } catch { /* skip non-JSON lines */ }
    }
    return lastText;
  } catch {
    return '';
  }
}
