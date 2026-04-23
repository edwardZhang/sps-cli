/**
 * @module        shared/runtimePaths
 * @description   SPS 磁盘布局的唯一出处 —— 所有业务代码都从这里拼路径
 *
 * @layer         shared
 *
 * 解决 v0.49.5 / 15 / 16 反复踩到的"writer/reader 各自硬编码路径字符串"问题。
 * 全仓业务代码禁止再出现 literal `.coral` / `runtime/` / `worker-*-current.json`。
 *
 * 目录布局（v0.49.16 当前）：
 *   $HOME/.coral/
 *   ├── console.lock            单实例 Console 锁
 *   ├── env                     全局 env
 *   ├── sessions/               chat daemon socket + sessions
 *   ├── chat-sessions/
 *   ├── skills/                 user-level skills
 *   └── projects/<project>/
 *       ├── conf                shell-export 项目配置
 *       ├── cards/
 *       │   ├── seq.txt         自增序列
 *       │   └── <state>/        planning/backlog/todo/inprogress/qa/done
 *       │       └── <seq>-<slug>.md
 *       ├── pipelines/
 *       │   ├── project.yaml    active pipeline
 *       │   └── *.yaml          其它 preset
 *       ├── runtime/
 *       │   ├── state.json              RuntimeStore 权威状态
 *       │   ├── supervisor.pid          tick 进程 pid
 *       │   └── worker-<slotName>-current.json   marker（slotName="worker-N"，双前缀）
 *       └── logs/
 *           ├── pipeline-<date>.log
 *           └── sps-acp-<project>-<slot>-acp-<ts>.log
 *
 * 所有以下常量 / builder / pattern 都是该布局的投影。改布局必须改这里。
 */
import { resolve } from 'node:path';

// ─── Coral root ───────────────────────────────────────────────────

/**
 * 读 HOME —— 每次调用都重读环境变量，方便测试 mock。
 * 缺 HOME 立即抛 —— 这是严重配置错误，别 silently fallback。
 */
export function home(): string {
  const h = process.env.HOME;
  if (!h) {
    throw new Error('HOME environment variable not set — cannot resolve SPS paths');
  }
  return h;
}

/** $HOME/.coral —— SPS 数据根目录 */
export function coralRoot(): string {
  return resolve(home(), '.coral');
}

/** $HOME/.coral/console.lock —— Console 单实例锁文件 */
export function consoleLockFile(): string {
  return resolve(coralRoot(), 'console.lock');
}

/** $HOME/.coral/env —— 全局环境变量文件 */
export function globalEnvFile(): string {
  return resolve(coralRoot(), 'env');
}

/** $HOME/.coral/sessions —— chat daemon unix socket 所在目录 */
export function sessionsDir(): string {
  return resolve(coralRoot(), 'sessions');
}

/** $HOME/.coral/chat-sessions —— chat 会话持久化目录 */
export function chatSessionsDir(): string {
  return resolve(coralRoot(), 'chat-sessions');
}

/** $HOME/.coral/skills —— user-level skills */
export function userSkillsDir(): string {
  return resolve(coralRoot(), 'skills');
}

/** $HOME/.coral/projects —— 项目根目录 */
export function projectsDir(): string {
  return resolve(coralRoot(), 'projects');
}

// ─── Project layout ───────────────────────────────────────────────

/** $HOME/.coral/projects/<name> */
export function projectDir(project: string): string {
  return resolve(projectsDir(), project);
}

/** $HOME/.coral/projects/<name>/conf */
export function projectConfFile(project: string): string {
  return resolve(projectDir(project), 'conf');
}

/** $HOME/.coral/projects/<name>/runtime */
export function runtimeDir(project: string): string {
  return resolve(projectDir(project), 'runtime');
}

/** $HOME/.coral/projects/<name>/runtime/state.json —— RuntimeStore 权威状态 */
export function stateFile(project: string): string {
  return resolve(runtimeDir(project), 'state.json');
}

