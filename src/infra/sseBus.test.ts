import { describe, expect, it } from 'vitest';
import type { DomainEvent } from '../shared/domainEvents.js';
import { type SseBusEvent, SseEventBus } from './sseBus.js';

function cardDeleted(seq: number): DomainEvent {
  return { type: 'card.deleted', project: 'p', seq, ts: 0 };
}

describe('SseEventBus', () => {
  it('emit DomainEvent → id 自增，history 追加', () => {
    const bus = new SseEventBus();
    bus.emit(cardDeleted(1));
    bus.emit(cardDeleted(2));
    expect(bus.currentId()).toBe(2);
    expect(bus.since(0)).toHaveLength(2);
    expect(bus.since(0)[0]?.id).toBe(1);
  });

  it('subscribe 收到 DomainEvent', () => {
    const bus = new SseEventBus();
    const got: DomainEvent[] = [];
    bus.subscribe((e) => got.push(e));
    bus.emit(cardDeleted(7));
    expect(got).toEqual([cardDeleted(7)]);
  });

  it('subscribeRaw 收到 SseBusEvent（带 id）', () => {
    const bus = new SseEventBus();
    const got: SseBusEvent[] = [];
    bus.subscribeRaw((r) => got.push(r));
    bus.emit(cardDeleted(1));
    expect(got).toHaveLength(1);
    expect(got[0]?.id).toBe(1);
    expect(got[0]?.event).toBe('card.deleted');
    expect(got[0]?.data).toEqual(cardDeleted(1));
  });

  it('since 只返 lastEventId 之后的', () => {
    const bus = new SseEventBus();
    bus.emit(cardDeleted(1));
    bus.emit(cardDeleted(2));
    bus.emit(cardDeleted(3));
    expect(bus.since(1).map((r) => r.data.seq)).toEqual([2, 3]);
  });

  it('cancel 后不再收', () => {
    const bus = new SseEventBus();
    let count = 0;
    const cancel = bus.subscribe(() => count++);
    bus.emit(cardDeleted(1));
    cancel();
    bus.emit(cardDeleted(2));
    expect(count).toBe(1);
  });

  it('maxHistory 溢出丢最早', () => {
    const bus = new SseEventBus({ maxHistory: 3 });
    for (let i = 1; i <= 5; i++) bus.emit(cardDeleted(i));
    const hist = bus.since(0);
    expect(hist.map((r) => r.data.seq)).toEqual([3, 4, 5]);
  });

  it('clearHistory 重置', () => {
    const bus = new SseEventBus();
    bus.emit(cardDeleted(1));
    bus.clearHistory();
    expect(bus.currentId()).toBe(0);
    expect(bus.since(0)).toHaveLength(0);
  });

  it('handler 抛错不影响其它 handler', () => {
    const bus = new SseEventBus();
    const saved = console.warn;
    console.warn = (): void => {};
    try {
      let okHit = 0;
      bus.subscribe(() => {
        throw new Error('bad');
      });
      bus.subscribe(() => okHit++);
      expect(() => bus.emit(cardDeleted(1))).not.toThrow();
      expect(okHit).toBe(1);
    } finally {
      console.warn = saved;
    }
  });
});
