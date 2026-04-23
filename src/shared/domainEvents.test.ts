import { describe, expect, it } from 'vitest';
import {
  type DomainEvent,
  InMemoryEventBus,
  NoopEventBus,
} from './domainEvents.js';

function cardDeleted(project = 'p', seq = 1): DomainEvent {
  return { type: 'card.deleted', project, seq, ts: 0 };
}

describe('NoopEventBus', () => {
  it('emit 不抛', () => {
    const bus = new NoopEventBus();
    expect(() => bus.emit(cardDeleted())).not.toThrow();
  });

  it('subscribe 返回 noop cancel', () => {
    const bus = new NoopEventBus();
    const cancel = bus.subscribe(() => {});
    expect(() => cancel()).not.toThrow();
  });
});

describe('InMemoryEventBus', () => {
  it('emit 广播给 subscribe 的 handler', () => {
    const bus = new InMemoryEventBus();
    const received: DomainEvent[] = [];
    bus.subscribe((e) => received.push(e));
    bus.emit(cardDeleted('alpha', 42));
    expect(received).toEqual([{ type: 'card.deleted', project: 'alpha', seq: 42, ts: 0 }]);
  });

  it('多 handler 都收到', () => {
    const bus = new InMemoryEventBus();
    let a = 0;
    let b = 0;
    bus.subscribe(() => a++);
    bus.subscribe(() => b++);
    bus.emit(cardDeleted());
    bus.emit(cardDeleted());
    expect(a).toBe(2);
    expect(b).toBe(2);
  });

  it('cancel 取消订阅后不再收', () => {
    const bus = new InMemoryEventBus();
    let count = 0;
    const cancel = bus.subscribe(() => count++);
    bus.emit(cardDeleted());
    cancel();
    bus.emit(cardDeleted());
    expect(count).toBe(1);
  });

  it('handler 抛错不影响其它 handler 和 publisher', () => {
    const bus = new InMemoryEventBus();
    const saved = console.warn;
    console.warn = (): void => {}; // 静默
    try {
      let okHit = 0;
      bus.subscribe(() => {
        throw new Error('bad');
      });
      bus.subscribe(() => okHit++);
      expect(() => bus.emit(cardDeleted())).not.toThrow();
      expect(okHit).toBe(1);
    } finally {
      console.warn = saved;
    }
  });
});
