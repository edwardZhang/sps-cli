# SPS CLI

[![npm](https://img.shields.io/npm/v/@coralai/sps-cli)](https://www.npmjs.com/package/@coralai/sps-cli) [![license](https://img.shields.io/npm/l/@coralai/sps-cli)](./LICENSE)

> English docs: [README.md](./README.md)

## 1. 简介

SPS（Smart Pipeline System）是一个开源的 **AI Agent Harness**（智能体执行壳），把"一句话需求"自动驱动到"已审、已提交、可部署的代码"。任务以卡片形式经过多阶段流水线 —— 计划、编码、测试、QA、合并 —— 每个 prompt 都自动注入项目级知识库。

一个 CLI、一套控制台、一个基于文件系统的工作流。不绑死任何 AI 厂商。

## 2. 核心概念

### Harness（执行壳）
围绕 AI Agent 的长生命进程外壳：daemon、supervisor、传输层、profile 管理、文件系统任务生命周期。Agent 只关心写代码，基础设施由 Harness 接管。

### Pipeline（流水线）
每个任务是一张**卡片**，流经 `Backlog → Planning → Todo → Inprogress → QA → Done` 各阶段。每阶段有独立 prompt、工具白名单、出场条件 —— 全部 YAML 可配。

### Skills（技能指派）
阶段按需分派**原子 skill** 来驱动每个任务执行 —— 内建 `sps-pipeline`、`wiki-update`、`git-commit`，加 24 个开发 skill 与 persona skill。Skill 可组合而不会撑爆 system prompt，Harness 只加载当前阶段需要的部分。

### Knowledge Base（知识库）
项目级 opt-in **Wiki**：跨页 wikilink 互引的原子页（modules / concepts / decisions / lessons / sources）。5 层检索（hot cache + index + pinned + skill-tag + BM25）在每张卡 prompt 启动时自动注入最相关上下文。Worker 完卡后回写 lessons。

### Agent Mode（代理模式）
统一 `AgentRuntime` 端口背后挂可插拔的代理后端。当前是 Claude Code，更多代理逐步补充 —— 见 [支持列表](#6-支持列表)。

## 3. 控制台

`sps console` 在 `http://127.0.0.1:4311` 起本地 Web UI —— 看板、日志、Worker、项目、Chat 全在一处。

<!-- TODO: 截图 — overview -->
![控制台 — 总览](docs/screenshots/01-overview.png)

<!-- TODO: 截图 — kanban -->
![控制台 — 看板](docs/screenshots/02-kanban.png)

<!-- TODO: 截图 — chat -->
![控制台 — Chat](docs/screenshots/03-chat.png)

<!-- TODO: 截图 — workers -->
![控制台 — Worker](docs/screenshots/04-workers.png)

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

- **Anthropic Claude Agent SDK** —— ACP 传输层、子代理基础设施
- **kepano / claude-obsidian**（MIT）—— Wiki 架构、manifest、hot cache。完整归属见 [ATTRIBUTION.md](./ATTRIBUTION.md)
- **Andrej Karpathy** —— "LLM Wiki" 心智模型
- **hono · chokidar · zod · yaml · vitest · biome** —— 运行时与工具链

## 8. 开源协议

[MIT](./LICENSE)

## 9. Copyright

Copyright (c) 2026 Coral AI
