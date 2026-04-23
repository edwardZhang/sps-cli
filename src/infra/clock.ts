/**
 * @module        infra/clock
 * @description   Clock port —— 时间来源抽象
 *
 * @layer         infra
 *
 * Service 层不直接 new Date() / Date.now()；注入 Clock 让时间可控，便于测试。
 */

export interface Clock {
  /** ms 精度的时间戳 */
  now(): number;
  /** Date 对象 */
  nowDate(): Date;
  /** ISO 8601 字符串 */
  nowIso(): string;
}

/** 默认系统时钟。 */
export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
  nowDate(): Date {
    return new Date();
  }
  nowIso(): string {
    return new Date().toISOString();
  }
}

/** 测试用 —— 可设置 / 步进时间。 */
export class FakeClock implements Clock {
  private t: number;

  constructor(initial: number | string | Date = 0) {
    this.t = typeof initial === 'number' ? initial : new Date(initial).getTime();
  }

  now(): number {
    return this.t;
  }
  nowDate(): Date {
    return new Date(this.t);
  }
  nowIso(): string {
    return new Date(this.t).toISOString();
  }

  /** 跳到指定时刻 */
  setTime(t: number | string | Date): void {
    this.t = typeof t === 'number' ? t : new Date(t).getTime();
  }

  /** 前进 ms */
  advance(ms: number): void {
    this.t += ms;
  }
}
