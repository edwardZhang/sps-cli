/**
 * @module        services/CardService
 * @description   卡片 CRUD + 状态流转 service
 *
 * @layer         services
 *
 * 职责：
 *   - list / get（结构化 CardSummary + CardDetail）
 *   - create（通过 TaskBackend.create）
 *   - update（title / description / skills / labels 按需）
 *   - move（state transitions）
 *   - delete（物理删 md 文件）
 *   - reset（清理 frontmatter 运行字段 + 移回初始态）
 *
 * 不负责：
 *   - worker 派发（是 WorkerService 职责）
 *   - checklist 写入（Phase 2 暂不做；Phase 3 追加）
 */
import type { Clock } from '../infra/clock.js';
import type { DomainEventBus } from '../shared/domainEvents.js';
import { type DomainError, domainError } from '../shared/errors.js';
import { err, ok, type Result } from '../shared/result.js';
import type { Card, ChecklistStats } from '../shared/types.js';
import type { TaskBackendFactory } from './ports.js';

// ─── Domain types ─────────────────────────────────────────────────

export interface CardSummary {
  readonly seq: number;
  readonly title: string;
  readonly state: string;
  readonly skills: string[];
  readonly labels: string[];
  readonly branch: string | null;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
}

export interface CardDetail extends CardSummary {
  readonly body: string;
  readonly checklist: ChecklistStats;
  readonly activeWorkerSlot: number | null;
}

export interface CreateCardInput {
  title: string;
  description?: string;
  skills?: string[];
  initialState?: string; // default Planning
}

export interface UpdateCardPatch {
  title?: string;
  description?: string;
  skills?: string[];
  labels?: string[];
  state?: string; // 相当于 move
}

export interface ListCardsFilter {
  state?: string;
}

// 合法 state 白名单（和 Console PATCH 侧保持一致；Phase 3 归并到 shared）
const ALLOWED_STATES = [
  'Planning',
  'Backlog',
  'Todo',
  'Inprogress',
  'Review',
  'QA',
  'Done',
  'Canceled',
];

// ─── Service ──────────────────────────────────────────────────────

export interface CardServiceDeps {
  readonly backendFactory: TaskBackendFactory;
  readonly events: DomainEventBus;
  readonly clock: Clock;
}

export class CardService {
  constructor(private readonly deps: CardServiceDeps) {}

  /** 列出卡片（可选 state 过滤）。按 seq 倒序（新卡在前）。 */
  async list(
    project: string,
    filter: ListCardsFilter = {},
  ): Promise<Result<CardSummary[]>> {
    if (!isValidProject(project)) return err(invalidProject());
    const backend = await this.backendOr404(project);
    if (!backend.ok) return backend;
    const cards = filter.state
      ? await backend.value.listByState(filter.state)
      : await backend.value.listAll();
    const summaries = cards
      .map(toCardSummary)
      .sort((a, b) => b.seq - a.seq);
    return ok(summaries);
  }

  /** 获取单卡详情（含 body + checklist）。 */
  async get(project: string, seq: number): Promise<Result<CardDetail>> {
    if (!isValidProject(project)) return err(invalidProject());
    if (!Number.isInteger(seq) || seq <= 0) return err(invalidSeq());
    const backend = await this.backendOr404(project);
    if (!backend.ok) return backend;
    const card = await backend.value.getBySeq(String(seq));
    if (!card) return err(cardNotFound(seq));
    return ok(toCardDetail(card));
  }

  /** 新建卡片。state 缺省 'Planning'。 */
  async create(
    project: string,
    input: CreateCardInput,
  ): Promise<Result<CardSummary>> {
    if (!isValidProject(project)) return err(invalidProject());
    const title = input.title?.trim();
    if (!title) return err(invalidTitle());
    const state = input.initialState ?? 'Planning';
    if (!ALLOWED_STATES.includes(state)) return err(invalidState(state));

    const backend = await this.backendOr404(project);
    if (!backend.ok) return backend;

    let created: Card;
    try {
      created = await backend.value.create(
        title,
        (input.description ?? '').trim(),
        state,
      );
    } catch (cause) {
      return err(domainError('internal', 'CARD_CREATE_FAIL', '卡片创建失败', { cause }));
    }
    if (input.skills && input.skills.length > 0) {
      try {
        await backend.value.setSkills(created.seq, sanitizeSkills(input.skills));
      } catch {
        /* skills 写失败不阻塞 create */
      }
    }

    const summary = toCardSummary({
      ...created,
      skills: input.skills ?? [],
    });
    this.deps.events.emit({
      type: 'card.created',
      project,
      seq: summary.seq,
      card: created,
      ts: this.deps.clock.now(),
    });
    return ok(summary);
  }

