/**
 * @module        shared/domainEvents
 * @description   领域事件类型 + DomainEventBus port（抽象）
 *
 * @layer         shared
 *
 * Service 层发布事件，Delivery 层订阅并推给客户端：
 *   - Console 侧订阅推到 SSE /stream/projects/*
 *   - CLI 侧可注入 NoOp 实现（或 journal）
 *
 * 事件类型是 **领域事件**（过去时，已经发生的事实），不是 UI 事件也不是命令。
 */
import type { Card } from './types.js';

// ─── 事件定义 ──────────────────────────────────────────────────────

export interface CardCreatedEvent {
  readonly type: 'card.created';
  readonly project: string;
  readonly seq: number;
  readonly card: Card;
  readonly ts: number;
}

export interface CardUpdatedEvent {
  readonly type: 'card.updated';
  readonly project: string;
  readonly seq: number;
  readonly patch: Readonly<Partial<Card>>;
  readonly ts: number;
}

export interface CardMovedEvent {
  readonly type: 'card.moved';
  readonly project: string;
  readonly seq: number;
  readonly from: string;
  readonly to: string;
  readonly ts: number;
}

export interface CardDeletedEvent {
  readonly type: 'card.deleted';
  readonly project: string;
  readonly seq: number;
  readonly ts: number;
}

export interface WorkerDispatchedEvent {
  readonly type: 'worker.dispatched';
  readonly project: string;
  readonly slot: string;
  readonly seq: number;
  readonly stage: string;
  readonly ts: number;
}

export interface WorkerUpdatedEvent {
  readonly type: 'worker.updated';
  readonly project: string;
  readonly slot: string;
  readonly ts: number;
}

export interface WorkerDeletedEvent {
  readonly type: 'worker.deleted';
  readonly project: string;
  readonly slot: string;
  readonly ts: number;
}

export interface PipelineStartedEvent {
  readonly type: 'pipeline.started';
  readonly project: string;
  readonly pid: number;
  readonly ts: number;
}

export interface PipelineStoppedEvent {
  readonly type: 'pipeline.stopped';
  readonly project: string;
  readonly ts: number;
}

export interface SkillLinkedEvent {
  readonly type: 'skill.linked';
  readonly project: string;
  readonly skill: string;
  readonly ts: number;
}

export interface SkillUnlinkedEvent {
  readonly type: 'skill.unlinked';
  readonly project: string;
  readonly skill: string;
  readonly ts: number;
}

/** Union of all领域 events. */
export type DomainEvent =
  | CardCreatedEvent
  | CardUpdatedEvent
  | CardMovedEvent
  | CardDeletedEvent
  | WorkerDispatchedEvent
  | WorkerUpdatedEvent
  | WorkerDeletedEvent
  | PipelineStartedEvent
  | PipelineStoppedEvent
  | SkillLinkedEvent
  | SkillUnlinkedEvent;

export type DomainEventType = DomainEvent['type'];

// ─── EventBus port ─────────────────────────────────────────────────

/**
 * DomainEventBus —— 事件总线抽象。
 * Service 层只依赖这个接口，不知道底层是 SSE / noop / journal。
 */
export interface DomainEventBus {
  /** 发布一个事件（同步返回） */
  emit(event: DomainEvent): void;

  /**
   * 订阅所有事件。返回取消订阅函数。
   * 订阅者里抛出的异常不会影响 publisher。
   */
  subscribe(handler: (event: DomainEvent) => void): () => void;
}

// ─── NoopEventBus ─────────────────────────────────────────────────

/**
 * 什么都不做的实现 —— 用于 CLI / 单元测试。
 * 保证 Service 层即使没接 real bus 也能跑。
 */
export class NoopEventBus implements DomainEventBus {
  emit(_event: DomainEvent): void {
    /* swallow */
  }
  subscribe(_handler: (event: DomainEvent) => void): () => void {
    return () => {
      /* no-op */
    };
  }
}

// ─── InMemoryEventBus ─────────────────────────────────────────────

/**
 * 进程内同步广播 —— 用于测试和 CLI 的 journal 用途。
 * 订阅者顺序执行，handler 内抛错被吞只记 console.warn（不阻塞 publisher）。
 */
export class InMemoryEventBus implements DomainEventBus {
  private handlers: Set<(event: DomainEvent) => void> = new Set();

  emit(event: DomainEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        console.warn('[DomainEventBus] handler threw:', err);
      }
    }
  }

  subscribe(handler: (event: DomainEvent) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}
