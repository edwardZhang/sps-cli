# SPS CLI

[![npm](https://img.shields.io/npm/v/@coralai/sps-cli)](https://www.npmjs.com/package/@coralai/sps-cli) [![license](https://img.shields.io/npm/l/@coralai/sps-cli)](./LICENSE)

> 中文文档：[README-CN.md](./README-CN.md)

## 1. Introduction

SPS (Smart Pipeline System) is an open-source **AI-agent harness** that turns a single-line task into reviewed, committed, deployable code. It drives an underlying coding agent through a card-based pipeline — plan, code, test, QA, merge — with a per-project knowledge base auto-injected into every prompt.

One CLI, one console, one filesystem-driven workflow. No vendor lock-in.

## 2. Core Concepts

### Harness
A long-running shell around the AI agent: daemon, supervisor, transport, profile management, file-system task lifecycle. The agent focuses on writing code; the harness owns the infrastructure.

### Pipeline
Each task is a **card** that flows through stages: `Backlog → Planning → Todo → Inprogress → QA → Done`. Every stage has its own prompt, allowed tools, exit gates — all configurable in YAML.

### Skills
Stages dispatch atomic **skills** to drive each task — `sps-pipeline`, `wiki-update`, `git-commit`, persona skills, and 24 dev skills bundled. Skills compose without ballooning the system prompt; the harness loads only what the current stage needs.

### Knowledge Base
Per-project, opt-in **Wiki** of cross-linked atomic pages (modules / concepts / decisions / lessons / sources). 5-layer retrieval (hot cache + index + pinned + skill-tag + BM25) auto-injects the most relevant context into every card prompt. Workers write lessons back after each completed card.

### Agent Mode
Pluggable agent backends behind a single `AgentRuntime` port. Claude Code today; more agents added incrementally — see [Supported Agents](#6-supported-agents).

## 3. Console

`sps console` opens a local web UI at `http://127.0.0.1:4311` — kanban, logs, workers, projects, and chat in one place.

<!-- TODO: screenshot — overview -->
![Console — Overview](docs/screenshots/01-overview.png)

<!-- TODO: screenshot — kanban -->
![Console — Kanban](docs/screenshots/02-kanban.png)

<!-- TODO: screenshot — chat -->
![Console — Chat](docs/screenshots/03-chat.png)

<!-- TODO: screenshot — workers -->
![Console — Workers](docs/screenshots/04-workers.png)

## 4. Install

```bash
# Install
npm install -g @coralai/sps-cli
sps setup                       # one-time interactive wizard

# Update
npm update -g @coralai/sps-cli
sps skill sync --force          # pull updated skill SOPs after upgrade
```

### Build from source

```bash
git clone https://github.com/edwardZhang/sps-cli.git
cd sps-cli
npm install
npm run build                   # tsc + console assets
npm link                        # symlink `sps` to local build
```

**Prerequisites**: Node ≥ 18 · `claude` CLI in PATH · Anthropic API key (or Claude Pro / Max).

## 5. Quick Start

```bash
# Harness — direct chat with the agent
sps agent "Explain this repo"
sps agent --chat                # multi-turn REPL

# Console — full local UI
sps console

# Pipeline — card-driven automation
sps project init my-app --repo /path/to/repo
sps card add my-app "Add a login button"
sps tick my-app                 # one tick advances active cards one stage
```

## 6. Supported Agents

| Agent | Status | Notes |
|---|---|---|
| **Claude Code** | ✅ Supported | Default backend via `@agentclientprotocol/sdk` |
| **Codex** | 🚧 Planned | OpenAI Codex CLI |
| **OpenClaw** | 🚧 Planned | Open-source agent backend |
| **Harness Agent** | 🚧 Planned | Custom in-process agent |

Add a new backend by implementing the `AgentRuntime` port — see `src/interfaces/AgentRuntime.ts`.

## 7. Acknowledgements

SPS stands on the shoulders of:

- **Anthropic Claude Agent SDK** — ACP transport, sub-agent infrastructure
- **kepano / claude-obsidian** (MIT) — Wiki architecture, manifest, hot cache. Full attribution in [ATTRIBUTION.md](./ATTRIBUTION.md)
- **Andrej Karpathy** — "LLM Wiki" mental model
- **hono · chokidar · zod · yaml · vitest · biome** — runtime & toolchain

## 8. License

[MIT](./LICENSE)

## 9. Copyright

Copyright (c) 2026 Coral AI
