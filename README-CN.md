# SPS CLI

[![npm](https://img.shields.io/npm/v/@coralai/sps-cli)](https://www.npmjs.com/package/@coralai/sps-cli) [![license](https://img.shields.io/npm/l/@coralai/sps-cli)](./LICENSE)

> English docs: [README.md](./README.md)

## 1. 简介

SPS（Smart Pipeline System）是一个开源的 **AI Agent Harness**（智能体执行壳），把"一句话需求"自动驱动到"已审、已提交、可部署的产出"。任务以卡片形式经过多阶段流水线 —— 计划、执行、审核、交付 —— 每个 prompt 都自动注入项目级知识库。

### 7×24 小时无人值守开发

把任务丢进 Backlog，Harness 全天候不间断推进 —— 计划、编码、测试、提交、开 MR，只在真的卡住时才升级人工。你睡觉时流水线在 tick；第二天早会看到的是已合并的 commit。SPS 存在的意义是：一个人能在不守在聊天窗口前的情况下，跑出一个研发团队的工作量。

### 不止软件 —— 通过 skill 扩展到任何行业

Pipeline、Skills、知识层是刻意做成通用的。任何能表达成"任务进 → 已审输出出"的流程，换一套 skill bundle 就能跑：

- **会计** —— 发票录入 → 归类 → 账务对账 → 期末结账
- **自媒体** —— 选题调研 → 起草 → 审核 → 发布
- **AI 视频生成** —— 脚本 → 分镜 → 渲染 → 剪辑 → 审核
- **写作** —— 调研 → 提纲 → 初稿 → 修订 → 发布
- **其他工作流** —— 阶段在 YAML 里定义，skill 在 markdown 里写，Harness 运行它们

一个 CLI、一套控制台、一个基于文件系统的工作流。不绑死任何 AI 厂商。

![CLI](docs/screenshots/01-cli-banner.png)

## 2. 核心概念

### Harness（执行壳）
围绕 AI Agent 的长生命进程外壳：daemon、supervisor、传输层、profile 管理、文件系统任务生命周期。Agent 只关心写代码，基础设施由 Harness 接管。

### Pipeline（流水线）
每个任务是一张**卡片**，流经 `Backlog → Planning → Todo → Inprogress → QA → Done` 各阶段。每阶段有独立 prompt、工具白名单、出场条件 —— 全部 YAML 可配。

### Skills（技能指派）
阶段按需分派**原子 skill** 来驱动每个任务执行 —— 内建 `sps-pipeline`、`wiki-update`、`git-commit`，加 24 个开发 skill 与 persona skill。Skill 可组合而不会撑爆 system prompt，Harness 只加载当前阶段需要的部分。

### Memory（记忆系统）
跨会话持久化"非显然、可复用"事实的三层 markdown 文件库。全部在 `~/.coral/memory/`，Pipeline 模式下由 `StageEngine` 自动注入到每个 Worker prompt。

| 层 | 路径 | 作用域 |
|---|---|---|
| **User** | `~/.coral/memory/user/` | 跨项目用户偏好（编码风格、语言、工作习惯） |
| **Agent** | `~/.coral/memory/agents/<id>/` | 单个 Agent 实例观察到的人机交互模式 |
| **Project** | `~/.coral/memory/projects/<name>/` | 项目级约定、架构决策、教训、外部资源指针 |

四种条目类型 —— `convention`（永不衰减）、`decision`（缓慢衰减）、`lesson`（30 天衰减）、`reference`（永不衰减）。每层一个扁平目录装 `*.md` + 一份 `MEMORY.md` 索引。Agent 按需读、有发现时回写 —— 稀疏的私有飘移；与下文密集的团队共享 Wiki 互补。

### Knowledge Base（知识库）—— LLM Wiki

借鉴 Andrej Karpathy 的 "LLM Wiki" 思路：让 Agent 把项目知识**提炼**成持久化的结构化 wiki，而不是每次会话都重新读源码、重新踩坑、重新发现已有抽象。

**问题**：AI Agent 每次从零探索代码库会烧 token、漏掉非显然的决策、反复撞同一个坑。代码里的知识大多是**隐式的** —— 藏在 commit 上下文里、藏在设计权衡里、藏在没有回写到源码的事故复盘里。

**Wiki 方案**：Worker 把代码、设计文档、完成的卡片持续提炼成原子化、互相 wikilink 的页：

| 页类型 | 装什么 |
|---|---|
| `modules/` | 每个模块做什么、怎么被使用 |
| `concepts/` | 反复出现的模式与架构原语 |
| `decisions/` | 某个选择背后的原因（带版本锚定） |
| `lessons/` | 事故中浮现的非显然教训 |
| `sources/` | 用户拖入 `.raw/` 的外部材料（PDF/文章/转录）的密集摘要 |

**自维护**：每张卡完成后，Worker 自动回写新增 lessons / module 变更，无需人工维护。SOP 在 `skills/wiki-update/`，按 4 问题判定（改了模块？做了决策？踩了坑？看到模式？）—— 四个 NO 就不写。

**自检索**：每张新卡的 prompt 自动注入 5 层（~2K token），Worker 启动即带知识：

- **L1** `hot.md` —— 最近上下文（~500 token）
- **L2** `index.md` 节选 —— top-30 页 TL;DR（~500 token）
- **L3** pinned 页 —— 卡片 frontmatter 显式引用
- **L4** skill-tag 匹配 —— 与卡片激活 skill 相符的页
- **L5** BM25F 关键词回退 —— title/desc top-3

**复利效应**：每张完成的卡都在累加知识。项目跑得越久，Worker 越懂这个项目，不再需要重读原代码。老 Worker 留下的 lesson 是新 Worker 的免费先验 —— Wiki 就是项目的**机构记忆**。

**Obsidian 兼容**：存在 `<repo>/wiki/`，用 `[[wikilink]]` 语法 + 扁平 YAML frontmatter —— 把目录用 Obsidian 打开就有 graph view、双向链接、全文搜索。

### Agent Mode（代理接入）
SPS 是**代理无关**的。任何能读 skill + 执行 shell 的编码代理 —— Claude Code、Codex、OpenClaw、你自己写的 —— 都可以通过内置 `sps-pipeline` skill 来驱动 SPS。Harness 适配代理，不是反过来。接入新代理只需扔一个 skill 文件，SPS 代码无需改动。见 [§6](#6-支持列表) 接入矩阵。

## 3. 控制台

启动本地 Web UI：

```bash
sps console                      # 打开 http://127.0.0.1:4311
sps console --port 5000          # 自定义端口
sps console --no-open            # 不自动开浏览器
sps console --kill               # 停掉运行中的 console
```

一条命令，无需额外服务 —— 看板、Chat、Skills、Workers、日志、项目全在一处。

**看板 —— 卡片流转一目了然**

![控制台 — 看板](docs/screenshots/02-kanban.png)

**Chat —— 多轮对话 + 工具调用流式渲染**

![控制台 — Chat](docs/screenshots/03-chat.png)

**Skills —— 内置与项目级 skill 管理**

![控制台 — Skills](docs/screenshots/04-skills.png)

**Workers —— 容量、运行时、按阶段日志**

![控制台 — Workers](docs/screenshots/05-workers.png)

## 4. 安装

```bash
# 安装
npm install -g @coralai/sps-cli
sps setup                       # 一次性交互向导

# 更新
npm update -g @coralai/sps-cli
sps skill sync --force          # 升级后拉最新 skill SOP
```

### 本地编译

```bash
git clone https://github.com/edwardZhang/sps-cli.git
cd sps-cli
npm install
npm run build                   # tsc + console 静态资源
npm link                        # `sps` 命令指向本地编译版
```

### 前置要求

- **Node.js ≥ 18**
- **本地已经能正常运行的 Claude Code。** 先跑一下 `claude --help`，能跑通就 OK。SPS **不限制**你 Claude Code 怎么登录：
  - Anthropic API key（`ANTHROPIC_API_KEY`）
  - Claude Pro / Max 订阅
  - 第三方 API gateway / 代理
  - 任何其他 Claude Code 支持的鉴权方式

  SPS 通过 Agent Client Protocol 启动 `claude`，继承你已配的凭证。SPS 这边不需要再单独配 API key。

## 5. 快速运行

### Step 1 —— 跑一次安装向导（只需一次）

```bash
sps setup
```

向导会做：
- 创建 `~/.coral/{projects,memory,sessions,skills}/` 目录树
- 把内置 skill 复制到 `~/.coral/skills/`，并软链到 `~/.claude/skills/` 让 Claude Code 能看到
- 全局安装 `@agentclientprotocol/claude-agent-acp`，让 `claude` 能走 ACP 被驱动
- 可选写 `~/.coral/env`（GitLab token、Matrix 通知等 —— 全部可选）

可重复运行：`sps setup --force` 把已有值作为默认值。升级 sps-cli 后，跑 **`sps skill sync --force`** 拉最新 skill SOP。

### Step 2 —— 用 agent 冒烟测试（不需要项目）

```bash
sps agent "解释这个仓库"          # 单次问答
sps agent --chat                # 多轮 REPL，会话持久化
```

跑通这一步说明 Claude Code 鉴权 OK，SPS 也接好了。

### Step 3 —— 启动控制台

```bash
sps console                     # http://127.0.0.1:4311
```

### Step 4 —— 跑一条 pipeline

```bash
sps project init my-app --repo /path/to/repo    # 初始化项目
sps card add my-app "加一个登录按钮"               # 加一张卡
sps tick my-app                                 # 推进活跃卡片一个阶段
```

**TUI Dashboard** —— 跨项目紧凑视图（`sps status`）：

![Card Dashboard](docs/screenshots/06-dashboard.png)

## 6. 支持列表

SPS-CLI 是 shell 驱动的，任何能读 skill + 执行命令的编码代理都可以把它当任务 harness 用。我们随仓库发 `skills/sps-pipeline/` —— 把它放进代理的 skill 目录，代理就立即学会了 SPS 完整命令面（cards、pipeline tick、wiki、项目初始化、daemon 生命周期）。

| 代理 | 接入方式 |
|---|---|
| **Claude Code** | ✅ `sps skill sync` 把 `sps-pipeline` 软链到 `~/.claude/skills/`；按描述匹配自动加载 |
| **Codex** | ✅ 把 `skills/sps-pipeline/SKILL.md` 放进 Codex 的 skill 目录 |
| **OpenClaw** | ✅ 一样 —— 让它的 skill loader 指向 `skills/sps-pipeline/` |
| **Harness Agent** | ✅ 同模式 —— skill 内容代理无关 |
| **其他任何编码代理** | ✅ 只要能读指令 + 执行 shell，就能驱动 SPS |

skill 是纯 markdown —— 抄它、改它、fork 它。SPS 管编排，代理管意图。

## 7. 致谢

SPS 站在以下开源项目肩上：

- **Andrej Karpathy** —— ["LLM Wiki"](https://gist.github.com/karpathy) 心智模型，是 SPS 知识层的根基
- **Anthropic Claude Agent SDK** —— ACP 传输层、子代理基础设施
- **kepano / claude-obsidian**（MIT）—— Wiki 架构、manifest、hot cache。完整归属见 [ATTRIBUTION.md](./ATTRIBUTION.md)
- **hono · chokidar · zod · yaml · vitest · biome** —— 运行时与工具链

## 8. 开源协议

[MIT](./LICENSE)

## 9. Copyright

Copyright (c) 2026 Coral AI
