# SPS CLI

[![npm](https://img.shields.io/npm/v/@coralai/sps-cli)](https://www.npmjs.com/package/@coralai/sps-cli) [![license](https://img.shields.io/npm/l/@coralai/sps-cli)](./LICENSE)

> English docs: [README.md](./README.md)

## 1. 简介

SPS（Smart Pipeline System）是一个开源的 **AI Agent Harness**（智能体执行壳），把"一句话需求"自动驱动到"已审、已提交、可部署的代码"。任务以卡片形式经过多阶段流水线 —— 计划、编码、测试、QA、合并 —— 每个 prompt 都自动注入项目级知识库。

一个 CLI、一套控制台、一个基于文件系统的工作流。不绑死任何 AI 厂商。

![CLI](docs/screenshots/01-cli-banner.png)

## 2. 核心概念

### Harness（执行壳）
围绕 AI Agent 的长生命进程外壳：daemon、supervisor、传输层、profile 管理、文件系统任务生命周期。Agent 只关心写代码，基础设施由 Harness 接管。

### Pipeline（流水线）
每个任务是一张**卡片**，流经 `Backlog → Planning → Todo → Inprogress → QA → Done` 各阶段。每阶段有独立 prompt、工具白名单、出场条件 —— 全部 YAML 可配。

### Skills（技能指派）
阶段按需分派**原子 skill** 来驱动每个任务执行 —— 内建 `sps-pipeline`、`wiki-update`、`git-commit`，加 24 个开发 skill 与 persona skill。Skill 可组合而不会撑爆 system prompt，Harness 只加载当前阶段需要的部分。

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

### Agent Mode（代理模式）
统一 `AgentRuntime` 端口背后挂可插拔的代理后端。当前是 Claude Code，更多代理逐步补充 —— 见 [支持列表](#6-支持列表)。

## 3. 控制台

`sps console` 在 `http://127.0.0.1:4311` 起本地 Web UI —— 看板、Chat、Skills、Workers、日志、项目全在一处。

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

**前置**：Node ≥ 18 · `claude` CLI 在 PATH · Anthropic API key（或 Claude Pro / Max）。

## 5. 快速运行

```bash
# Harness — 直接与 agent 对话
sps agent "解释这个仓库"
sps agent --chat                # 多轮交互

# Console — 完整 UI
sps console

# Pipeline — 卡片驱动自动化
sps project init my-app --repo /path/to/repo
sps card add my-app "加一个登录按钮"
sps tick my-app                 # 推进活跃卡片一个阶段
```

**TUI Dashboard** —— 跨项目紧凑视图（`sps status`）：

![Card Dashboard](docs/screenshots/06-dashboard.png)

## 6. 支持列表

| Agent | 状态 | 说明 |
|---|---|---|
| **Claude Code** | ✅ 已支持 | 默认后端，走 `@agentclientprotocol/sdk` |
| **Codex** | 🚧 规划中 | OpenAI Codex CLI |
| **OpenClaw** | 🚧 规划中 | 开源代理后端 |
| **Harness Agent** | 🚧 规划中 | 自研内进程代理 |

实现 `src/interfaces/AgentRuntime.ts` 的端口即可接入新后端。

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
