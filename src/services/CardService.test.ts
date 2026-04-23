import { describe, expect, it, vi } from 'vitest';
import { FakeClock } from '../infra/clock.js';
import type { TaskBackend } from '../interfaces/TaskBackend.js';
import { type DomainEvent, InMemoryEventBus } from '../shared/domainEvents.js';
import type { Card, CardState } from '../shared/types.js';
import { CardService } from './CardService.js';
import type { TaskBackendFactory } from './ports.js';

// ─── In-memory TaskBackend（够测单元） ──────────────────────────────

class MemoryTaskBackend implements TaskBackend {
  private seq = 0;
  private cards = new Map<string, Card>();

  async bootstrap() {}
  async listAll() {
    return [...this.cards.values()].sort((a, b) => Number(a.seq) - Number(b.seq));
  }
  async listByState(state: CardState) {
    return [...this.cards.values()].filter((c) => c.state === state);
  }
  async getBySeq(seq: string) {
    return this.cards.get(seq) ?? null;
  }
  async move(seq: string, state: CardState) {
    const c = this.cards.get(seq);
    if (!c) throw new Error('not found');
    c.state = state;
  }
  async addLabel(seq: string, label: string) {
    const c = this.cards.get(seq);
    if (!c) throw new Error('nf');
    c.labels = [...new Set([...c.labels, label])];
  }
  async removeLabel(seq: string, label: string) {
    const c = this.cards.get(seq);
    if (!c) throw new Error('nf');
    c.labels = c.labels.filter((l) => l !== label);
  }
  async claim(seq: string, worker: string) {
    const c = this.cards.get(seq);
    if (!c) throw new Error('nf');
    c.meta.claimed_by = worker;
  }
  async releaseClaim(seq: string) {
    const c = this.cards.get(seq);
    if (!c) return;
    c.meta.claimed_by = null;
  }
  async comment() {}
  async create(title: string, desc: string, state: CardState) {
    const seq = String(++this.seq);
    const card: Card = {
      id: `md-${seq}`,
      seq,
      title,
      desc,
      state,
      labels: [],
      skills: [],
      meta: {},
    };
    this.cards.set(seq, card);
    return card;
  }
  async setSkills(seq: string, skills: string[]) {
    const c = this.cards.get(seq);
    if (!c) throw new Error('nf');
    c.skills = [...skills];
  }
  async setTitle(seq: string, title: string) {
    const c = this.cards.get(seq);
    if (!c) throw new Error('nf');
    c.title = title;
  }
  async setDescription(seq: string, desc: string) {
    const c = this.cards.get(seq);
    if (!c) throw new Error('nf');
    c.desc = desc;
  }
  async setLabels(seq: string, labels: string[]) {
    const c = this.cards.get(seq);
    if (!c) throw new Error('nf');
    c.labels = [...labels];
  }
  async delete(seq: string) {
    if (!this.cards.has(seq)) throw new Error('nf');
    this.cards.delete(seq);
  }
  async checklistCreate() {}
  async checklistList() {
    return [];
  }
  async checklistCheck() {}
  async checklistUncheck() {}
  async metaRead(seq: string) {
    return (this.cards.get(seq)?.meta ?? {}) as Record<string, unknown>;
  }
  async metaWrite(seq: string, data: Record<string, unknown>) {
    const c = this.cards.get(seq);
    if (!c) throw new Error('nf');
    c.meta = { ...data };
  }
  async incrementRetryCount(seq: string) {
    const c = this.cards.get(seq);
    if (!c) throw new Error('nf');
    c.retryCount = (c.retryCount ?? 0) + 1;
    return c.retryCount;
  }
  async resetRetryCount(seq: string) {
    const c = this.cards.get(seq);
    if (!c) return;
    c.retryCount = 0;
  }
}

class ThrowingFactory implements TaskBackendFactory {
  async for(_project: string): Promise<TaskBackend> {
    throw new Error('project not found');
  }
}

function newService(): {
  svc: CardService;
  backend: MemoryTaskBackend;
  events: DomainEvent[];
} {
  const backend = new MemoryTaskBackend();
  const factory: TaskBackendFactory = {
    async for() {
      return backend;
    },
  };
  const bus = new InMemoryEventBus();
  const events: DomainEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const svc = new CardService({
    backendFactory: factory,
    events: bus,
    clock: new FakeClock(12345),
  });
  return { svc, backend, events };
}

