import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  extractLastAssistantText,
  fileSize,
  isProcessAlive,
  parseClaudeSessionId,
  parseCodexSessionId,
  tailFile,
} from './outputParser.js';

// ─── Helpers ──────────────────────────────────────────────────────

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'sps-parser-test-'));
}

// ─── Tests ────────────────────────────────────────────────────────

describe('tailFile', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('returns empty string for nonexistent file', () => {
    expect(tailFile('/tmp/does-not-exist-12345.txt', 10)).toBe('');
  });

  it('returns last N lines', () => {
    const file = join(tempDir, 'log.txt');
    writeFileSync(file, 'line1\nline2\nline3\nline4\nline5\n');
    const result = tailFile(file, 2);
    expect(result).toBe('line5\n'); // last 2 entries include trailing empty
  });

  it('returns entire file when fewer lines than requested', () => {
    const file = join(tempDir, 'short.txt');
    writeFileSync(file, 'only\n');
    const result = tailFile(file, 100);
    expect(result).toContain('only');
  });
});

describe('fileSize', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('returns 0 for nonexistent file', () => {
    expect(fileSize('/tmp/no-file-12345')).toBe(0);
  });

  it('returns correct size', () => {
    const file = join(tempDir, 'data.bin');
    writeFileSync(file, 'hello world'); // 11 bytes
    expect(fileSize(file)).toBe(11);
  });

  it('returns 0 for empty file', () => {
    const file = join(tempDir, 'empty.txt');
    writeFileSync(file, '');
    expect(fileSize(file)).toBe(0);
  });
});

describe('parseClaudeSessionId', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('returns null for nonexistent file', () => {
    expect(parseClaudeSessionId('/tmp/no-file-12345')).toBeNull();
  });

  it('extracts session_id from stream-json output', () => {
    const file = join(tempDir, 'output.jsonl');
    writeFileSync(file, [
      '{"type":"system","message":"starting"}',
      '{"type":"assistant","message":{"content":"hello"}}',
      '{"type":"result","result":"done","session_id":"sess-abc-123"}',
    ].join('\n'));

    expect(parseClaudeSessionId(file)).toBe('sess-abc-123');
  });

  it('returns null when no session_id present', () => {
    const file = join(tempDir, 'output.jsonl');
    writeFileSync(file, '{"type":"result","result":"done"}\n');
    expect(parseClaudeSessionId(file)).toBeNull();
  });

  it('skips non-JSON lines gracefully', () => {
    const file = join(tempDir, 'mixed.jsonl');
    writeFileSync(file, [
      'not json at all',
      '{"session_id":"found-it"}',
      'another bad line',
    ].join('\n'));

    expect(parseClaudeSessionId(file)).toBe('found-it');
  });

  it('returns first session_id found', () => {
    const file = join(tempDir, 'multi.jsonl');
    writeFileSync(file, [
      '{"session_id":"first"}',
      '{"session_id":"second"}',
    ].join('\n'));

    expect(parseClaudeSessionId(file)).toBe('first');
  });
});

describe('parseCodexSessionId', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('returns null for nonexistent file', () => {
    expect(parseCodexSessionId('/tmp/no-file-12345')).toBeNull();
  });

  it('extracts conversation_id', () => {
    const file = join(tempDir, 'codex.jsonl');
    writeFileSync(file, '{"conversation_id":"conv-xyz-789"}\n');
    expect(parseCodexSessionId(file)).toBe('conv-xyz-789');
  });

  it('extracts session_id', () => {
    const file = join(tempDir, 'codex.jsonl');
    writeFileSync(file, '{"session_id":"sess-xyz"}\n');
    expect(parseCodexSessionId(file)).toBe('sess-xyz');
  });

  it('extracts id from session_start event', () => {
    const file = join(tempDir, 'codex.jsonl');
    writeFileSync(file, '{"type":"session_start","id":"start-id-123"}\n');
    expect(parseCodexSessionId(file)).toBe('start-id-123');
  });

  it('prefers conversation_id over session_id', () => {
    const file = join(tempDir, 'codex.jsonl');
    writeFileSync(file, '{"conversation_id":"conv","session_id":"sess"}\n');
    expect(parseCodexSessionId(file)).toBe('conv');
  });

  it('returns null when no IDs present', () => {
    const file = join(tempDir, 'codex.jsonl');
    writeFileSync(file, '{"type":"message","text":"hello"}\n');
    expect(parseCodexSessionId(file)).toBeNull();
  });
});

describe('isProcessAlive', () => {
  it('returns true for current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('returns false for invalid PID', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
  });

  it('returns false for non-existent PID', () => {
    // Use a very high PID that almost certainly doesn't exist
    expect(isProcessAlive(4_000_000)).toBe(false);
  });
});

describe('extractLastAssistantText', () => {
  let tempDir: string;

  beforeEach(() => { tempDir = makeTempDir(); });
  afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

  it('returns empty string for nonexistent file', () => {
    expect(extractLastAssistantText('/tmp/no-file-12345')).toBe('');
  });

  it('extracts text from assistant message with content array', () => {
    const file = join(tempDir, 'output.jsonl');
    writeFileSync(file, JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'I have completed the task.' },
        ],
      },
    }) + '\n');

    expect(extractLastAssistantText(file)).toBe('I have completed the task.');
  });

  it('extracts text from assistant message with string content', () => {
    const file = join(tempDir, 'output.jsonl');
    writeFileSync(file, JSON.stringify({
      type: 'assistant',
      message: { content: 'Done! All tasks finished.' },
    }) + '\n');

    expect(extractLastAssistantText(file)).toBe('Done! All tasks finished.');
  });

  it('extracts from result type', () => {
    const file = join(tempDir, 'output.jsonl');
    writeFileSync(file, JSON.stringify({
      type: 'result',
      result: 'Task completed successfully 🎉',
    }) + '\n');

    expect(extractLastAssistantText(file)).toBe('Task completed successfully 🎉');
  });

  it('returns last assistant text when multiple messages', () => {
    const file = join(tempDir, 'output.jsonl');
    const lines = [
      JSON.stringify({ type: 'assistant', message: { content: 'Starting...' } }),
      JSON.stringify({ type: 'assistant', message: { content: 'Working...' } }),
      JSON.stringify({ type: 'assistant', message: { content: '全部完成' } }),
    ];
    writeFileSync(file, lines.join('\n') + '\n');

    expect(extractLastAssistantText(file)).toBe('全部完成');
  });

  it('accumulates content_block_delta text', () => {
    const file = join(tempDir, 'output.jsonl');
    const lines = [
      JSON.stringify({ type: 'content_block_delta', delta: { text: 'Hello ' } }),
      JSON.stringify({ type: 'content_block_delta', delta: { text: 'world' } }),
    ];
    writeFileSync(file, lines.join('\n') + '\n');

    expect(extractLastAssistantText(file)).toBe('Hello world');
  });

  it('skips non-JSON lines without error', () => {
    const file = join(tempDir, 'mixed.jsonl');
    writeFileSync(file, [
      'garbage line',
      JSON.stringify({ type: 'assistant', message: { content: 'valid' } }),
      'more garbage',
    ].join('\n') + '\n');

    expect(extractLastAssistantText(file)).toBe('valid');
  });

  it('returns empty string for empty file', () => {
    const file = join(tempDir, 'empty.jsonl');
    writeFileSync(file, '');
    expect(extractLastAssistantText(file)).toBe('');
  });
});
