/**
 * @module        shared/runtimeSchemas
 * @description   零散磁盘对象的 zod schema —— 唯一出处
 *
 * @layer         shared
 *
 * 解决 v0.49.5 / 15 / 16 踩过的"writer 和 reader 各自硬编码解析器，schema 改了一处漂移"的坑。
 *
 * 所有写入点 `writeXxx.parse(payload)`，所有读取点 `XxxSchema.safeParse(raw)`。
 * 任何一侧加字段，另一侧 TS 类型直接不兼容 —— 编译期拦截漂移。
 */
import { z } from 'zod';

// ─── Worker marker file ───────────────────────────────────────────
// 物理位置：~/.coral/projects/<project>/runtime/worker-<slotName>-current.json
// slotName 形如 "worker-1"，所以最终文件名是 worker-worker-1-current.json（v0.49.16）

export const WorkerMarkerSchema = z.object({
  /** 卡片 id（形如 "md-<seq>" 或裸 seq 字符串） */
  cardId: z.string().min(1),
  /** 当前阶段名，如 "develop" / "qa" / "review" */
  stage: z.string().min(1),
  /** ISO 8601 派发时间 */
  dispatchedAt: z.string().datetime(),
  /** ACP session ID，spawn 成功后写入 */
  sessionId: z.string().optional(),
  /** 子进程 PID，spawn 成功后写入 */
  pid: z.number().int().positive().optional(),
});

export type WorkerMarker = z.infer<typeof WorkerMarkerSchema>;

// ─── Card frontmatter ─────────────────────────────────────────────
// 存在 cards/<state>/<seq>-<slug>.md 的 YAML frontmatter 里

export const CardFrontmatterSchema = z.object({
  seq: z.number().int().nonnegative(),
  title: z.string().min(1),
  labels: z.array(z.string()).default([]),
  skills: z.array(z.string()).default([]),
  created: z.string().optional(),
  updated: z.string().optional(),
  branch: z.string().nullable().optional(),
  claimed_by: z.string().nullable().optional(),
  claimed_at: z.string().nullable().optional(),
  retry_count: z.number().int().nonnegative().optional(),
  meta: z.record(z.unknown()).optional(),
});

export type CardFrontmatter = z.infer<typeof CardFrontmatterSchema>;

// ─── project conf (shell-export syntax) ───────────────────────────
// 物理位置：~/.coral/projects/<project>/conf
// 解析由 parseConf 完成（shell-export 不是 YAML/JSON），schema 仅校验解析后的字段

export const ProjectConfSchema = z.object({
  PROJECT_NAME: z.string().min(1),
  PROJECT_DIR: z.string().min(1),
  PM_TOOL: z.enum(['markdown', 'gitlab', 'github']).default('markdown'),
  AGENT_PROVIDER: z.string().default('claude'),
  MAX_WORKERS: z
    .string()
    .regex(/^\d+$/)
    .default('1'),
  MERGE_BRANCH: z.string().default('main'),
  GITLAB_PROJECT: z.string().optional(),
  GITLAB_PROJECT_ID: z.string().optional(),
  MATRIX_ROOM_ID: z.string().optional(),
  REPO_DIR: z.string().optional(), // 老字段，兼容
});

export type ProjectConf = z.infer<typeof ProjectConfSchema>;

// ─── state.json (RuntimeStore 写) ─────────────────────────────────
// 物理位置：~/.coral/projects/<project>/runtime/state.json
// schema 只覆盖外部 service 会读的字段，不是 RuntimeStore 完整内部结构

export const WorkerSlotStateSchema = z.object({
  status: z.enum(['idle', 'active', 'merging', 'resolving', 'releasing']),
  seq: z.number().nullable(),
  branch: z.string().nullable(),
  worktree: z.string().nullable(),
  claimedAt: z.string().nullable(),
  lastHeartbeat: z.string().nullable(),
  mode: z.enum(['print', 'acp', 'acp-sdk']).nullable().optional(),
  agent: z.enum(['claude']).nullable().optional(),
  pid: z.number().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  remoteStatus: z
    .enum([
      'submitted',
      'running',
      'waiting_input',
      'needs_confirmation',
      'stalled_submit',
      'completed',
      'failed',
      'cancelled',
      'lost',
    ])
    .nullable()
    .optional(),
  completedAt: z.string().nullable().optional(),
});

export const StateJsonSchema = z.object({
  workers: z.record(WorkerSlotStateSchema),
  // ActiveCardState map 等其它字段对 Service 层不可见，用 unknown passthrough
});

export type WorkerSlotStatePayload = z.infer<typeof WorkerSlotStateSchema>;

// ─── project.yaml / pipeline config ───────────────────────────────
// 物理位置：~/.coral/projects/<project>/pipelines/project.yaml

const StageSchema = z.object({
  name: z.string().min(1),
  trigger_state: z.string().optional(),
  active_state: z.string().optional(),
  on_complete: z.string().optional(),
  on_fail: z
    .object({
      action: z.string().optional(),
      halt: z.boolean().optional(),
    })
    .optional(),
  agent: z.string().optional(),
  cwd: z.string().optional(),
});

export const PipelineYamlSchema = z.object({
  mode: z.enum(['project', 'single', 'card']).default('project'),
  states: z
    .object({
      planning: z.string().optional(),
      backlog: z.string().optional(),
      ready: z.string().optional(),
      done: z.string().optional(),
    })
    .optional(),
  stages: z.array(StageSchema).min(1),
  // 其它字段透传
});

export type PipelineYaml = z.infer<typeof PipelineYamlSchema>;
