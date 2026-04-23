/**
 * @module        services/WorkerService
 * @description   Worker 查询 + 控制 service
 *
 * @layer         services
 *
 * 职责：
 *   - 读 runtime/worker-worker-<N>-current.json marker → 结构化 WorkerInfo
 *   - 列项目 workers / 跨项目聚合
 *   - launch / kill —— Phase 2 暂不负责真 spawn，返 pending port（Phase 3 填）
 *
 * 不负责：
 *   - marker 写入（worker-manager 的事）
 *   - 日志 tail（LogService）
 */

import { resolve } from 'node:path';
import type { Clock } from '../infra/clock.js';
import type { FileSystem } from '../infra/filesystem.js';
import type { DomainEventBus } from '../shared/domainEvents.js';
import { type DomainError, domainError } from '../shared/errors.js';
import { err, ok, type Result } from '../shared/result.js';
import {
  projectDir,
  projectsDir,
  runtimeDir,
  slotFromMarkerFilename,
  stateFile,
  WorkerMarkerFilenameRe,
  workerMarkerFile,
} from '../shared/runtimePaths.js';
import { WorkerMarkerSchema } from '../shared/runtimeSchemas.js';

/**
 * 读 state.json 里某 slot 的 status + seq。权威的"worker 是否在跑"信号。
 * 文件不存在 / 解析失败 → 返 null，WorkerService 回落到只看 marker。
 */
function readSlotStateJson(
  fs: FileSystem,
  project: string,
  slotName: string,
): { status: string; seq: number | null } | null {
  const path = stateFile(project);
  if (!fs.exists(path)) return null;
  try {
    const raw = fs.readFile(path);
    const parsed = JSON.parse(raw) as { workers?: Record<string, { status?: string; seq?: number | null }> };
    const w = parsed.workers?.[slotName];
    if (!w) return null;
    return { status: String(w.status ?? 'idle'), seq: w.seq ?? null };
  } catch {
    return null;
  }
}

export type WorkerState = 'idle' | 'starting' | 'running' | 'stuck' | 'crashed';

export interface WorkerInfo {
  readonly slot: number;
  readonly pid: number | null;
  readonly state: WorkerState;
  readonly card: { seq: number; title: string } | null;
  readonly stage: string | null;
  readonly startedAt: string | null;
  readonly runtimeMs: number | null;
  readonly markerUpdatedAt: string | null;
}

export interface AggregateResult {
  readonly alerts: Array<WorkerInfo & { project: string }>;
  readonly active: Array<WorkerInfo & { project: string }>;
  readonly capacity: Array<{
    project: string;
    total: number;
    running: number;
    starting: number;
    stuck: number;
    crashed: number;
    idle: number;
  }>;
}

/** Service 让调用方注入 launch/kill 执行器（Phase 3 由 CLI 命令绑定） */
export interface WorkerExecutor {
  launch(project: string, seq: number): Promise<void>;
  kill(project: string, slot: number): Promise<void>;
}

const STUCK_THRESHOLD_MS = 5 * 60 * 1000;
const ACK_TIMEOUT_MS = 60 * 1000;

export interface WorkerServiceDeps {
  readonly fs: FileSystem;
  readonly clock: Clock;
  readonly events: DomainEventBus;
  /** 卡片 title 反查器（CardService 实例或类似），Phase 3 注入。不注入则 title 用 `#<seq>`。 */
  readonly cardTitleLookup?: (project: string, seq: number) => Promise<string | null>;
  readonly executor?: WorkerExecutor;
}

export class WorkerService {
  constructor(private readonly deps: WorkerServiceDeps) {}

  /** 列单项目的 worker slots（按 slot 数字升序）。 */
  async listByProject(project: string): Promise<Result<WorkerInfo[], DomainError>> {
    if (!isValidProject(project)) return err(invalidProject());
    const dir = runtimeDir(project);
    if (!this.deps.fs.exists(dir)) return ok([]);
    const slots = this.listMarkerSlots(project);
    const infos: WorkerInfo[] = [];
    for (const { slot, file } of slots) {
      infos.push(await this.buildInfo(project, slot, file));
    }
    return ok(infos.sort((a, b) => a.slot - b.slot));
  }

