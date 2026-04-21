/**
 * @module        console-server/sse/eventBus
 * @description   内部事件总线 —— watchers 推事件，SSE handlers 订阅推给客户端
 *
 * @role          core
 * @layer         console-server
 * @boundedContext console
 */
import { EventEmitter } from 'node:events';

export interface BusEvent {
  id: number;
  event: string;
  data: unknown;
  ts: number;
}

const MAX_HISTORY = 1000;

class ConsoleEventBus extends EventEmitter {
  private lastEventId = 0;
  private history: BusEvent[] = [];

  publish(event: string, data: unknown): number {
    const id = ++this.lastEventId;
    const record: BusEvent = { id, event, data, ts: Date.now() };
    this.history.push(record);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.emit(event, data);
    this.emit('*', record);
    return id;
  }

  since(lastEventId: number): BusEvent[] {
    return this.history.filter((h) => h.id > lastEventId);
  }

  clearHistory(): void {
    this.history = [];
  }
}

export const eventBus = new ConsoleEventBus();
