/**
 * @module        acp-session-accumulator.test
 * @description   ACP 会话更新累加器的单元测试
 *
 * @author        eddy
 * @organization  wykj
 * @ownership     wykj/eddy
 *
 * @created       2026-03-31
 * @updated       2026-04-03
 *
 * @role          test-setup
 * @layer         provider
 * @boundedContext acp
 */
import { describe, expect, it } from 'vitest';
import { SessionUpdateAccumulator } from './acp-session-accumulator.js';

describe('SessionUpdateAccumulator', () => {
  it('accumulates agent_message_chunk text', () => {
    const acc = new SessionUpdateAccumulator();
    acc.handleUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } });
    acc.handleUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'World' } });
    expect(acc.getRecentText()).toBe('Hello World');
  });

  it('tracks tool_call lifecycle', () => {
    const acc = new SessionUpdateAccumulator();
    acc.handleUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'tc-1',
      title: 'Read file',
      kind: 'read',
      status: 'pending',
    });
    expect(acc.activeToolCalls).toBe(1);

    acc.handleUpdate({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'tc-1',
      status: 'completed',
    });
    expect(acc.activeToolCalls).toBe(0);
  });

  it('tracks multiple tool calls', () => {
    const acc = new SessionUpdateAccumulator();
    acc.handleUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'A', kind: 'read', status: 'pending' });
    acc.handleUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-2', title: 'B', kind: 'edit', status: 'pending' });
    expect(acc.activeToolCalls).toBe(2);

    acc.handleUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed' });
    expect(acc.activeToolCalls).toBe(1);

    acc.handleUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'tc-2', status: 'failed' });
    expect(acc.activeToolCalls).toBe(0);
  });

  it('truncates getRecentText to maxChars', () => {
    const acc = new SessionUpdateAccumulator();
    acc.handleUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'A'.repeat(5000) } });
    expect(acc.getRecentText(100).length).toBe(100);
  });

  it('updates lastUpdateAt on every event', () => {
    const acc = new SessionUpdateAccumulator();
    expect(acc.lastUpdateAt).toBeNull();

    acc.handleUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
    expect(acc.lastUpdateAt).toBeDefined();
    expect(typeof acc.lastUpdateAt).toBe('string');
  });

  it('reset clears all state', () => {
    const acc = new SessionUpdateAccumulator();
    acc.handleUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } });
    acc.handleUpdate({ sessionUpdate: 'tool_call', toolCallId: 'tc-1', title: 'X', kind: 'read', status: 'pending' });
    acc.stopReason = 'end_turn';
    acc.hasPendingPermission = true;

    acc.reset();

    expect(acc.getRecentText()).toBe('');
    expect(acc.activeToolCalls).toBe(0);
    expect(acc.stopReason).toBeNull();
    expect(acc.hasPendingPermission).toBe(false);
    expect(acc.lastUpdateAt).toBeNull();
  });

  it('ignores non-text content in agent_message_chunk', () => {
    const acc = new SessionUpdateAccumulator();
    acc.handleUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'image', source: {} } });
    expect(acc.getRecentText()).toBe('');
  });

  it('handles unknown sessionUpdate types gracefully', () => {
    const acc = new SessionUpdateAccumulator();
    acc.handleUpdate({ sessionUpdate: 'usage_update', used: 100, size: 200000 } as any);
    expect(acc.lastUpdateAt).toBeDefined(); // still updates timestamp
  });
});