  /** 单 slot detail。 */
  async getBySlot(
    project: string,
    slot: number,
  ): Promise<Result<WorkerInfo, DomainError>> {
    if (!isValidProject(project)) return err(invalidProject());
    if (!Number.isInteger(slot) || slot <= 0) {
      return err(domainError('validation', 'INVALID_SLOT', 'slot 必须是正整数'));
    }
    const candidates = this.resolveMarkerPath(project, slot);
    if (!candidates) {
      return err(
        domainError('not-found', 'WORKER_MARKER_NOT_FOUND', `worker-${slot} marker 不存在`),
      );
    }
    return ok(await this.buildInfo(project, slot, candidates));
  }

  /** 跨项目聚合 —— Workers 页用。 */
  async aggregate(): Promise<Result<AggregateResult, DomainError>> {
    const root = projectsDir();
    if (!this.deps.fs.exists(root)) {
      return ok({ alerts: [], active: [], capacity: [] });
    }
    let projects: string[];
    try {
      projects = this.deps.fs.readDir(root).filter((e) => e.isDirectory).map((e) => e.name);
    } catch (cause) {
      return err(domainError('internal', 'PROJECTS_READ_FAIL', '项目目录读取失败', { cause }));
    }
    projects.sort();
    const result: AggregateResult = { alerts: [], active: [], capacity: [] };
    for (const project of projects) {
      const slots = this.listMarkerSlots(project);
      const stats = {
        project,
        total: slots.length,
        running: 0,
        starting: 0,
        stuck: 0,
        crashed: 0,
        idle: 0,
      };
      for (const { slot, file } of slots) {
        const info = await this.buildInfo(project, slot, file);
        stats[info.state]++;
        if (info.state === 'stuck' || info.state === 'crashed') {
          result.alerts.push({ ...info, project });
        } else if (info.state === 'running' || info.state === 'starting') {
          result.active.push({ ...info, project });
        }
      }
      result.capacity.push(stats);
    }
    result.alerts.sort((a, b) => {
      if (a.state !== b.state) return a.state === 'stuck' ? -1 : 1;
      return (b.runtimeMs ?? 0) - (a.runtimeMs ?? 0);
    });
    result.active.sort((a, b) => (b.runtimeMs ?? 0) - (a.runtimeMs ?? 0));
    return ok(result);
  }

  /** launch 转发到注入的 executor。未注入返 internal。 */
  async launch(project: string, seq: number): Promise<Result<void>> {
    if (!isValidProject(project)) return err(invalidProject());
    if (!Number.isInteger(seq) || seq <= 0) {
      return err(domainError('validation', 'INVALID_SEQ', 'seq 必须是正整数'));
    }
    if (!this.deps.executor) {
      return err(
        domainError(
          'internal',
          'WORKER_EXECUTOR_MISSING',
          '需要注入 WorkerExecutor（Phase 3 task）',
        ),
      );
    }
    if (!this.deps.fs.exists(projectDir(project))) {
      return err(
        domainError('not-found', 'PROJECT_NOT_FOUND', `项目 ${project} 不存在`),
      );
    }
    try {
      await this.deps.executor.launch(project, seq);
    } catch (cause) {
      return err(
        domainError('external', 'WORKER_LAUNCH_FAIL', 'worker launch 失败', {
          cause,
          details: { message: cause instanceof Error ? cause.message : String(cause) },
        }),
      );
    }
    return ok(undefined);
  }

  async kill(project: string, slot: number): Promise<Result<void>> {
    if (!isValidProject(project)) return err(invalidProject());
    if (!Number.isInteger(slot) || slot <= 0) {
      return err(domainError('validation', 'INVALID_SLOT', 'slot 必须是正整数'));
    }
    if (!this.deps.executor) {
      return err(
        domainError('internal', 'WORKER_EXECUTOR_MISSING', '需要注入 WorkerExecutor'),
      );
    }
    try {
      await this.deps.executor.kill(project, slot);
    } catch (cause) {
      return err(
        domainError('external', 'WORKER_KILL_FAIL', 'worker kill 失败', {
          cause,
          details: { message: cause instanceof Error ? cause.message : String(cause) },
        }),
      );
    }
    return ok(undefined);
  }

  // ─── 内部 ─────────────────────────────────────────────────────────