describe('CardService.list', () => {
  it('无卡返空', async () => {
    const { svc } = newService();
    const r = await svc.list('p');
    expect(r).toEqual({ ok: true, value: [] });
  });

  it('列出并按 seq 倒序', async () => {
    const { svc, backend } = newService();
    await backend.create('a', '', 'Planning');
    await backend.create('b', '', 'Planning');
    const r = await svc.list('p');
    if (r.ok) expect(r.value.map((c) => c.seq)).toEqual([2, 1]);
  });

  it('state 过滤', async () => {
    const { svc, backend } = newService();
    const a = await backend.create('a', '', 'Planning');
    await backend.create('b', '', 'Todo');
    await backend.move(a.seq, 'Done');
    const r = await svc.list('p', { state: 'Done' });
    if (r.ok) {
      expect(r.value.map((c) => c.seq)).toEqual([1]);
    }
  });

  it('非法 project 返 validation', async () => {
    const { svc } = newService();
    const r = await svc.list('../etc');
    if (!r.ok) expect(r.error.kind).toBe('validation');
  });

  it('factory 抛错 → not-found', async () => {
    const svc = new CardService({
      backendFactory: new ThrowingFactory(),
      events: new InMemoryEventBus(),
      clock: new FakeClock(),
    });
    const r = await svc.list('x');
    if (!r.ok) expect(r.error.kind).toBe('not-found');
  });
});

describe('CardService.get', () => {
  it('seq 不存在返 not-found', async () => {
    const { svc } = newService();
    const r = await svc.get('p', 99);
    if (!r.ok) expect(r.error.code).toBe('CARD_NOT_FOUND');
  });

  it('seq 非法 (0/负/非整数) 返 validation', async () => {
    const { svc } = newService();
    const r1 = await svc.get('p', 0);
    const r2 = await svc.get('p', -1);
    const r3 = await svc.get('p', 1.5);
    for (const r of [r1, r2, r3]) {
      if (!r.ok) expect(r.error.kind).toBe('validation');
    }
  });

  it('存在返 detail', async () => {
    const { svc, backend } = newService();
    await backend.create('c1', 'body', 'Planning');
    const r = await svc.get('p', 1);
    if (r.ok) {
      expect(r.value.title).toBe('c1');
      expect(r.value.body).toBe('body');
      expect(r.value.checklist.total).toBe(0);
    }
  });
});

