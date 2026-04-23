import { describe, expect, it } from 'vitest';
import { FakeClock, SystemClock } from './clock.js';

describe('SystemClock', () => {
  it('now / nowDate / nowIso 都接近 Date.now()', () => {
    const c = new SystemClock();
    const n = c.now();
    expect(Math.abs(n - Date.now())).toBeLessThan(100);
    expect(c.nowDate()).toBeInstanceOf(Date);
    expect(c.nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('FakeClock', () => {
  it('初始 0', () => {
    const c = new FakeClock();
    expect(c.now()).toBe(0);
  });

  it('数字构造', () => {
    expect(new FakeClock(1000).now()).toBe(1000);
  });

  it('ISO 字符串构造', () => {
    const iso = '2026-04-23T12:00:00.000Z';
    const c = new FakeClock(iso);
    expect(c.nowIso()).toBe(iso);
  });

  it('setTime 跳到指定时刻', () => {
    const c = new FakeClock(0);
    c.setTime(500);
    expect(c.now()).toBe(500);
    c.setTime(new Date('2026-01-01T00:00:00.000Z'));
    expect(c.nowIso()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('advance 前进', () => {
    const c = new FakeClock(1000);
    c.advance(500);
    expect(c.now()).toBe(1500);
  });

  it('nowDate 返回独立 Date 实例（不受后续 advance 影响）', () => {
    const c = new FakeClock(1000);
    const d = c.nowDate();
    c.advance(500);
    expect(d.getTime()).toBe(1000);
  });
});