  /**
   * 更新卡片 —— 任意字段子集。
   * 字段相互独立应用，最后 emit 单次 card.updated + 如 state 变则额外 card.moved。
   */
  async update(
    project: string,
    seq: number,
    patch: UpdateCardPatch,
  ): Promise<Result<CardSummary>> {
    if (!isValidProject(project)) return err(invalidProject());
    if (!Number.isInteger(seq) || seq <= 0) return err(invalidSeq());
    if (Object.keys(patch).length === 0) {
      return err(
        domainError('validation', 'PATCH_EMPTY', '没有字段可更新'),
      );
    }
    if (patch.state !== undefined && !ALLOWED_STATES.includes(patch.state)) {
      return err(invalidState(patch.state));
    }
    if (patch.title !== undefined && !patch.title.trim()) {
      return err(invalidTitle());
    }
    if (patch.skills !== undefined && !Array.isArray(patch.skills)) {
      return err(
        domainError('validation', 'SKILLS_NOT_ARRAY', 'skills 必须是数组'),
      );
    }
    if (patch.labels !== undefined && !Array.isArray(patch.labels)) {
      return err(
        domainError('validation', 'LABELS_NOT_ARRAY', 'labels 必须是数组'),
      );
    }

    const backend = await this.backendOr404(project);
    if (!backend.ok) return backend;
    const existing = await backend.value.getBySeq(String(seq));
    if (!existing) return err(cardNotFound(seq));
    // 快照旧值 —— 后续 move 会改 backend 内部对象，existing.state 会被改；
    // 提前取值避免事件判断依赖可变引用。
    const oldState = existing.state;

    const seqStr = String(seq);
    try {
      if (patch.title !== undefined) await backend.value.setTitle(seqStr, patch.title);
      if (patch.description !== undefined)
        await backend.value.setDescription(seqStr, patch.description);
      if (patch.skills !== undefined)
        await backend.value.setSkills(seqStr, sanitizeSkills(patch.skills));
      if (patch.labels !== undefined)
        await backend.value.setLabels(seqStr, sanitizeLabels(patch.labels));
      if (patch.state !== undefined && patch.state !== oldState) {
        await backend.value.move(seqStr, patch.state);
      }
    } catch (cause) {
      return err(domainError('internal', 'CARD_UPDATE_FAIL', '卡片更新失败', { cause }));
    }

    const fresh = await backend.value.getBySeq(seqStr);
    if (!fresh) return err(cardNotFound(seq));
    const summary = toCardSummary(fresh);

    const now = this.deps.clock.now();
    this.deps.events.emit({
      type: 'card.updated',
      project,
      seq,
      patch,
      ts: now,
    });
    if (patch.state !== undefined && patch.state !== oldState) {
      this.deps.events.emit({
        type: 'card.moved',
        project,
        seq,
        from: oldState,
        to: patch.state,
        ts: now,
      });
    }
    return ok(summary);
  }

  /** 仅状态变更（无其它字段）。等价于 update({state}) 但更语义化。 */
  async move(
    project: string,
    seq: number,
    newState: string,
  ): Promise<Result<CardSummary>> {
    return this.update(project, seq, { state: newState });
  }

  /** 删除卡片。Inprogress 拒绝（前置条件） */
  async delete(project: string, seq: number): Promise<Result<void>> {
    if (!isValidProject(project)) return err(invalidProject());
    if (!Number.isInteger(seq) || seq <= 0) return err(invalidSeq());
    const backend = await this.backendOr404(project);
    if (!backend.ok) return backend;
    const card = await backend.value.getBySeq(String(seq));
    if (!card) return err(cardNotFound(seq));
    if (card.state === 'Inprogress') {
      return err(
        domainError(
          'precondition',
          'CARD_IN_PROGRESS',
          '卡片正在运行，请先 kill worker 或移出 Inprogress',
          { details: { seq, state: card.state } },
        ),
      );
    }
    try {
      await backend.value.delete(String(seq));
    } catch (cause) {
      return err(domainError('internal', 'CARD_DELETE_FAIL', '卡片删除失败', { cause }));
    }
    this.deps.events.emit({
      type: 'card.deleted',
      project,
      seq,
      ts: this.deps.clock.now(),
    });
    return ok(undefined);
  }