/** $HOME/.coral/projects/<name>/runtime/supervisor.pid —— tick 进程 pid */
export function supervisorPidFile(project: string): string {
  return resolve(runtimeDir(project), 'supervisor.pid');
}

// ─── Worker marker ────────────────────────────────────────────────
// 这是 v0.49.16 踩最深的坑：slotName 形如 "worker-1"，拼出来就是
// worker-worker-1-current.json（双 worker- 前缀）。此常量是唯一真相。

/**
 * Worker marker 物理文件路径。
 * @param project 项目名
 * @param slotName slot 的完整字符串名（如 "worker-1"），不是数字
 * @returns $HOME/.coral/projects/<project>/runtime/worker-<slotName>-current.json
 *          即 worker-worker-N-current.json（双前缀）
 */
export function workerMarkerFile(project: string, slotName: string): string {
  return resolve(runtimeDir(project), `worker-${slotName}-current.json`);
}

/**
 * 把数字 slot 转成 slotName（"worker-<N>"）—— 约定俗成。
 * 当 UI / 外部 API 传数字时用这个规范化。
 */
export function slotNameFromNumber(slot: number): string {
  return `worker-${slot}`;
}

/**
 * Worker marker 文件名的正则 —— 识别 runtime 目录里属于 marker 的文件。
 * 匹配两种格式（兼容老数据）：
 *   worker-worker-<N>-current.json   ← 现在的实际格式（slotName="worker-N"）
 *   worker-<N>-current.json          ← 老兼容
 * Capture group 1 是数字 slot（字符串形式）。
 */
export const WorkerMarkerFilenameRe = /^worker-(?:worker-)?(\d+)-current\.json$/;

/**
 * 从文件名抽 slot 数字。非 marker 文件名返 null。
 */
export function slotFromMarkerFilename(filename: string): number | null {
  const m = filename.match(WorkerMarkerFilenameRe);
  if (!m) return null;
  const n = Number.parseInt(m[1] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ─── Cards ────────────────────────────────────────────────────────

/** $HOME/.coral/projects/<name>/cards */
export function cardsDir(project: string): string {
  return resolve(projectDir(project), 'cards');
}

/** $HOME/.coral/projects/<name>/cards/seq.txt —— 自增序列 */
export function cardsSeqFile(project: string): string {
  return resolve(cardsDir(project), 'seq.txt');
}

/**
 * $HOME/.coral/projects/<name>/cards/<state-lower-snake>
 * state 做小写 + 非字母数字替成 '-' 的正规化（和 MarkdownTaskBackend 保持一致）。
 */
export function cardsStateDir(project: string, state: string): string {
  const dirName = state.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return resolve(cardsDir(project), dirName);
}

// ─── Logs ─────────────────────────────────────────────────────────

/** $HOME/.coral/projects/<name>/logs */
export function logsDir(project: string): string {
  return resolve(projectDir(project), 'logs');
}

/** pipeline-<YYYY-MM-DD>.log 文件名 pattern */
export const PipelineLogFilenameRe = /^pipeline-\d{4}-\d{2}-\d{2}\.log$/;

/** worker-<N> 标签在日志行里出现的 pattern，用于过滤 */
export function workerLogLineTag(slot: number): string {
  return `worker-${slot}`;
}

// ─── Pipelines ────────────────────────────────────────────────────

/** $HOME/.coral/projects/<name>/pipelines */
export function pipelinesDir(project: string): string {
  return resolve(projectDir(project), 'pipelines');
}

/** $HOME/.coral/projects/<name>/pipelines/project.yaml —— 活动 pipeline */
export function activePipelineFile(project: string): string {
  return resolve(pipelinesDir(project), 'project.yaml');
}

/** 命名具体某个 pipeline yaml 文件 */
export function pipelineFile(project: string, filename: string): string {
  return resolve(pipelinesDir(project), filename);
}

/** pipeline yaml 文件名白名单正则 —— 防路径穿越 */
export const PipelineFilenameRe = /^[a-zA-Z0-9_.-]+\.yaml(\.example)?$/;
