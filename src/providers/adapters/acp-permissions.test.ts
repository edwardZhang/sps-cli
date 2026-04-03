/**
 * @module        acp-permissions.test
 * @description   ACP 权限解析器的单元测试
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
import { inferToolKind, type PermissionMode, resolvePermission } from './acp-permissions.js';

function makeParams(kind?: string, title?: string, options?: Array<{ optionId: string; kind: string; name?: string }>) {
  return {
    sessionId: 'test-session',
    toolCall: {
      toolCallId: 'tc-1',
      title: title ?? 'Test tool',
      kind: kind ?? undefined,
      status: 'pending' as const,
    },
    options: options ?? [
      { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
    ],
  };
}

describe('resolvePermission', () => {
  it('approve-all: selects allow_once', () => {
    const result = resolvePermission(makeParams('edit'), 'approve-all');
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
  });

  it('approve-all: selects first option if no allow_once', () => {
    const params = makeParams('edit', 'Test', [
      { optionId: 'custom', kind: 'reject_once', name: 'Custom' },
    ]);
    const result = resolvePermission(params, 'approve-all');
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'custom' });
  });

  it('deny-all: selects reject_once', () => {
    const result = resolvePermission(makeParams('edit'), 'deny-all');
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'reject' });
  });

  it('deny-all: cancels if no reject option', () => {
    const params = makeParams('edit', 'Test', [
      { optionId: 'allow', kind: 'allow_once', name: 'Allow' },
    ]);
    const result = resolvePermission(params, 'deny-all');
    expect(result.outcome).toEqual({ outcome: 'cancelled' });
  });

  it('approve-reads: auto-approves read kind', () => {
    const result = resolvePermission(makeParams('read'), 'approve-reads');
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
  });

  it('approve-reads: auto-approves search kind', () => {
    const result = resolvePermission(makeParams('search'), 'approve-reads');
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
  });

  it('approve-reads: auto-approves non-read kind (SPS unattended)', () => {
    const result = resolvePermission(makeParams('edit'), 'approve-reads');
    expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'allow' });
  });

  it('cancels when options array is empty', () => {
    const params = makeParams('edit', 'Test', []);
    const result = resolvePermission(params, 'approve-all');
    expect(result.outcome).toEqual({ outcome: 'cancelled' });
  });
});

describe('inferToolKind', () => {
  it('returns toolCall.kind when set', () => {
    expect(inferToolKind({ toolCall: { kind: 'edit' } } as any)).toBe('edit');
  });

  it('infers read from title', () => {
    expect(inferToolKind({ toolCall: { title: 'Read src/main.ts' } } as any)).toBe('read');
  });

  it('infers search from grep', () => {
    expect(inferToolKind({ toolCall: { title: 'grep -i "pattern"' } } as any)).toBe('search');
  });

  it('infers edit from write', () => {
    expect(inferToolKind({ toolCall: { title: 'Write result.txt' } } as any)).toBe('edit');
  });

  it('infers execute from bash/run', () => {
    expect(inferToolKind({ toolCall: { title: 'Run npm test' } } as any)).toBe('execute');
  });

  it('infers delete from remove', () => {
    expect(inferToolKind({ toolCall: { title: 'Remove old files' } } as any)).toBe('delete');
  });

  it('infers fetch from http', () => {
    expect(inferToolKind({ toolCall: { title: 'fetch https://api.com' } } as any)).toBe('fetch');
  });

  it('returns other for unknown title', () => {
    expect(inferToolKind({ toolCall: { title: 'Do something' } } as any)).toBe('other');
  });

  it('returns undefined when no kind and no title', () => {
    expect(inferToolKind({ toolCall: {} } as any)).toBeUndefined();
  });
});