  /**
   * 重置卡片 —— 清 frontmatter 运行字段（claimed_by / claimed_at / retry_count）
   * 同时清掉系统 labels（`AI-PIPELINE`、`STARTED-<stage>`、`COMPLETED-<stage>`、`NEEDS-FIX`）
   * 并移回初始态（Planning）。调用方负责先 kill 对应 worker。
   */
  async reset(project: string, seq: number): Promise<Result<CardSummary>> {
    if (!isValidProject(project)) return err(invalidProject());
    if (!Number.isInteger(seq) || seq <= 0) return err(invalidSeq());
    const backend = await this.backendOr404(project);
    if (!backend.ok) return backend;
    const card = await backend.value.getBySeq(String(seq));
    if (!card) return err(cardNotFound(seq));
    const oldState = card.state;  // 同 update：snapshot 避免 move 后回读失真

    const seqStr = String(seq);
    try {
      // 清 labels —— 只保留用户自定义（非系统 label）
      const cleanLabels = (card.labels ?? []).filter(
        (l) =>
          l !== 'AI-PIPELINE' &&
          l !== 'NEEDS-FIX' &&
          l !== 'CLAIMED' &&
          !l.startsWith('STARTED-') &&
          !l.startsWith('COMPLETED-'),
      );
      await backend.value.setLabels(seqStr, cleanLabels);
      await backend.value.releaseClaim(seqStr);
      await backend.value.resetRetryCount(seqStr);
      if (oldState !== 'Planning') {
        await backend.value.move(seqStr, 'Planning');
      }
    } catch (cause) {
      return err(domainError('internal', 'CARD_RESET_FAIL', '卡片重置失败', { cause }));
    }

    const fresh = await backend.value.getBySeq(seqStr);
    if (!fresh) return err(cardNotFound(seq));
    const now = this.deps.clock.now();
    this.deps.events.emit({
      type: 'card.updated',
      project,
      seq,
      patch: { state: 'Planning' },
      ts: now,
    });
    if (oldState !== 'Planning') {
      this.deps.events.emit({
        type: 'card.moved',
        project,
        seq,
        from: oldState,
        to: 'Planning',
        ts: now,
      });
    }
    return ok(toCardSummary(fresh));
  }

  // ─── 内部 ─────────────────────────────────────────────────────────

  private async backendOr404(
    project: string,
  ): Promise<Result<Awaited<ReturnType<TaskBackendFactory['for']>>>> {
    try {
      return ok(await this.deps.backendFactory.for(project));
    } catch (cause) {
      return err(
        domainError(
          'not-found',
          'PROJECT_NOT_FOUND',
          `项目 ${project} 不存在`,
          { cause, details: { project } },
        ),
      );
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function toCardSummary(card: Card): CardSummary {
  return {
    seq: Number.parseInt(card.seq, 10),
    title: card.title,
    state: card.state,
    skills: card.skills ?? [],
    labels: card.labels ?? [],
    branch: (card.meta?.branch as string) ?? null,
    createdAt: (card.meta?.createdAt as string) ?? null,
    updatedAt: (card.meta?.updatedAt as string) ?? null,
  };
}

function toCardDetail(card: Card): CardDetail {
  return {
    ...toCardSummary(card),
    body: card.desc ?? '',
    checklist: card.checklist ?? { total: 0, done: 0, percent: 0, items: [] },
    activeWorkerSlot: null, // 组合 WorkerService 时再填
  };
}

function sanitizeSkills(skills: string[]): string[] {
  return [...new Set(skills.map((s) => String(s).trim()).filter(Boolean))];
}

function sanitizeLabels(labels: string[]): string[] {
  return [...new Set(labels.map((l) => String(l).trim()).filter(Boolean))];
}

function isValidProject(project: string): boolean {
  return typeof project === 'string' && /^[a-zA-Z0-9_-]+$/.test(project);
}

function invalidProject(): DomainError {
  return domainError('validation', 'INVALID_PROJECT_NAME', '项目名非法');
}

function invalidSeq(): DomainError {
  return domainError('validation', 'INVALID_SEQ', 'seq 必须是正整数');
}

function invalidTitle(): DomainError {
  return domainError('validation', 'INVALID_TITLE', '卡片标题不能为空');
}

function invalidState(state: string): DomainError {
  return domainError('validation', 'INVALID_STATE', `state 非法：${state}`, {
    details: { allowed: ALLOWED_STATES },
  });
}

function cardNotFound(seq: number): DomainError {
  return domainError('not-found', 'CARD_NOT_FOUND', `卡片 #${seq} 不存在`, {
    details: { seq },
  });
}
