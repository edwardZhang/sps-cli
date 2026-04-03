/**
 * @module        acp-session-accumulator
 * @description   ACP 会话更新累加器，收集 Agent 进程的会话通知并提供结构化状态
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-31
 * @updated       2026-03-31
 *
 * @role          adapter
 * @layer         provider
 * @boundedContext acp
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

interface SessionUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export class SessionUpdateAccumulator {
  private textChunks: string[] = [];
  private toolCalls = new Map<string, { title: string; kind: string; status: string }>();
  private logFile: string | null = null;

  stopReason: string | null = null;
  hasPendingPermission = false;
  lastUpdateAt: string | null = null;

  /** Set a log file path — events will be appended as human-readable lines. */
  setLogFile(path: string): void {
    this.logFile = path;
    try { mkdirSync(dirname(path), { recursive: true }); } catch { /* exists */ }
  }

  reset(): void {
    this.textChunks = [];
    this.toolCalls.clear();
    this.stopReason = null;
    this.hasPendingPermission = false;
    this.lastUpdateAt = null;
  }

  handleUpdate(update: SessionUpdate): void {
    this.lastUpdateAt = new Date().toISOString();
    const ts = this.lastUpdateAt.slice(11, 23);  // HH:mm:ss.SSS

    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const content = update.content as { type: string; text?: string } | undefined;
        if (content?.type === 'text' && content.text) {
          this.textChunks.push(content.text);
          this.appendLog(`${ts} [assistant] ${content.text}`);
        }
        break;
      }
      case 'tool_call': {
        const id = update.toolCallId as string;
        const title = (update.title as string) ?? '';
        const kind = (update.kind as string) ?? 'other';
        const status = (update.status as string) ?? 'pending';
        this.toolCalls.set(id, { title, kind, status });
        this.appendLog(`${ts} [tool:${kind}] ${title} (${status})`);
        break;
      }
      case 'tool_call_update': {
        const id = update.toolCallId as string;
        const existing = this.toolCalls.get(id);
        const status = (update.status as string) ?? existing?.status ?? 'unknown';
        if (existing) {
          existing.status = status;
        }
        this.appendLog(`${ts} [tool_update] ${id} → ${status}`);
        break;
      }
      case 'usage_update': {
        const used = update.used as number | undefined;
        const size = update.size as number | undefined;
        if (used != null && size != null) {
          this.appendLog(`${ts} [usage] ${used}/${size} tokens`);
        }
        break;
      }
      default:
        // plan, agent_thought_chunk, available_commands_update, etc.
        break;
    }
  }

  /** Recent text output, capped to maxChars (replaces capturePaneText). */
  getRecentText(maxChars = 4000): string {
    const full = this.textChunks.join('');
    return full.length > maxChars ? full.slice(-maxChars) : full;
  }

  /** Count of non-terminal (pending/in_progress) tool calls. */
  get activeToolCalls(): number {
    let count = 0;
    for (const tc of this.toolCalls.values()) {
      if (tc.status !== 'completed' && tc.status !== 'failed') count++;
    }
    return count;
  }

  private appendLog(line: string): void {
    if (!this.logFile) return;
    try { appendFileSync(this.logFile, line + '\n'); } catch { /* best effort */ }
  }
}