  /** 扫 runtime/ 下 marker 文件，匹配双前缀 + 单前缀，返 slot 数字 + 实际路径 */
  private listMarkerSlots(project: string): Array<{ slot: number; file: string }> {
    const dir = runtimeDir(project);
    if (!this.deps.fs.exists(dir)) return [];
    try {
      return this.deps.fs
        .readDir(dir)
        .filter((e) => e.isFile && WorkerMarkerFilenameRe.test(e.name))
        .map((e) => {
          const slot = slotFromMarkerFilename(e.name);
          return { slot: slot ?? 0, file: resolve(dir, e.name) };
        })
        .filter((x) => x.slot > 0);
    } catch {
      return [];
    }
  }

  /** 优先双前缀，再试老单前缀 */
  private resolveMarkerPath(project: string, slot: number): string | null {
    const doublePrefix = workerMarkerFile(project, `worker-${slot}`);
    if (this.deps.fs.exists(doublePrefix)) return doublePrefix;
    // 老兼容：worker-<N>-current.json（单前缀）
    const single = resolve(runtimeDir(project), `worker-${slot}-current.json`);
    if (this.deps.fs.exists(single)) return single;
    return null;
  }

  private async buildInfo(
    project: string,
    slot: number,
    markerPath: string,
  ): Promise<WorkerInfo> {
    const now = this.deps.clock.now();
    let pid: number | null = null;
    let card: WorkerInfo['card'] = null;
    let stage: string | null = null;
    let startedAt: string | null = null;
    let markerUpdatedAt: string | null = null;

    try {
      const raw = this.deps.fs.readFile(markerPath);
      const parsed = WorkerMarkerSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        const d = parsed.data;
        pid = d.pid ?? null;
        stage = d.stage;
        startedAt = d.dispatchedAt;
        const seq = parseSeqFromCardId(d.cardId);
        if (seq !== null) {
          let title = `#${seq}`;
          if (this.deps.cardTitleLookup) {
            try {
              const t = await this.deps.cardTitleLookup(project, seq);
              if (t) title = t;
            } catch {
              /* lookup 失败用 fallback */
            }
          }
          card = { seq, title };
        }
      }
    } catch {
      /* marker 读不了就按最小信息返 */
    }
    const stat = this.deps.fs.stat(markerPath);
    if (stat) markerUpdatedAt = new Date(stat.mtimeMs).toISOString();

    const alive = isPidAlive(pid);
    const fresh = markerUpdatedAt ? now - new Date(markerUpdatedAt).getTime() < STUCK_THRESHOLD_MS : false;
    const ageMs = markerUpdatedAt ? now - new Date(markerUpdatedAt).getTime() : null;

    // v0.50.5：state.json 是"slot 是否在跑"的权威源。worker 完成后 supervisor 会把
    // slot.status 置 idle + seq=null，但 marker 文件不清（hook 还要靠它反查 current-card）。
    // 仅看 marker 会把已完成的 slot 当 running → 5 分钟后 stuck。这里先读 state.json：
    //   - slot.status === 'idle' → 报 idle，卡片信息清空（marker 残留忽略）
    //   - 否则保留原来的"marker 导向"状态机
    const slotName = `worker-${slot}`;
    const slotJson = readSlotStateJson(this.deps.fs, project, slotName);
    const slotIsIdle = slotJson?.status === 'idle' || slotJson?.seq === null;

    let state: WorkerState;
    if (slotIsIdle) {
      state = 'idle';
    } else if (!alive) {
      state = card !== null ? 'crashed' : 'idle';
    } else if (card === null) {
      state = 'idle';
    } else {
      const starting = ageMs !== null && ageMs <= ACK_TIMEOUT_MS;
      if (starting) state = 'starting';
      else if (!fresh) state = 'stuck';
      else state = 'running';
    }

    // idle 状态下不再展示卡片（前端 "active 列表" 会把 idle 过滤掉；但 detail 页也不该还显示上次的卡）
    const cardOut = state === 'idle' ? null : card;

    const runtimeMs = startedAt && state !== 'idle' ? now - new Date(startedAt).getTime() : null;
    return {
      slot,
      pid,
      state,
      card: cardOut,
      stage: state === 'idle' ? null : stage,
      startedAt: state === 'idle' ? null : startedAt,
      runtimeMs,
      markerUpdatedAt,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function parseSeqFromCardId(cardId: string): number | null {
  const m = cardId.match(/^(?:md-)?(\d+)$/);
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function isPidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isValidProject(project: string): boolean {
  return typeof project === 'string' && /^[a-zA-Z0-9_-]+$/.test(project);
}

function invalidProject(): DomainError {
  return domainError('validation', 'INVALID_PROJECT_NAME', '项目名非法');
}
