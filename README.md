# SPS CLI — AI 驱动的全自动开发流水线

[![npm](https://img.shields.io/npm/v/@coralai/sps-cli)](https://www.npmjs.com/package/@coralai/sps-cli)

SPS（Smart Pipeline System）是一套 AI Agent 驱动的全自动开发流水线 CLI 工具。从任务卡片创建到代码合并，全程无人值守。

```
创建卡片 → 启动 pipeline → AI 自动编码 → 自动合并到目标分支 → 通知完成
```

## 目录

- [安装](#安装)
- [前置条件](#前置条件)
- [快速开始](#快速开始)
- [状态机](#状态机)
- [命令参考](#命令参考)
  - [sps setup](#sps-setup)
  - [sps project init](#sps-project-init)
  - [sps doctor](#sps-doctor)
  - [sps card add](#sps-card-add)
  - [sps tick](#sps-tick)
  - [sps scheduler tick](#sps-scheduler-tick)
  - [sps pipeline tick](#sps-pipeline-tick)
  - [sps worker](#sps-worker)
  - [sps pm](#sps-pm)
  - [sps qa tick](#sps-qa-tick)
  - [sps monitor tick](#sps-monitor-tick)
- [Worker 规则文件](#worker-规则文件)
- [项目配置](#项目配置)
- [多项目并行](#多项目并行)
- [架构概览](#架构概览)
- [目录结构](#目录结构)

---

## 安装

```bash
npm install -g @coralai/sps-cli
```

本地开发：

```bash
cd coding-work-flow/workflow-cli
npm run build
# 或使用 tsx 直接运行
npx tsx src/main.ts --help
```

## 前置条件

| 依赖 | 最低版本 | 说明 |
|------|---------|------|
| Node.js | 18+ | CLI 运行环境 |
| git | 2.x | 分支与 worktree 管理 |
| Claude Code CLI 或 Codex CLI | 最新 | AI Worker |
| tmux | 3.x | 仅 `WORKER_MODE=interactive` 时需要 |

## 快速开始

```bash
# 1. 全局环境初始化（首次使用，配置 GitLab/PM/通知凭据）
sps setup

# 2. 克隆业务仓库（前置条件）
git clone git@gitlab.example.com:team/my-project.git ~/projects/my-project

# 3. 初始化 SPS 项目管理目录
sps project init my-project

# 4. 编辑项目配置
vim ~/.projects/my-project/conf

# 5. 健康检查 + 自动修复（生成 CLAUDE.md、AGENTS.md、初始化 state.json 等）
sps doctor my-project --fix

# 6.（可选）编辑 Worker 规则，加入项目特有的编码规范
vim ~/projects/my-project/CLAUDE.md

# 7. 创建任务卡片
sps card add my-project "实现用户登录" "JWT 登录接口"
sps card add my-project "实现订单系统" "CRUD API + 分页"

# 8. 启动 pipeline（全自动，所有卡片完成后自动退出）
sps tick my-project

# 9.（可选）实时监控 Worker 运行状态
sps worker dashboard
```

---

## 状态机

每张任务卡片按以下状态机流转，全程由 SPS 自动驱动：

### MR_MODE=none（默认，推荐）

Worker 完成编码后直接合并到目标分支，跳过 MR/CI/QA 环节：

```
Planning → Backlog → Todo → Inprogress → Done
```

| 阶段 | 触发引擎 | 操作 |
|------|---------|------|
| Planning → Backlog | SchedulerEngine | 选卡入队，检查准入条件 |
| Backlog → Todo | ExecutionEngine | 创建分支、创建 worktree、生成 `.jarvis/merge.sh` |
| Todo → Inprogress | ExecutionEngine | 分配 Worker slot、构建任务上下文、启动 AI Worker |
| Inprogress → Done | ExecutionEngine | 检测 Worker 完成（代码已合并到目标分支）、释放资源、清理 worktree |

Worker 执行的最后一步是运行 `bash .jarvis/merge.sh`，该脚本自动将 feature branch rebase 并合并到目标分支。

### MR_MODE=create（可选）

Worker 完成编码后创建 MR，任务即完成。MR 审核由后续流程处理（待开发）：

```
Planning → Backlog → Todo → Inprogress → Done（MR 已创建）
```

| 阶段 | 触发引擎 | 操作 |
|------|---------|------|
| Inprogress → Done | ExecutionEngine | 检测 Worker 完成（MR 已创建）、释放资源、清理 worktree |

### 辅助状态标签

卡片可能被标记以下标签，表示需要特殊处理：

| 标签 | 含义 | 处理方式 |
|------|------|---------|
| `BLOCKED` | 被外部依赖阻塞 | 跳过，等待人工处理 |
| `NEEDS-FIX` | Worker 失败或 CI 失败 | 自动修复或人工介入 |
| `WAITING-CONFIRMATION` | Worker 等待破坏性操作确认 | 通知人工确认 |
| `CONFLICT` | 合并冲突 | Worker 自动解冲突或人工处理 |
| `STALE-RUNTIME` | Worker 运行时异常 | MonitorEngine 清理 |

---

## 命令参考

### 全局选项

所有命令均支持：

| 选项 | 说明 |
|------|------|
| `--json` | 输出结构化 JSON（供脚本/cron 消费） |
| `--dry-run` | 预览操作，不实际执行 |
| `--help` | 显示帮助 |
| `--version` | 显示版本号 |

### 退出码

| 退出码 | 含义 |
|-------|------|
| `0` | 成功 |
| `1` | 业务失败 / 校验失败 |
| `2` | 参数错误 |
| `3` | 外部依赖不可用（GitLab / PM / Worker） |

---

### sps setup

全局环境初始化向导，配置各外部系统凭据。

```bash
sps setup [--force]
```

**交互式配置项：**

- GitLab：`GITLAB_URL`、`GITLAB_TOKEN`、`GITLAB_SSH_HOST`、`GITLAB_SSH_PORT`
- Plane：`PLANE_URL`、`PLANE_API_KEY`、`PLANE_WORKSPACE_SLUG`
- Trello：`TRELLO_API_KEY`、`TRELLO_TOKEN`
- Matrix：`MATRIX_HOMESERVER`、`MATRIX_TOKEN`、`MATRIX_ROOM_ID`

凭据写入 `~/.jarvis.env`（权限 0600），所有项目共享。

| 选项 | 说明 |
|------|------|
| `--force` | 覆盖已有的 `~/.jarvis.env` |

---

### sps project init

初始化 SPS 项目管理目录。

```bash
sps project init <project> [--force]
```

**创建的目录结构：**

```
~/.projects/<project>/
├── conf                    # 项目配置文件（从模板生成）
├── logs/                   # 日志目录
├── pm_meta/                # PM 元数据缓存
├── runtime/                # 运行时状态
├── pipeline_order.json     # 卡片执行顺序
├── batch_scheduler.sh      # cron 兼容入口脚本
└── deploy.sh               # 部署脚本模板
```

| 选项 | 说明 |
|------|------|
| `--force` | 覆盖模板文件（conf 不会被覆盖） |

**示例：**

```bash
sps project init accounting-agent
# → 生成 ~/.projects/accounting-agent/
# → 下一步：编辑 conf 填入配置值
```

---

### sps doctor

项目健康检查与自动修复。

```bash
sps doctor <project> [--fix] [--json] [--skip-remote]
```

等价于 `sps project doctor <project>`。

**检查项：**

| 检查项 | 说明 |
|-------|------|
| conf-load | 配置文件是否可加载 |
| conf-fields | 必填字段是否完整 |
| instance-dir | 管理目录是否存在 |
| repo-dir | 业务仓库是否存在且为 git 仓库 |
| worker-rules | CLAUDE.md / AGENTS.md 是否存在于仓库根目录 |
| state-json | 运行时状态文件是否有效 |
| pipeline-order | 执行顺序文件是否存在 |
| conf-cli-fields | CLI 所需的 Provider 字段映射是否完整 |
| gitlab | GitLab API 连通性 |
| plane | Plane API 连通性（仅 PM_TOOL=plane） |
| worker-tool | Claude Code / Codex CLI 是否在 PATH 中 |
| tmux | tmux 是否可用（仅 `WORKER_MODE=interactive` 时必需） |

| 选项 | 说明 |
|------|------|
| `--fix` | 自动修复可修复的问题（创建目录、生成文件、初始化状态） |
| `--json` | 输出 JSON 格式的检查结果 |
| `--skip-remote` | 跳过远程连通性检查（GitLab/Plane） |

**示例：**

```bash
# 检查 + 自动修复
sps doctor my-project --fix
#   ✓ conf-load         Loaded ~/.projects/my-project/conf
#   ✓ conf-fields       All required fields present
#   ✓ repo-dir          /home/user/projects/my-project
#   ✓ worker-rules      Generated and committed: CLAUDE.md, AGENTS.md, .gitignore
#   ✓ state-json        Initialized with 3 worker slots
#   ✓ tmux              tmux available

# JSON 输出
sps doctor my-project --json
```

---

### sps card add

创建任务卡片。

```bash
sps card add <project> "<title>" ["description"]
```

卡片创建在 Planning 状态，自动添加 `AI-PIPELINE` 标签，并追加到 `pipeline_order.json` 中。

| 选项 | 说明 |
|------|------|
| `--json` | 输出 JSON 格式的创建结果 |

**示例：**

```bash
# 创建卡片
sps card add my-project "实现用户登录" "使用 JWT 的认证接口"

# 批量创建
sps card add my-project "实现订单列表" "CRUD API + 分页查询"
sps card add my-project "添加邮件通知" "订单状态变更时发送邮件"
```

---

### sps tick

统一主循环——编排全部引擎，依次执行 scheduler → qa → pipeline → monitor。

```bash
sps tick <project> [project2] [project3] ... [--once] [--json] [--dry-run]
```

**执行顺序（每轮 tick）：**

1. **scheduler tick** — Planning → Backlog（选卡入队）
2. **qa tick** — QA → merge → Done（优先释放 Worker slot）
3. **pipeline tick** — Backlog → Todo → Inprogress（准备环境 + 启动 Worker）
4. **monitor tick** — 异常巡检与对齐

**运行模式：**

| 模式 | 行为 |
|------|------|
| 持续模式（默认） | 每 30 秒循环一次，所有卡片完成后自动退出 |
| 单次模式（`--once`） | 执行一轮 tick 后立即退出 |

**并发互斥：**

同一项目同一时刻只允许一个 `tick` 实例运行。通过 `runtime/tick.lock`（PID + 时间戳）实现互斥，超过 `TICK_LOCK_TIMEOUT_MINUTES`（默认 30 分钟）视为死锁可强制接管。

**失败分类：**

| 类型 | 行为 | 示例 |
|------|------|------|
| 致命失败 | 短路整个 tick | conf 损坏、PM 不可用 |
| 降级继续 | 后续步骤有限运行 | scheduler 失败 → pipeline 不启动新卡 |
| 非关键失败 | 记录后继续 | 通知发送失败 |

| 选项 | 说明 |
|------|------|
| `--once` | 单次执行后退出 |
| `--json` | 输出 JSON 格式的聚合结果 |
| `--dry-run` | 预览操作，不实际执行 |

**示例：**

```bash
# 单项目持续运行
sps tick my-project

# 多项目同时管理
sps tick project-a project-b project-c

# 单次执行 + JSON 输出（适合 cron）
sps tick my-project --once --json

# 预览模式
sps tick my-project --once --dry-run
```

**JSON 输出格式：**

```json
{
  "project": "my-project",
  "component": "tick",
  "status": "ok",
  "exitCode": 0,
  "steps": [
    { "step": "scheduler", "status": "ok", "actions": [...] },
    { "step": "qa", "status": "ok", "actions": [...] },
    { "step": "pipeline", "status": "ok", "actions": [...] },
    { "step": "monitor", "status": "ok", "checks": [...] }
  ]
}
```

---

### sps scheduler tick

手动执行编排步骤：Planning → Backlog。

```bash
sps scheduler tick <project> [--json] [--dry-run]
```

- 读取 `pipeline_order.json` 确定卡片优先级
- 检查准入条件（Worker 可用性、冲突域等）
- 将符合条件的卡片从 Planning 推入 Backlog

**示例：**

```bash
sps scheduler tick my-project
sps scheduler tick my-project --dry-run
```

---

### sps pipeline tick

手动执行执行链：Backlog → Todo → Inprogress。

```bash
sps pipeline tick <project> [--json] [--dry-run]
```

**内部步骤：**

1. **检查 Inprogress 卡片** — 检测 Worker 完成状态，MR_MODE=none 直接推入 Done，MR_MODE=create 确认 MR 后推入 Done
2. **处理 Backlog 卡片** — 创建分支 + 创建 worktree + 生成 `.jarvis/merge.sh` → 推入 Todo
3. **处理 Todo 卡片** — 分配 Worker slot + 构建任务上下文 + 启动 Worker → 推入 Inprogress

受 `MAX_ACTIONS_PER_TICK` 限制（默认 1），防止单轮 tick 同时启动过多 Worker。多个 Worker 启动之间有间隔（print 模式 2 秒，interactive 模式 10 秒）。

带有 `BLOCKED`、`NEEDS-FIX`、`CONFLICT`、`WAITING-CONFIRMATION`、`STALE-RUNTIME` 标签的卡片会被跳过。

**示例：**

```bash
sps pipeline tick my-project
sps pipeline tick my-project --json
```

---

### sps worker

Worker 生命周期管理。

#### sps worker launch

手动启动单个 Worker。

```bash
sps worker launch <project> <seq> [--json] [--dry-run]
```

如果卡片在 Backlog 状态，会自动先执行 prepare（创建分支 + worktree），然后启动 Worker。

**启动流程：**

1. 分配空闲 Worker slot
2. 写入 `.jarvis_task_prompt.txt` 到 worktree
3. 启动 Worker 进程
4. 卡片推入 Inprogress

**Worker 执行模式（`WORKER_MODE`）：**

| 模式 | 默认 | 说明 |
|------|------|------|
| `print` | **是** | 一次性执行，进程退出 = 任务完成，不依赖 tmux |
| `interactive` | 否 | 传统 tmux TUI 交互模式（降级方案） |

**Print 模式（推荐）：**

Worker 以子进程方式运行，prompt 通过 stdin 传入，输出写入 JSONL 文件：

```
Claude:  claude -p --output-format stream-json --dangerously-skip-permissions
Codex:   codex exec - --json --dangerously-bypass-approvals-and-sandbox
```

核心优势：
- **不会卡住** — 无 TUI 交互，进程退出即完成
- **不需要确认** — 权限参数跳过所有确认弹窗
- **上下文延续** — 通过 `--resume <sessionId>` 实现跨任务上下文复用（命中 prompt cache，节省 token）
- **不依赖 tmux** — 纯进程管理，适合 CI/CD 环境

**Session Resume 链：**

同一 worktree 上的多次任务（初始实现 → CI 修复 → 冲突解决）共享同一个 session：

```
任务1: claude -p "实现功能"              → session_id_1（存入 state.json）
CI修复: claude -p "修复CI" --resume sid  → 继承任务1的完整上下文
冲突:   claude -p "解冲突" --resume sid  → 继承所有历史上下文
```

**Interactive 模式（降级方案）：**

设置 `WORKER_MODE=interactive` 回退到 tmux 交互模式。此模式下复用策略：

| 场景 | 行为 |
|------|------|
| Session 存在 + Claude 运行中 | 复用：`/clear` + `cd worktree` |
| Session 存在 + Claude 未运行 | 复用 session：`cd` + 启动 Claude |
| 无 session | 创建新 session + 启动 Claude |

**示例：**

```bash
sps worker launch my-project 24
sps worker launch my-project 24 --dry-run
```

#### sps worker dashboard

实时监控所有 Worker 运行状态的仪表盘。

```bash
sps worker dashboard [project1] [project2] ... [--once] [--json]
```

| 选项 | 说明 |
|------|------|
| （无参数） | 自动发现 `~/.projects/` 下所有项目 |
| `--once` | 输出一次快照后退出（不进入实时模式） |
| `--json` | 输出 JSON 格式（所有项目、所有 Worker slot 状态 + 输出预览） |

**实时模式：**

- 默认每 3 秒刷新（可通过 `SPS_DASHBOARD_INTERVAL` 环境变量调整）
- 按 `q` 退出，按 `r` 强制刷新
- 使用 alternate screen buffer（不污染终端 scrollback）
- 自适应网格布局，每个 Worker 一个面板
- Print 模式面板显示：PID、exit code、JSONL 渲染后的可读输出
- Interactive 模式面板显示：tmux pane 实时输出

**示例：**

```bash
# 监控所有项目
sps worker dashboard

# 监控指定项目
sps worker dashboard my-project

# 单次快照
sps worker dashboard --once

# JSON 输出（供脚本消费）
sps worker dashboard --json

# 自定义刷新间隔
SPS_DASHBOARD_INTERVAL=5000 sps worker dashboard
```

---

### sps pm

PM 后端操作。

#### sps pm scan

查看卡片列表。

```bash
sps pm scan <project> [state]
```

不指定 `state` 时列出所有卡片。

**示例：**

```bash
# 查看所有卡片
sps pm scan my-project

# 按状态筛选
sps pm scan my-project Inprogress
sps pm scan my-project Planning
```

#### sps pm move

手动移动卡片状态。

```bash
sps pm move <project> <seq> <state>
```

**示例：**

```bash
sps pm move my-project 24 QA
sps pm move my-project 25 Done
```

#### sps pm comment

给卡片添加评论。

```bash
sps pm comment <project> <seq> "<text>"
```

**示例：**

```bash
sps pm comment my-project 24 "CI 已通过，等待 review"
```

#### sps pm checklist

管理卡片的检查清单。

```bash
# 创建清单
sps pm checklist create <project> <seq> "item1" "item2" "item3"

# 查看清单
sps pm checklist list <project> <seq>

# 勾选/取消勾选
sps pm checklist check <project> <seq> <item-id>
sps pm checklist uncheck <project> <seq> <item-id>
```

**示例：**

```bash
sps pm checklist create my-project 24 "单元测试" "集成测试" "代码审查"
sps pm checklist list my-project 24
sps pm checklist check my-project 24 item-001
```

---

### sps qa tick

QA 闭环与 worktree 清理。

```bash
sps qa tick <project> [--json]
```

**MR_MODE=none 时：** QA 阶段主要负责 worktree 清理。Worker 完成后由 ExecutionEngine 直接推入 Done。

**MR_MODE=create 时：** QA 作为遗留兼容路径，处理到达 QA 状态的卡片（自动创建 MR 或标记 `NEEDS-FIX`）。

**Worktree 自动清理：**

每轮 qa tick 结束后，自动处理 `state.worktreeCleanup` 队列中的待清理项：

1. `git worktree remove --force <path>` — 删除 worktree 目录
2. `git branch -d <branch>` — 删除已合并的本地分支
3. `git worktree prune` — 清理残留引用

清理失败的条目保留在队列中，下轮 tick 自动重试。

**示例：**

```bash
sps qa tick my-project
sps qa tick my-project --json
```

---

### sps monitor tick

手动执行异常检测与健康巡检。

```bash
sps monitor tick <project> [--json]
```

**巡检项：**

| 检查 | 说明 |
|------|------|
| 孤儿 slot 清理 | 进程/tmux session 已死但 slot 仍标记 active |
| 超时检测 | Inprogress 超过 `INPROGRESS_TIMEOUT_HOURS` |
| 等待确认检测 | Worker 等待用户确认（仅 interactive 模式；print 模式无确认） |
| 阻塞检测 | Worker 遇到 error/fatal/stuck 等（仅 interactive 模式） |
| 状态对齐 | PM 状态与 runtime 状态是否一致 |

**示例：**

```bash
sps monitor tick my-project
sps monitor tick my-project --json
```

---

## Worker 规则文件

`sps doctor --fix` 会在业务仓库根目录生成以下文件并自动提交：

| 文件 | 用途 | 提交到 git |
|------|------|-----------|
| `CLAUDE.md` | Claude Code Worker 的项目规则 | 是 |
| `AGENTS.md` | Codex Worker 的项目规则 | 是 |
| `.jarvis_task_prompt.txt` | 每次任务的具体描述（每个 worktree 独立生成） | 否（.gitignore） |
| `.jarvis/merge.sh` | 合并脚本（MR_MODE=none 时做 git merge，MR_MODE=create 时调 GitLab API 创建 MR） | 否（.gitignore） |
| `docs/DECISIONS.md` | 项目知识库——架构决策和技术选择 | 是（Worker 自动维护） |
| `docs/CHANGELOG.md` | 项目知识库——变更记录 | 是（Worker 自动维护） |

### 工作原理

1. `CLAUDE.md` 和 `AGENTS.md` 提交到仓库主分支
2. 创建 git worktree 时自动继承这些文件
3. Worker 启动时读取 CLAUDE.md 了解项目规则（interactive 模式自动发现；print 模式在 cwd 中自动加载）
4. 任务特有信息（seq、分支名、描述）写入 `.jarvis_task_prompt.txt`，通过 stdin 传给 Worker（print 模式）或通过 tmux paste 传入（interactive 模式）
5. `.jarvis/merge.sh` 在每个 worktree 中自动生成，Worker 在 push 后运行此脚本完成合并或 MR 创建

### 项目知识库

每个 Worker 在任务 prompt 中被要求：

- **开始前**：阅读 `docs/DECISIONS.md` 和 `docs/CHANGELOG.md`，了解前序任务的决策和变更
- **完成后**：将自己的架构决策追加到 `docs/DECISIONS.md`，变更摘要追加到 `docs/CHANGELOG.md`

这些文件随代码一起合并到目标分支，下一个 Worker 创建 worktree 时自动继承，实现跨任务的知识传递。

### 自定义项目规则

生成的 CLAUDE.md 包含"Project-Specific Rules"占位区，你可以在此添加：

```markdown
## Project-Specific Rules
- 语言：TypeScript strict mode
- 测试框架：vitest，覆盖率 80%+
- 架构：src/modules/<domain>/ 目录结构
- Linting：eslint + prettier，提交前必须通过
```

SPS 不会覆盖已存在的 CLAUDE.md / AGENTS.md。

---

## 项目配置

配置分两层：

| 文件 | 作用域 | 说明 |
|------|-------|------|
| `~/.jarvis.env` | 全局 | 所有项目共享的凭据（GitLab token、PM API key 等） |
| `~/.projects/<project>/conf` | 项目级 | 项目特有配置（仓库、分支、Worker 参数等） |

项目 conf 可以引用全局变量（如 `${PLANE_URL}`）。

### 配置字段一览

#### 项目基础

| 字段 | 必填 | 默认值 | 说明 |
|------|------|-------|------|
| `PROJECT_NAME` | 是 | — | 项目名称 |
| `PROJECT_DISPLAY` | 否 | PROJECT_NAME | 显示名称 |
| `PROJECT_DIR` | 否 | `~/projects/<project>` | 业务仓库路径 |

#### GitLab

| 字段 | 必填 | 默认值 | 说明 |
|------|------|-------|------|
| `GITLAB_PROJECT` | 是 | — | GitLab 项目路径（如 `group/repo`） |
| `GITLAB_PROJECT_ID` | 是 | — | GitLab 项目数字 ID |
| `GITLAB_MERGE_BRANCH` | 是 | `develop` | MR 目标分支 |
| `GITLAB_RELEASE_BRANCH` | 否 | `main` | 发布分支 |

#### PM 后端

| 字段 | 必填 | 默认值 | 说明 |
|------|------|-------|------|
| `PM_TOOL` | 否 | `trello` | PM 后端类型：`plane` / `trello` / `markdown` |
| `PIPELINE_LABEL` | 否 | `AI-PIPELINE` | Pipeline 卡片标签 |
| `MR_MODE` | 否 | `none` | 合并模式：`none`（直接合并到目标分支） / `create`（创建 MR，审核流程待开发） |

#### Worker

| 字段 | 必填 | 默认值 | 说明 |
|------|------|-------|------|
| `WORKER_TOOL` | 否 | `claude` | Worker 类型：`claude` / `codex` |
| `WORKER_MODE` | 否 | `print` | 执行模式：`print`（一次性进程） / `interactive`（tmux TUI） |
| `MAX_CONCURRENT_WORKERS` | 否 | `3` | 最大并行 Worker 数 |
| `WORKER_RESTART_LIMIT` | 否 | `2` | Worker 死亡后最大重启次数 |
| `AUTOFIX_ATTEMPTS` | 否 | `2` | CI 失败自动修复尝试次数 |
| `WORKER_SESSION_REUSE` | 否 | `true` | 是否复用 tmux session（仅 interactive 模式） |
| `MAX_ACTIONS_PER_TICK` | 否 | `1` | 每轮 tick 最大操作数 |

#### 超时与策略

| 字段 | 必填 | 默认值 | 说明 |
|------|------|-------|------|
| `INPROGRESS_TIMEOUT_HOURS` | 否 | `8` | Inprogress 超时小时数 |
| `MONITOR_AUTO_QA` | 否 | `false` | Monitor 是否自动将完成的卡推入 QA |
| `CONFLICT_DEFAULT` | 否 | `serial` | 冲突域默认策略：`serial` / `parallel` |
| `TICK_LOCK_TIMEOUT_MINUTES` | 否 | `30` | tick 锁超时分钟数 |
| `NEEDS_FIX_MAX_RETRIES` | 否 | `3` | NEEDS-FIX 最大重试次数 |
| `WORKTREE_RETAIN_HOURS` | 否 | `24` | worktree 保留小时数 |

#### 路径与部署

| 字段 | 必填 | 默认值 | 说明 |
|------|------|-------|------|
| `WORKTREE_DIR` | 否 | `~/.coral/worktrees/` | worktree 根目录 |
| `DEPLOY_ENABLED` | 否 | `false` | 是否启用自动部署 |
| `DEPLOY_SCRIPT` | 否 | — | 部署脚本路径 |

### 配置示例

```bash
# ~/.projects/my-project/conf

PROJECT_NAME="my-project"
PROJECT_DISPLAY="My Project"
PROJECT_DIR="/home/user/projects/my-project"

# GitLab
GITLAB_PROJECT="team/my-project"
GITLAB_PROJECT_ID="42"
GITLAB_MERGE_BRANCH="develop"

# PM（使用全局 .jarvis.env 中的变量）
PM_TOOL="plane"
PLANE_API_URL="${PLANE_URL}"
PLANE_PROJECT_ID="project-uuid-here"

# Worker
WORKER_TOOL="claude"
WORKER_MODE="print"              # print（推荐）或 interactive（tmux 降级）
MAX_CONCURRENT_WORKERS=3
MAX_ACTIONS_PER_TICK=1

# 合并模式
MR_MODE="none"                   # none（直接合并）或 create（创建 MR）
```

---

## 多项目并行

SPS 支持单进程同时管理多个项目：

```bash
sps tick project-a project-b project-c
```

每个项目完全隔离：
- 独立的 ProjectContext、Provider 实例、Engine 实例
- 独立的 tick.lock（互不阻塞）
- 独立的 state.json（Worker slot 不混淆）
- 一个项目出错不影响其他项目

多 Worker 并行配置：

```bash
# 在项目 conf 中设置
MAX_CONCURRENT_WORKERS=3
CONFLICT_DEFAULT=parallel
```

---

## 架构概览

### 四层架构

```
Layer 3  Commands + Engines    CLI 命令 + 状态机引擎
Layer 2  Providers             具体后端实现
Layer 1  Interfaces            抽象接口
Layer 0  Core Runtime          配置、路径、状态、锁、日志
```

### 支持的后端

| 类型 | Provider | 接口 |
|------|----------|------|
| PM 后端 | Plane CE / Trello / Markdown | TaskBackend |
| 代码托管 | GitLab | RepoBackend |
| AI Worker (print) | ClaudePrintProvider / CodexExecProvider | WorkerProvider |
| AI Worker (interactive) | ClaudeTmuxProvider / CodexTmuxProvider | WorkerProvider |
| 通知 | Matrix | Notifier |

### 引擎

| 引擎 | 职责 |
|------|------|
| SchedulerEngine | Planning → Backlog（选卡、排序、准入检查） |
| ExecutionEngine | Backlog → Todo → Inprogress → Done（准备环境、启动 Worker、检测完成、释放资源） |
| CloseoutEngine | worktree 清理（MR_MODE=create 时兼容处理 QA 卡片） |
| MonitorEngine | 异常检测（孤儿清理、超时、阻塞、状态对齐、死亡 Worker 完成检测） |

---

## 目录结构

```
workflow-cli/
├── src/
│   ├── main.ts                 # CLI 入口、命令路由
│   ├── commands/               # 命令实现
│   │   ├── setup.ts            #   sps setup
│   │   ├── projectInit.ts      #   sps project init
│   │   ├── doctor.ts           #   sps doctor
│   │   ├── cardAdd.ts          #   sps card add
│   │   ├── tick.ts             #   sps tick
│   │   ├── schedulerTick.ts    #   sps scheduler tick
│   │   ├── pipelineTick.ts     #   sps pipeline tick
│   │   ├── workerLaunch.ts     #   sps worker launch
│   │   ├── workerDashboard.ts  #   sps worker dashboard
│   │   ├── pmCommand.ts        #   sps pm *
│   │   ├── qaTick.ts           #   sps qa tick
│   │   └── monitorTick.ts      #   sps monitor tick
│   ├── core/                   # 核心运行时
│   │   ├── config.ts           #   配置加载（shell conf 解析）
│   │   ├── context.ts          #   ProjectContext
│   │   ├── paths.ts            #   路径解析
│   │   ├── state.ts            #   运行时状态（state.json）
│   │   ├── lock.ts             #   tick 锁
│   │   ├── logger.ts           #   日志 + 结构化事件
│   │   └── queue.ts            #   Pipeline 队列
│   ├── engines/                # 状态机引擎
│   │   ├── SchedulerEngine.ts  #   选卡入队
│   │   ├── ExecutionEngine.ts  #   执行链
│   │   ├── CloseoutEngine.ts   #   QA 闭环
│   │   └── MonitorEngine.ts    #   异常检测
│   ├── interfaces/             # 抽象接口
│   │   ├── TaskBackend.ts      #   PM 后端接口
│   │   ├── WorkerProvider.ts   #   Worker 接口
│   │   ├── RepoBackend.ts      #   代码仓库接口
│   │   ├── Notifier.ts         #   通知接口
│   │   └── HookProvider.ts     #   Hook 接口
│   ├── models/                 # 类型定义
│   │   └── types.ts            #   Card, CommandResult, WorkerStatus 等
│   └── providers/              # 具体实现
│       ├── registry.ts         #   Provider 工厂（按 WORKER_MODE × WORKER_TOOL 路由）
│       ├── PlaneTaskBackend.ts
│       ├── TrelloTaskBackend.ts
│       ├── MarkdownTaskBackend.ts
│       ├── ClaudePrintProvider.ts   # claude -p 一次性执行（默认）
│       ├── CodexExecProvider.ts     # codex exec 一次性执行（默认）
│       ├── ClaudeTmuxProvider.ts    # tmux 交互模式（降级方案）
│       ├── CodexTmuxProvider.ts     # tmux 交互模式（降级方案）
│       ├── outputParser.ts      #   JSONL 输出解析、进程管理工具
│       ├── streamRenderer.ts    #   JSONL → 人类可读文本（Dashboard 用）
│       ├── GitLabRepoBackend.ts
│       └── MatrixNotifier.ts
├── package.json
└── tsconfig.json
```

---

## License

MIT
