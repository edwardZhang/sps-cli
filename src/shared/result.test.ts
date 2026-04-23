import { describe, expect, it } from 'vitest';
import { andThen, err, isErr, isOk, mapErr, mapOk, ok, type Result, unwrap } from './result.js';

describe('Result', () => {
  it('ok 构造 Ok 分支', () => {
    const r = ok(42);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(42);
  });

  it('err 构造 Err 分支', () => {
    const r = err({ kind: 'not-found', code: 'X', message: 'nope' } as const);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('X');
  });

  it('isOk / isErr 守卫', () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isErr(ok(1))).toBe(false);
    expect(isErr(err('bad'))).toBe(true);
  });

  it('mapOk 只对 Ok 生效', () => {
    expect(mapOk(ok(1), (n) => n + 1)).toEqual({ ok: true, value: 2 });
    const e: Result<number, string> = err('bad');
    expect(mapOk(e, (n) => n + 1)).toEqual({ ok: false, error: 'bad' });
  });

  it('mapErr 只对 Err 生效', () => {
    expect(mapErr(ok(1), () => 'new')).toEqual({ ok: true, value: 1 });
    expect(mapErr(err('x'), (e) => `${e}!`)).toEqual({ ok: false, error: 'x!' });
  });

  it('andThen 链式，Ok 传递，Err 短路', async () => {
    const step = (n: number): Promise<Result<string, string>> =>
      Promise.resolve(n > 0 ? ok(`got ${n}`) : err('non-positive'));
    expect(await andThen<number, string, string>(ok(5), step)).toEqual({ ok: true, value: 'got 5' });
    expect(await andThen<number, string, string>(ok(-1), step)).toEqual({
      ok: false,
      error: 'non-positive',
    });
    expect(await andThen<number, string, string>(err('early'), step)).toEqual({
      ok: false,
      error: 'early',
    });
  });

  it('unwrap Ok 返值，Err 抛', () => {
    expect(unwrap(ok('x'))).toBe('x');
    expect(() => unwrap(err('bad'), 'ctx')).toThrow(/ctx: unwrap on Err/);
  });
});
