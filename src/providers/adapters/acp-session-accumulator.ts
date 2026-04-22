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

/**
 * Structured event emitted from accumulator as ACP session updates arrive.
 * Consumed by daemon subscribeRun to stream to remote clients (Console chat).
 */
export type AccumulatorEvent =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; title: string; kind: string; status: string }
  | { type: 'tool_update'; id: string; status: string }
  | { type: 'usage'; used: number; size: number }
  | { type: 'complete'; stopReason: string };

export type AccumulatorListener = (event: AccumulatorEvent) => void;

export class SessionUpdateAccumulator {
  private textChunks: string[] = [];
  private toolCalls = new Map<string, { title: string; kind: string; status: string }>();
  private logFile: string | null = null;
  private listeners = new Set<AccumulatorListener>();

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

  addListener(fn: AccumulatorListener): void {
    this.listeners.add(fn);
  }

  /** Mark the run as complete and emit a complete event. Called by adapter after run settles. */
  markComplete(stopReason: string): void {
    this.stopReason = stopReason;
    this.emit({ type: 'complete', stopReason });
  }

  removeListener(fn: AccumulatorListener): void {
    this.listeners.delete(fn);
  }

  private emit(event: AccumulatorEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* listener error should not break accumulator */
      }
    }
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
          this.emit({ type: 'text', text: content.text });
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
        this.emit({ type: 'tool_use', id, title, kind, status });
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
        this.emit({ type: 'tool_update', id, status });
        break;
      }
      case 'usage_update': {
        const used = update.used as number | undefined;
        const size = update.size as number | undefined;
        if (used != null && size != null) {
          this.appendLog(`${ts} [usage] ${used}/${size} tokens`);
          this.emit({ type: 'usage', used, size });
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
