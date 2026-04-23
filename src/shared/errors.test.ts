import { describe, expect, it } from 'vitest';
import {
  type DomainError,
  domainError,
  toExitCode,
  toHttpStatus,
  toProblemJson,
} from './errors.js';

describe('DomainError', () => {
  it('domainError factory 最小字段', () => {
    const e = domainError('not-found', 'CARD_NOT_FOUND', '卡片不存在');
    expect(e.kind).toBe('not-found');
    expect(e.code).toBe('CARD_NOT_FOUND');
    expect(e.message).toBe('卡片不存在');
    expect(e.details).toBeUndefined();
    expect(e.cause).toBeUndefined();
  });

  it('domainError factory 带 details + cause', () => {
    const cause = new Error('root');
    const e = domainError('external', 'GIT_FAIL', 'git 推送失败', {
      details: { branch: 'feat/x' },
      cause,
    });
    expect(e.details).toEqual({ branch: 'feat/x' });
    expect(e.cause).toBe(cause);
  });
});

describe('toHttpStatus', () => {
  const cases: Array<[DomainError['kind'], number]> = [
    ['not-found', 404],
    ['conflict', 409],
    ['precondition', 409],
    ['validation', 422],
    ['external', 502],
    ['internal', 500],
  ];
  for (const [kind, status] of cases) {
    it(`${kind} → ${status}`, () => {
      expect(toHttpStatus(domainError(kind, 'X', 'x'))).toBe(status);
    });
  }
});

describe('toExitCode', () => {
  const cases: Array<[DomainError['kind'], number]> = [
    ['validation', 2],
    ['precondition', 2],
    ['external', 3],
    ['not-found', 1],
    ['conflict', 1],
    ['internal', 1],
  ];
  for (const [kind, code] of cases) {
    it(`${kind} → exit ${code}`, () => {
      expect(toExitCode(domainError(kind, 'X', 'x'))).toBe(code);
    });
  }
});

describe('toProblemJson', () => {
  it('返回 RFC 7807 shape', () => {
    const e = domainError('validation', 'BAD_TITLE', '标题为空', {
      details: { field: 'title' },
    });
    const p = toProblemJson(e);
    expect(p).toEqual({
      type: 'validation',
      title: 'Validation Error',
      status: 422,
      detail: '标题为空',
      code: 'BAD_TITLE',
      details: { field: 'title' },
    });
  });

  it('不泄露 cause', () => {
    const e = domainError('internal', 'IO_FAIL', 'disk error', {
      cause: new Error('EIO'),
    });
    const p = toProblemJson(e);
    expect(p).not.toHaveProperty('cause');
  });
});
