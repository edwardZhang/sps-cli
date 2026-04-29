# SPS CLI

[![npm](https://img.shields.io/npm/v/@coralai/sps-cli)](https://www.npmjs.com/package/@coralai/sps-cli) [![license](https://img.shields.io/npm/l/@coralai/sps-cli)](./LICENSE)

> 中文文档：[README-CN.md](./README-CN.md)

## 1. Introduction

SPS (Smart Pipeline System) is an open-source **AI-agent harness** that turns a single-line task into reviewed, committed, deployable code. It drives an underlying coding agent through a card-based pipeline — plan, code, test, QA, merge — with a per-project knowledge base auto-injected into every prompt.

One CLI, one console, one filesystem-driven workflow. No vendor lock-in.

![CLI](docs/screenshots/01-cli-banner.png)

## 2. Core Concepts

### Harness
A long-running shell around the AI agent: daemon, supervisor, transport, profile management, file-system task lifecycle. The agent focuses on writing code; the harness owns the infrastructure.

### Pipeline
Each task is a **card** that flows through stages: `Backlog → Planning → Todo → Inprogress → QA → Done`. Every stage has its own prompt, allowed tools, exit gates — all configurable in YAML.

### Skills
Stages dispatch atomic **skills** to drive each task — `sps-pipeline`, `wiki-update`, `git-commit`, persona skills, and 24 dev skills bundled. Skills compose without ballooning the system prompt; the harness loads only what the current stage needs.

### Knowledge Base — LLM Wiki

Inspired by Andrej Karpathy's "LLM Wiki": instead of re-reading source code from scratch every session, the agent **distills** project knowledge into a persistent, structured wiki that primes every future prompt.

**The problem**: An AI agent re-discovering your codebase on every task burns tokens, misses non-obvious decisions, and walks into the same gotcha twice. Most of the knowledge in a codebase is implicit — in commit context, in design tradeoffs, in incident postmortems that never made it back into the source.

**The wiki**: Workers continuously distill code, design docs, and completed cards into atomic, cross-linked pages:

| Page type | What it captures |
|---|---|
| `modules/` | What each component does and how it's used |
| `concepts/` | Recurring patterns and architectural primitives |
| `decisions/` | Why a specific choice was made (with version anchor) |
| `lessons/` | Non-obvious gotchas surfaced from incidents |
| `sources/` | Distilled summaries of external materials added to `.raw/` (PDFs, articles, transcripts) |

**Self-maintaining**: After each card, the worker auto-writes back any new lessons or module changes — no manual curation. SOP lives in `skills/wiki-update/` and follows a 4-question filter (module changed? decision made? lesson learned? new pattern?). Four NOs = no write.

**Self-retrieving**: Every card prompt receives 5-layer auto-injection (~2K tokens) so the worker starts informed:

- **L1** `hot.md` — recent context (~500 tokens)
- **L2** `index.md` excerpt — top-30 page TL;DRs (~500 tokens)
- **L3** pinned pages — explicitly referenced in card frontmatter
- **L4** skill-tag matches — pages tagged with the card's active skills
- **L5** BM25F keyword fallback — top-3 by title/desc

**Compounds over time**: Each completed card adds to the corpus. The longer a project runs, the better workers understand it without reading raw source. Old workers' lessons prime new workers — the wiki *is* the project's institutional memory.

**Obsidian-compatible**: Stored at `<repo>/wiki/` with `[[wikilink]]` syntax and flat YAML frontmatter. Open the directory as an Obsidian vault for graph view, backlinks, and full-text search out of the box.

### Agent Mode
Pluggable agent backends behind a single `AgentRuntime` port. Claude Code today; more agents added incrementally — see [Supported Agents](#6-supported-agents).

## 3. Console

`sps console` opens a local web UI at `http://127.0.0.1:4311` — kanban, chat, skills, workers, logs, projects in one place.

**Kanban — card-driven workflow at a glance**

![Console — Kanban](docs/screenshots/02-kanban.png)

**Chat — multi-turn agent conversations with tool-call streaming**

![Console — Chat](docs/screenshots/03-chat.png)

**Skills — bundled & per-project skill management**

![Console — Skills](docs/screenshots/04-skills.png)

**Workers — capacity, runtime, stage-by-stage logs**

![Console — Workers](docs/screenshots/05-workers.png)

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

**TUI dashboard** — compact multi-project view (`sps status`):

![Card Dashboard](docs/screenshots/06-dashboard.png)

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

- **Andrej Karpathy** — ["LLM Wiki"](https://gist.github.com/karpathy) mental model — the foundation for SPS's knowledge layer
- **Anthropic Claude Agent SDK** — ACP transport, sub-agent infrastructure
- **kepano / claude-obsidian** (MIT) — Wiki architecture, manifest, hot cache. Full attribution in [ATTRIBUTION.md](./ATTRIBUTION.md)
- **hono · chokidar · zod · yaml · vitest · biome** — runtime & toolchain

## 8. License

[MIT](./LICENSE)

## 9. Copyright

Copyright (c) 2026 Coral AI