describe('CardService.create', () => {
  it('成功返 summary + emit card.created', async () => {
    const { svc, events } = newService();
    const r = await svc.create('p', { title: 'hello' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.title).toBe('hello');
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('card.created');
  });

  it('title 空返 validation', async () => {
    const { svc } = newService();
    const r = await svc.create('p', { title: '   ' });
    if (!r.ok) expect(r.error.code).toBe('INVALID_TITLE');
  });

  it('initialState 非法返 validation', async () => {
    const { svc } = newService();
    const r = await svc.create('p', { title: 'x', initialState: 'Weird' });
    if (!r.ok) expect(r.error.code).toBe('INVALID_STATE');
  });

  it('带 skills 自动去重去空', async () => {
    const { svc, backend } = newService();
    await svc.create('p', { title: 'x', skills: ['ts', 'ts', '', ' frontend '] });
    const card = await backend.getBySeq('1');
    expect(card?.skills).toEqual(['ts', 'frontend']);
  });
});

describe('CardService.update', () => {
  it('无字段返 validation', async () => {
    const { svc } = newService();
    const r = await svc.update('p', 1, {});
    if (!r.ok) expect(r.error.code).toBe('PATCH_EMPTY');
  });

  it('seq 不存在返 not-found', async () => {
    const { svc } = newService();
    const r = await svc.update('p', 99, { title: 'x' });
    if (!r.ok) expect(r.error.code).toBe('CARD_NOT_FOUND');
  });

  it('title 空返 validation', async () => {
    const { svc, backend } = newService();
    await backend.create('x', '', 'Planning');
    const r = await svc.update('p', 1, { title: '  ' });
    if (!r.ok) expect(r.error.code).toBe('INVALID_TITLE');
  });

  it('更新 title 持久化 + emit card.updated', async () => {
    const { svc, backend, events } = newService();
    await backend.create('old', '', 'Planning');
    const r = await svc.update('p', 1, { title: 'new' });
    expect(r.ok).toBe(true);
    const card = await backend.getBySeq('1');
    expect(card?.title).toBe('new');
    expect(events.find((e) => e.type === 'card.updated')).toBeDefined();
  });

  it('state 变化 emit card.updated + card.moved', async () => {
    const { svc, backend, events } = newService();
    await backend.create('x', '', 'Planning');
    await svc.update('p', 1, { state: 'Todo' });
    const types = events.map((e) => e.type);
    expect(types).toContain('card.updated');
    expect(types).toContain('card.moved');
  });

  it('state 不变不 emit moved', async () => {
    const { svc, backend, events } = newService();
    await backend.create('x', '', 'Planning');
    await svc.update('p', 1, { state: 'Planning' });
    expect(events.filter((e) => e.type === 'card.moved')).toHaveLength(0);
  });

  it('skills / labels 更新', async () => {
    const { svc, backend } = newService();
    await backend.create('x', '', 'Planning');
    await svc.update('p', 1, { skills: ['ts'], labels: ['L1'] });
    const card = await backend.getBySeq('1');
    expect(card?.skills).toEqual(['ts']);
    expect(card?.labels).toEqual(['L1']);
  });

  it('state 非法返 validation', async () => {
    const { svc, backend } = newService();
    await backend.create('x', '', 'Planning');
    const r = await svc.update('p', 1, { state: 'Gibberish' });
    if (!r.ok) expect(r.error.code).toBe('INVALID_STATE');
  });
});

describe('CardService.move', () => {
  it('等价于 update({state})', async () => {
    const { svc, backend } = newService();
    await backend.create('x', '', 'Planning');
    const r = await svc.move('p', 1, 'Backlog');
    expect(r.ok).toBe(true);
    expect((await backend.getBySeq('1'))?.state).toBe('Backlog');
  });
});

describe('CardService.delete', () => {
  it('seq 不存在返 not-found', async () => {
    const { svc } = newService();
    const r = await svc.delete('p', 99);
    if (!r.ok) expect(r.error.code).toBe('CARD_NOT_FOUND');
  });

  it('Inprogress 拒绝 (precondition)', async () => {
    const { svc, backend } = newService();
    await backend.create('x', '', 'Inprogress');
    const r = await svc.delete('p', 1);
    if (!r.ok) {
      expect(r.error.kind).toBe('precondition');
      expect(r.error.code).toBe('CARD_IN_PROGRESS');
    }
  });

  it('成功删除 + emit card.deleted', async () => {
    const { svc, backend, events } = newService();
    await backend.create('x', '', 'Planning');
    const r = await svc.delete('p', 1);
    expect(r.ok).toBe(true);
    expect(await backend.getBySeq('1')).toBeNull();
    expect(events.find((e) => e.type === 'card.deleted')).toBeDefined();
  });
});

describe('CardService.reset', () => {
  it('seq 不存在返 not-found', async () => {
    const { svc } = newService();
    const r = await svc.reset('p', 99);
    if (!r.ok) expect(r.error.code).toBe('CARD_NOT_FOUND');
  });

  it('从 Done 重置回 Planning + 清系统 labels', async () => {
    const { svc, backend, events } = newService();
    const card = await backend.create('x', '', 'Done');
    card.labels = ['AI-PIPELINE', 'STARTED-develop', 'my-custom'];
    const r = await svc.reset('p', Number(card.seq));
    expect(r.ok).toBe(true);
    const fresh = await backend.getBySeq('1');
    expect(fresh?.state).toBe('Planning');
    expect(fresh?.labels).toEqual(['my-custom']);
    expect(events.map((e) => e.type)).toContain('card.moved');
  });

  it('已是 Planning 不重复 emit moved', async () => {
    const { svc, backend, events } = newService();
    await backend.create('x', '', 'Planning');
    await svc.reset('p', 1);
    expect(events.filter((e) => e.type === 'card.moved')).toHaveLength(0);
  });
});
