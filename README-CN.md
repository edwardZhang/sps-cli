# SPS CLI — AI Agent 流水线编排器

[![npm](https://img.shields.io/npm/v/@coralai/sps-cli)](https://www.npmjs.com/package/@coralai/sps-cli) [![license](https://img.shields.io/npm/l/@coralai/sps-cli)](./LICENSE)

> **English**：[README.md](./README.md)

**v0.51.3**

SPS（Smart Pipeline System）驱动 Claude Code worker 走完任务卡 — 写代码、commit、push、QA、合并，全自动。三种模式：

| 模式 | 命令 | 适用场景 |
|---|---|---|
| **Harness** | `sps agent` | 零配置 — 与 Claude 一次性对话或多轮 chat。无需建项目、无需 PM。 |
| **Pipeline** | `sps tick <project>` | 自动化 — 卡片按 YAML 走完 stage 直到 Done。 |
| **Console** | `sps console` | Web UI — 看板、日志、worker、项目、聊天（v0.44+）。 |

v0.51 头条特性是 **Wiki 知识库** — per-project 可选，结构化互链 page（modules / concepts / decisions / lessons / sources），自动注入 worker prompt 的 5 层检索结果。详见 [`ATTRIBUTION.md`](./ATTRIBUTION.md) 了解借鉴归属。

---

## 目录

- [安装与初始化](#安装与初始化)
- [Harness 模式（`sps agent`）](#harness-模式sps-agent)
- [Console 模式（`sps console`）](#console-模式sps-console)
- [Pipeline 模式（`sps tick`）](#pipeline-模式sps-tick)
- [卡片生命周期](#卡片生命周期)
- [Memory + Wiki](#memory--wiki)
- [Skills](#skills)
- [命令参考](#命令参考)
- [项目配置（conf）](#项目配置conf)
- [目录布局](#目录布局)
- [架构](#架构)
- [Troubleshooting](#troubleshooting)

---

## 安装与初始化

```bash
npm install -g @coralai/sps-cli      # 最新 0.51.x
sps setup                            # 交互式向导（首次必跑）
```

`sps setup` 做的事：
1. 创建 `~/.coral/` 目录树（`projects/`、`memory/{user,agents}/`）。
2. 把 bundled skills 复制到 `~/.coral/skills/`。
3. 询问 `GITLAB_URL` / `GITLAB_TOKEN` / `MATRIX_*`（可跳过），写到 `~/.coral/env`。
4. 把 user skill symlink 到 `~/.claude/skills/`。
5. 全局安装 `@agentclientprotocol/claude-agent-acp`。

`sps setup --force` 重跑（保留旧值作默认）。**升级 sps-cli 后必须跑 `sps skill sync --force`** 才能拉新版 skill SOP（默认 sync 是非破坏性的，不会覆盖已有 skill）。

**前置条件**：Node ≥ 18；Anthropic API key（或 Claude Pro / Max 订阅）；`claude` CLI 在 PATH。

---

## Harness 模式（`sps agent`）

直接和 Claude 对话，单次或多轮。无项目、无 PM、无 git。

```bash
# 一次性
sps agent "解释这个 repo"
sps agent --output summary.md "总结架构"

# 多轮（daemon 后端，会话持久化）
sps agent --chat                              # 交互 REPL
sps agent --chat --name reviewer              # 命名会话，下次可继续
sps agent status                              # 列活跃会话
sps agent close --name reviewer

# Profile + 上下文文件
sps agent --profile reviewer "审这个模块" --context src/auth.ts --context src/auth.test.ts
sps agent --system "你是发布工程师" "规划 v0.52 切版"

# Verbose
sps agent --verbose "为什么构建失败"
```

**`--profile <name>`**：查 `~/.coral/skills/dev-worker/references/<name>.md`，作为 system prompt 注入。（注意区别 `sps skill add` — 那是项目级 skill 链接。）

**Built-in agent**：仅 `claude`（Codex / Gemini 支持已在 v0.38 移除）。Worker 通过 ACP JSON-RPC over stdio 与 `claude-agent-acp` 通信。

**Agent skill 由 Claude Code 自己加载**：`~/.claude/skills/` 是 `claude` 自己扫的目录 — 含 `sps-pipeline`、`sps-memory`、`wiki-update`、以及 24 个 dev / persona skill。Skill description 触发懒加载，harness 模式不需要 SPS 主动注入。

**Daemon cwd 注意**：`sps console` 和 `sps agent --chat` 启动 session daemon（`~/.coral/sessions/daemon.sock`），daemon 启动时捕获 `process.cwd()` 作为所有 chat worker 的默认工作目录。要切目录必须重启 daemon：`sps agent daemon stop && sps agent daemon start`，从目标目录发起。

---

## Console 模式（`sps console`）

本机 web UI，打包进二进制。`~/.coral/console.lock` 单实例保证。

```bash
sps console                          # 打开 http://127.0.0.1:4311
sps console --port 5000
sps console --no-open                # 不自动开浏览器
sps console --kill                   # 停止运行中的 console
sps console --dev                    # vite dev 模式（开发用）
```

页面：

| 路径 | 用途 |
|---|---|
| `/projects` | 项目列表 + 状态摘要 |
| `/projects/new` | 新建项目（含 Wiki 开关，v0.51+） |
| `/projects/<n>` | Pipeline 编辑器 + conf 编辑器 + 删除 |
| `/board` | 看板（列内独立滚动，v0.51.1+） |
| `/workers` | 跨项目聚合 worker 仪表板 |
| `/logs` | 实时 SSE 日志查看器 |
| `/skills` | User-level skill 管理 |
| `/system` | 全局设置 + daemon 状态 |
| `/chat` | Agent 聊天（多会话，持久化） |

技术栈：Hono server on `127.0.0.1:4311`、chokidar 推 SSE 给 React 19 + Vite + Tailwind v4 + shadcn/ui 前端。设计系统：Pastel Neubrutalism，规范在 [`console/DESIGN.md`](./console/DESIGN.md)。

---

## Pipeline 模式（`sps tick`）

全自动卡片驱动。**单 worker，单卡，串行**。每卡走 YAML 定义的若干 stage（如 `develop → review → Done`）；失败 → halt pipeline 直到你移除 `NEEDS-FIX` 标签。

### 建项目

```bash
sps project init my-app
# 或用 Console /projects/new — 表单含 Wiki 开关（v0.51+）
```

会问：项目目录、合并分支、最大 worker 数、ACK 超时、可选 GitLab 远程、可选 Matrix 房间。

生成：

```
~/.coral/projects/my-app/
├── conf                              # mode 600 — 当前活动配置
├── conf.example                      # 字段全参考（自动生成）
├── pipelines/
│   ├── project.yaml                  # 默认 1-stage（develop → Done）
│   └── sample.yaml.example           # YAML 完整带注释参考
└── pipeline_order.json               # 当前 active pipeline 指针
```

在目标 repo（PROJECT_DIR）下：

```
.claude/CLAUDE.md                     # Worker 规则（自动安装）
.claude/skills/                       # 从 ~/.coral/skills/ symlink
.claude/settings.local.json           # Claude Code 本地配置
wiki/                                 # 若 WIKI_ENABLED — 项目知识库
ATTRIBUTION.md                        # 若 WIKI_ENABLED
```

### 运行

```bash
sps tick my-app                      # 前台 tick 循环
sps pipeline start my-app            # 别名
sps pipeline stop my-app             # 优雅停（别名 sps stop my-app）
sps stop --all                       # 停所有运行中的 tick
sps status                           # 看所有项目
```

### Pipeline YAML

`~/.coral/projects/<n>/pipelines/project.yaml` — stage 单一来源。

```yaml
mode: project
git: true                            # false = 非代码项目，无 git 操作
stages:
  - name: develop
    profile: fullstack
    on_complete: "move_card Review"
    on_fail: { action: "label NEEDS-FIX", halt: true }
  - name: review
    profile: reviewer
    on_complete: "move_card Done"
    on_fail: { action: "label REVIEW-FAILED", halt: true }
```

关键规则：
1. `mode: project` 是状态机式 pipeline；`mode: steps` 是一次性脚本，用 `sps pipeline run <name>` 触发。
2. 每个 stage 的 `on_complete` 必须指向**下一个** stage 的目标 state。
3. 最后一个 stage `on_complete: "move_card Done"`。
4. 别写 `agent:` 字段 — v0.38+ 起被静默忽略（Claude 是唯一 worker）。
5. `trigger` 和 `card_state` 按 stage 位置自动推导。

字段全集见 `~/.coral/projects/<n>/pipelines/sample.yaml.example`（自动生成，注释丰富）。

---

## 卡片生命周期

```
Backlog → Todo → Inprogress → [QA / Review] → Done
   ↑↓                  ↓ 失败
Planning           NEEDS-FIX (halt)
(人工暂存，v0.51.9+)
```

**v0.51.10**：按调用方区分默认入场状态。
- **`sps card add`（CLI / agent / 直接调 API）** → **Backlog**（自动跑）
- **Console "新卡片" 表单（人在 UI 操作）** → **Planning**（暂存，等用户拖到 Backlog 派发）

CLI 用户想暂存：`sps card add ... --draft`。Console 用户想立即跑：勾"立即派发执行"。
卡片严格按 seq 排序；不再有 pipeline_order.json。

默认状态（可在 YAML `pm.card_states` 自定义）。

```bash
sps card add <p> "标题" "描述"
sps card add <p> "T" "D" --skills python,backend --labels feature

sps card dashboard <p>               # CLI 表格
                                     # console: /board?project=<n>

sps card mark-started <p> <seq>     # 由 Claude Code UserPromptSubmit hook 调用
sps card mark-complete <p> <seq>    # 由 Claude Code Stop hook 调用

sps reset <p>                        # 重置非 Done 卡
sps reset <p> --card 5,6,7
sps reset <p> --all                  # 全重置含 Done + worktree + branch
```

### 卡片标签词典

| 标签 | 含义 | 设置者 |
|---|---|---|
| `AI-PIPELINE` | 进入 pipeline 的必备标签 | 创建时由用户加 |
| `STARTED-<stage>` | ACK 信号 — Claude 收到了 prompt | UserPromptSubmit hook |
| `COMPLETED-<stage>` | Worker 完成了某 stage | Stop hook |
| `CLAIMED` | StageEngine 占了 worker slot | Engine |
| `NEEDS-FIX` | Worker 失败；pipeline halt | Engine |
| `BLOCKED` | 外部依赖阻塞；pipeline 跳过 | 用户 |
| `WAITING-CONFIRMATION` | Worker 等用户输入 | Engine |
| `STALE-RUNTIME` | Inprogress 超时 | MonitorEngine |
| `ACK-TIMEOUT` | Claude 在 `WORKER_ACK_TIMEOUT_S` 内没 ACK | MonitorEngine |
| `skill:<name>` | 强制加载某 skill | 用户 |
| `conflict:<domain>` | 同 domain 内串行 | 用户 |

活动 stage 会在 `~/.coral/projects/<p>/runtime/worker-<slot>-current.json` 写 marker 文件（v0.50.21+），Stop hook 读它判断 worker 刚刚做完哪张卡。

---

## Memory + Wiki

两套互补的持久化系统，都自动注入 worker prompt。

| | **Memory** | **Wiki**（v0.51+） |
|---|---|---|
| 路径 | `~/.coral/memory/{user,agents,projects/<p>}/` | `<repo>/wiki/`（per-project，进 repo） |
| 格式 | 平铺 markdown + YAML frontmatter | 5 类 page，zod 校验的 frontmatter |
| 互链 | 无（平铺索引） | `[[type/Title]]` wikilink |
| 自动注入 | prompt 的 `knowledge` 段 | `wikiContext` 段（5 层检索） |
| 开关 | 默认开（`ENABLE_MEMORY=false` 关） | per-project（`WIKI_ENABLED=true` 开） |
| 适合 | 个人偏好、零散决策、坑 | 结构化项目知识：modules、concepts、decisions、lessons |

### Memory CLI

```bash
sps memory list <p>                            # 看项目 memory 索引
sps memory list                                # 看全局 user + agents
sps memory context <p> --card <seq>            # 预览注入内容

sps memory add <p> --type convention --name "API 用 camelCase" \
  --description "REST 接口用 camelCase" --body "..."
```

类型：`convention`（不衰减）、`decision`（缓慢衰减）、`lesson`（30 天衰减）、`reference`（不衰减）。

### Wiki CLI（`WIKI_ENABLED=true` 时）

```bash
sps wiki init <p>                              # scaffold wiki/（开了 toggle 时建项目自动跑）
sps wiki update <p>                            # 看 source diff
sps wiki update <p> --finalize                 # worker 写完 page 后刷新 manifest
sps wiki check <p>                             # lint：orphan / dead-link / fm-gap / stale
sps wiki list <p> --type lesson --tag pipeline
sps wiki get <p> lessons/Stop-Hook-Race
sps wiki status <p>                            # source ↔ manifest ↔ pages 差异
sps wiki add <p> ~/notes.md --category transcripts
sps wiki read <p> "<query>"                    # 预览 5 层检索
```

5 层检索：hot.md / index 节选 / pinned / skill-tag / BM25F keyword。类型优先级：lesson = 3、decision = 3、concept = 2、module = 1、source = 1。Token 预算硬上限 ~2000。

Worker SOP：[`skills/wiki-update/SKILL.md`](./skills/wiki-update/SKILL.md)（300 行，单一来源）。

---

## Skills

User-level skill 在 `~/.coral/skills/`（28 个 bundled，`sps setup` 时从 npm 包拷贝）。Symlink 到 `~/.claude/skills/`，Claude Code 自动加载。

```bash
sps skill list                                 # 列可用 + 项目链接状态
sps skill add <name> --project <p>             # symlink 到 <repo>/.claude/skills/
sps skill remove <name> --project <p>
sps skill freeze <name> --project <p>          # symlink → 真实副本（项目可定制）
sps skill unfreeze <name> --project <p>        # 改回 symlink
sps skill sync                                 # ① bundled (npm 包) → ~/.coral/skills/
                                               # ② ~/.coral/skills/ → ~/.claude/skills/
sps skill sync --force                         # ⭐ 覆盖已存在的 user skill（升级 sps-cli 后用）
```

Bundled skill 列表（v0.51.3）：

- **开发类（23 个）**：`frontend`、`frontend-developer`、`backend`、`backend-architect`、`typescript`、`golang`、`rust`、`python`、`java`、`kotlin`、`swift`、`mobile`、`database`、`database-optimizer`、`qa-tester`、`security-engineer`、`architecture-decision-records`、`coding-standards`、`debugging-workflow`、`devops`、`devops-automator`、`git-workflow`、`code-reviewer`
- **Worker profile（3 个）**：`dev-worker`、`tax-worker`、`reviewer`（通过 `--profile` 引用）
- **SPS 专用（5 个）**：`sps-pipeline`、`sps-memory`、`wiki-update`

---

## 命令参考

```bash
# Setup & 项目
sps setup [--force]
sps project init <name>
sps project doctor <name> [--fix] [--json] [--reset-state] [--skip-remote]
sps doctor <name> --fix              # 别名

# Pipeline
sps tick <project> [--json]
sps pipeline start|stop|status|reset|workers|board|card|logs|list|run|use [project] [args]
sps pipeline run <name> "<prompt>"   # 用于 mode: steps pipeline
sps pipeline tick <project>          # 单次 StageEngine pass
sps scheduler tick <project>         # v0.51.9 起 dormant（保留接口给 tick 编排器）
sps qa tick <project>                # QA → Done 收尾
sps monitor tick <project>           # 健康探测（ACK timeout、stale）
sps pm scan <project>                # 从磁盘重建卡片索引

# 卡片
sps card add <p> "title" ["description"] [--skills a,b] [--labels x,y]
sps card dashboard <p>
sps card mark-started <p> [seq] [--stage <name>]
sps card mark-complete <p> <seq> [--stage <name>]

# Worker
sps worker ps <project>
sps worker dashboard <project>
sps worker kill <project> <seq>
sps worker launch <project> <seq>

# 状态 / 日志
sps status [--json]
sps stop <project> [--all]
sps reset <project> [--all] [--card N,N,N]
sps logs [project] [--err] [--lines N] [--no-follow]

# Memory
sps memory list [project] [--agent <id>]
sps memory context <project> [--card <seq>] [--agent <id>]
sps memory add <project> --type <T> --name "title" [--body "content"]

# Wiki（v0.51+）
sps wiki init <p>
sps wiki update <p> [--finalize] [--json]
sps wiki read <p> "<query>" [--skills a,b] [--pinned id1,id2] [--budget N]
sps wiki check <p> [--json] [--fix]
sps wiki add <p> <file> [--category <name>] [--no-ingest]
sps wiki list <p> [--type T] [--tag T] [--json]
sps wiki get <p> <pageId> [--json]
sps wiki status <p> [--json]

# Skill
sps skill list [--project <p>]
sps skill add <name> [--project <p>]
sps skill remove <name> [--project <p>]
sps skill freeze <name> [--project <p>]
sps skill unfreeze <name> [--project <p>]
sps skill sync [--force]

# Console
sps console [--port N] [--host H] [--no-open] [--dev] [--kill]

# Agent
sps agent "<prompt>" [--profile <p>] [--system "..."] [--context file] [--output file] [--verbose]
sps agent --chat [--name <session>]
sps agent status|close|list|add [args]
sps agent daemon start|stop|status

# Hook（由 Claude Code 调用，不是用户）
sps hook stop
sps hook user-prompt-submit

# ACP 控制（高级 debug 用）
sps acp <ensure|run|prompt|status|stop|pending|respond> <project> [args]
```

任何命令后加 `--help` 看具体用法；支持的命令加 `--json` 输出结构化结果。

---

## 项目配置（conf）

文件位置 `~/.coral/projects/<name>/conf`（shell `export VAR="value"` 语法，mode 600）。完整字段参考自动生成在 `~/.coral/projects/<name>/conf.example`。

| 字段 | 默认 | 说明 |
|---|---|---|
| `PROJECT_NAME` | （必填） | 内部 id |
| `PROJECT_DIR` | （必填） | repo 绝对路径 |
| `GITLAB_PROJECT` | — | `user/repo`（可选，用 GitLab API 时必填） |
| `GITLAB_PROJECT_ID` | — | 数字 ID（GitLab 才需，按路径首次 MR 时自动解析） |
| `GITLAB_MERGE_BRANCH` | `main` | Worker push 的目标分支 |
| `PM_TOOL` | `markdown` | **v0.42 起只支持 `markdown`**。卡片在 `~/.coral/projects/<n>/cards/<state>/<seq>.md` |
| `PIPELINE_LABEL` | `AI-PIPELINE` | 卡片进入 pipeline 必备标签 |
| `MR_MODE` | `none` | `none`（直接 push）/ `create`（开 MR，需要 `GITLAB_PROJECT_ID`） |
| `WORKER_TRANSPORT` | `acp-sdk` | 固定，不要改 |
| `MAX_CONCURRENT_WORKERS` | `1` | Slot 数；同一项目内卡仍是串行 |
| `MAX_ACTIONS_PER_TICK` | `3` | 单次 tick 可领多少新任务 |
| `INPROGRESS_TIMEOUT_HOURS` | `2` | 超时后 MonitorEngine 标 STALE-RUNTIME |
| `WORKER_ACK_TIMEOUT_S` | `300` | 派发后等 STARTED-<stage> 标签的最长时间（v0.50.24 提到 5min） |
| `WORKER_ACK_MAX_RETRIES` | `1` | ACK 超时后最多重试次数 |
| `MONITOR_AUTO_QA` | `true` | 检测到 stale runtime 时自动迁到 QA |
| `CONFLICT_DEFAULT` | `serial` | 卡上无 `conflict:` 标签时的兜底策略 |
| `MATRIX_ROOM_ID` | — | 项目级 Matrix 覆盖 |
| `WORKTREE_DIR` | `~/.coral/worktrees/<p>` | Worker 工作树根 |
| `DEFAULT_WORKER_SKILLS` | — | 逗号分隔；卡上无 `profile:` 也无 `card.skills` 时兜底 |
| `ENABLE_MEMORY` | `true` | `false` 跳过 prompt 里的 memory 写指引 |
| **`WIKI_ENABLED`** | 未设（关） | **v0.51+**：`true` 启用 wiki context 注入 + reminder |
| `COMPLETION_SIGNAL` | `done` | Stop hook 监听的完成关键词 |

全局凭证 `~/.coral/env`：`GITLAB_URL`、`GITLAB_TOKEN`、`GITLAB_SSH_HOST`、`GITLAB_SSH_PORT`、`MATRIX_HOMESERVER`、`MATRIX_ACCESS_TOKEN`、`MATRIX_ROOM_ID`。`sps setup` 写或 `vim` 改。

---

## 目录布局

```
~/.coral/                              # 用户全局状态
├── env                                # 全局凭证（mode 600）
├── skills/                            # User-level skill（从 npm 同步）
├── memory/{user,agents,projects}/     # 3 层 memory 存储
├── projects/<name>/                   # 项目状态
│   ├── conf                           # 项目配置（mode 600）
│   ├── conf.example                   # 字段全参考（自动生成）
│   ├── pipelines/{project,*}.yaml     # Pipeline 定义
│   ├── pipeline_order.json            # 当前 active pipeline 指针
│   ├── runtime/state.json             # Worker slot + 当前卡状态
│   ├── runtime/worker-<slot>-current.json   # Per-slot 卡 marker（v0.50.21+）
│   ├── runtime/tick.lock              # tick 锁
│   ├── runtime/acp-state.json         # ACP 会话状态
│   ├── cards/<state>/<seq>.md         # 卡片文件（markdown PM 后端）
│   ├── cards/seq.txt                  # 序列号
│   ├── logs/                          # 每次 tick 的日志
│   └── pm_meta/                       # 卡片索引
├── sessions/                          # Agent daemon（chat 会话）
│   ├── daemon.sock daemon.pid
│   └── chat-sessions/<id>.json        # 持久化 chat 会话
├── console.lock                       # console 单实例 guard
└── worktrees/<project>/<seq>/         # 每张活动卡一个 worktree

<目标 repo>/                           # 你的项目 repo
├── .claude/
│   ├── CLAUDE.md                      # Worker 规则（项目相关 + SPS 注入）
│   ├── settings.local.json            # Claude Code 本地配置
│   ├── skills/                        # 从 ~/.coral/skills/ symlink
│   └── hooks/{start,stop}.sh          # 生命周期 hook（call sps）
├── wiki/                              # 若 WIKI_ENABLED — 项目知识库
└── ATTRIBUTION.md                     # 若 WIKI_ENABLED
```

---

## 架构

4 层服务架构（v0.50+）：

```
Delivery (commands/, console/routes/)        参数解析 + I/O 编排（薄）
  ↓
Service (services/)                          ProjectService / ChatService / PipelineService /
                                             SkillService / WikiService — Result<T> + DomainEvent
  ↓
Domain (engines/)                            SchedulerEngine / StageEngine / MonitorEngine /
                                             CloseoutEngine / EventHandler — pipeline 逻辑
  ↓
Infrastructure                               WorkerManager（单 worker）、ACPWorkerRuntime、
  (manager/, providers/, daemon/)            sessionDaemon、TaskBackend、RepoBackend
```

引擎职责：

- **SchedulerEngine** — v0.51.9 起 dormant（卡 add 直接进 Backlog；Planning 是人工暂存）。class 保留为 no-op，给 tick 编排器接口稳定。
- **StageEngine** — 驱动卡走 stage；构造 prompt（skill + projectRules + memory + **wikiContext** + task description + **wikiUpdateReminder**）；通过 ACP 拉起 worker。
- **MonitorEngine** — ACK 超时检测、stale runtime、自动 QA 提升。
- **CloseoutEngine** + **EventHandler** — 完成卡的收尾。

**单 worker 是刻意设计**：v0.37.2 已删除多 worker 并发代码。不要提议"加并行模式" — 架构依赖串行执行保证状态一致。要更高吞吐，跑多个项目并行。

源码内每个 engine / service 文件顶部都有详细架构注释（如 `src/engines/StageEngine.ts`、`src/services/`）。

---

## Troubleshooting

```bash
sps doctor <project> --fix           # ★ 第一招
sps logs <project> --err             # 只看 stderr / 错误
sps reset <project> --card <seq>     # 重置卡死的卡
sps reset <project> --all            # 全项目重置

# Worker / daemon 问题
sps worker ps <project>
sps agent daemon status              # chat daemon 还在不？
sps agent daemon stop && sps agent daemon start    # 重启（清旧 cwd）

# Wiki 问题
sps wiki check <project>
sps wiki status <project>
```

常见问题：

| 现象 | 原因 / 修复 |
|---|---|
| Pipeline halt 在 `NEEDS-FIX` | 打开失败的卡，修问题，移除标签。Console 上 2 步搞定。 |
| Worker 启动不了 | 先 `sps worker ps`，再 `sps logs --err`。多半是 Claude API key 缺、或 `claude-agent-acp` adapter 没装（`sps setup` 重装它）。 |
| 卡片卡在 Planning | 缺 `AI-PIPELINE` 标签。`sps card add` 自动加；外部加的需手动补。 |
| 每张卡都 ACK timeout | Claude 冷启动慢（skill / memory 多）。conf 里调高 `WORKER_ACK_TIMEOUT_S`（v0.50.24 起默认 300s）。 |
| Console 数据陈旧 | SSE 可能掉了；刷新页面；不行就 `sps console --kill && sps console`。 |
| Wiki context 不注入 | 检查 `WIKI_ENABLED=true` 在 conf 里、`wiki/WIKI.md` 存在。conf 开了但 scaffold 缺时 StageEngine 会 warn。 |
| 升级后 skill SOP 不更新 | `sps skill sync --force`（默认 sync 会跳过已存在的）。 |
| Daemon chat 用了错的 cwd | Daemon 启动时锁 cwd。`sps agent daemon stop && cd <repo> && sps agent daemon start`。 |

---

## 许可证 & 致谢

MIT，见 [`LICENSE`](./LICENSE)。

Wiki 系统（v0.51+）~70% 借鉴 [claude-obsidian](https://github.com/kepano/claude-obsidian)（MIT）— 三层架构、manifest 增量、hot cache、ingest 流程、contradiction callout、wikilink。SPS 专属 30%：5 类 page、`sources={card,commit,path}`、5 层 reader、`sps wiki check` exit gate。心智模型来自 Karpathy "LLM Wiki" gist。

完整归属见 [`ATTRIBUTION.md`](./ATTRIBUTION.md)。
