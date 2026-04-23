/**
 * @module        infra/sseBus
 * @description   DomainEventBus 的 SSE 实现 —— Console 专用
 *
 * @layer         infra
 *
 * 相比 InMemoryEventBus，本实现多了：
 *   - lastEventId 自增（SSE 协议要求）
 *   - 有限历史（Last-Event-ID 断线重连补偿）
 *   - 心跳由上层 route 自己管，本 bus 只管事件分发和历史
 *
 * 相当于把原 console-server/sse/eventBus.ts 重新抽象成 DomainEventBus port 的实现。
 */
import { EventEmitter } from 'node:events';
import type { DomainEvent, DomainEventBus } from '../shared/domainEvents.js';

export interface SseBusEvent {
  /** 单调递增 ID（SSE 需要） */
  readonly id: number;
  /** SSE event 字段值 = DomainEvent.type */
  readonly event: string;
  /** 原始领域事件 */
  readonly data: DomainEvent;
  /** 发布时的 wall-clock ts（ms） */
  readonly ts: number;
}

export interface SseEventBusOptions {
  /** 历史窗口大小 —— 超过丢最早的。默认 1000。 */
  maxHistory?: number;
}

export class SseEventBus implements DomainEventBus {
  private lastEventId = 0;
  private history: SseBusEvent[] = [];
  private readonly maxHistory: number;
  // 内部 EventEmitter 仅分发 record —— 不暴露，避免和 DomainEventBus.emit 签名冲突
  private readonly emitter: EventEmitter;

  constructor(opts: SseEventBusOptions = {}) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(0); // SSE 连接多，不要警告
    this.maxHistory = opts.maxHistory ?? 1000;
  }

  emit(event: DomainEvent): void {
    const id = ++this.lastEventId;
    const record: SseBusEvent = { id, event: event.type, data: event, ts: Date.now() };
    this.history.push(record);
    if (this.history.length > this.maxHistory) this.history.shift();
    this.emitter.emit('*', record);
  }

  subscribe(handler: (event: DomainEvent) => void): () => void {
    const wrapped = (record: SseBusEvent): void => {
      try {
        handler(record.data);
      } catch (err) {
        console.warn('[SseEventBus] handler threw:', err);
      }
    };
    this.emitter.on('*', wrapped);
    return () => {
      this.emitter.off('*', wrapped);
    };
  }

  /**
   * SSE route 订阅的原始接口 —— 给需要 id / event 字段的 route 用。
   * 订阅器内抛异常会冒泡（调用方 try/catch 或接受 EventEmitter 行为）。
   */
  subscribeRaw(handler: (record: SseBusEvent) => void): () => void {
    this.emitter.on('*', handler);
    return () => {
      this.emitter.off('*', handler);
    };
  }

  /** SSE 断线重连用：返回 lastEventId 之后的历史 */
  since(lastEventId: number): SseBusEvent[] {
    return this.history.filter((r) => r.id > lastEventId);
  }

  /** 测试 / close 时清空 */
  clearHistory(): void {
    this.history = [];
    this.lastEventId = 0;
  }

  /** 当前最大 id，测试用 */
  currentId(): number {
    return this.lastEventId;
  }
}
