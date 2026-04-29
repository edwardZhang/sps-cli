# SPS CLI — AI Agent Harness & Development Pipeline

[![npm](https://img.shields.io/npm/v/@coralai/sps-cli)](https://www.npmjs.com/package/@coralai/sps-cli) [![license](https://img.shields.io/npm/l/@coralai/sps-cli)](../../LICENSE)

> **中文文档**：[README-CN.md](./README-CN.md)

**v0.51.3**

SPS (Smart Pipeline System) drives a Claude Code worker through task cards — code, commit, push, QA, merge, all automated. Three modes:

| Mode | Command | When |
|---|---|---|
| **Harness** | `sps agent` | Zero-config — one-shot or multi-turn chat with Claude. No project, no PM. |
| **Pipeline** | `sps tick <project>` | Automated card-driven workflow with YAML-configurable stages. |
| **Console** | `sps console` | Web UI — kanban, logs, workers, projects, chat (since v0.44). |

The headline feature in v0.51 is the **Wiki Knowledge Base** — opt-in per project, structured cross-linked pages (modules / concepts / decisions / lessons / sources), 5-layer retrieval auto-injected into worker prompts. See [doc-28](../../docs/design/28-wiki-system.md) and [`ATTRIBUTION.md`](./ATTRIBUTION.md).

---

## Table of contents

- [Install & setup](#install--setup)
- [Harness mode (`sps agent`)](#harness-mode-sps-agent)
- [Console mode (`sps console`)](#console-mode-sps-console)
- [Pipeline mode (`sps tick`)](#pipeline-mode-sps-tick)
- [Card lifecycle](#card-lifecycle)
- [Memory + Wiki](#memory--wiki)
- [Skills](#skills)
- [Command reference](#command-reference)
- [Project config (conf)](#project-config-conf)
- [Project layout](#project-layout)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)

---

## Install & setup

```bash
npm install -g @coralai/sps-cli      # latest 0.51.x
sps setup                            # interactive wizard (must run once)
```

`sps setup`:
1. Creates `~/.coral/` directory tree (`projects/`, `memory/{user,agents}/`).
2. Copies bundled skills → `~/.coral/skills/`.
3. Asks for `GITLAB_URL` / `GITLAB_TOKEN` / `MATRIX_*` (optional) → writes `~/.coral/env`.
4. Symlinks user skills → `~/.claude/skills/`.
5. Installs `@agentclientprotocol/claude-agent-acp` globally.

Re-run safe with `sps setup --force` (keeps existing values as defaults). After upgrading sps-cli later, run **`sps skill sync --force`** to pull updated skill SOPs (default sync is non-destructive — won't overwrite existing skills).

**Prerequisites**: Node ≥ 18; an Anthropic API key (or Claude Pro / Max subscription); `claude` CLI in PATH.

---

## Harness mode (`sps agent`)

Direct one-shot or multi-turn chat with Claude. No project, no PM, no Git.

```bash
# One-shot
sps agent "Explain this repo"
sps agent --output summary.md "Summarize the architecture"

# Multi-turn (daemon-backed, persistent sessions)
sps agent --chat                              # interactive REPL
sps agent --chat --name reviewer              # named session, resume later
sps agent status                              # list active sessions
sps agent close --name reviewer

# Profile + context files
sps agent --profile reviewer "Review this module" --context src/auth.ts --context src/auth.test.ts
sps agent --system "You are a release engineer" "Plan the v0.52 cut"

# Verbose
sps agent --verbose "Why did this build fail?"
```

**`--profile <name>`**: looks up `~/.coral/skills/dev-worker/references/<name>.md`, injects as system prompt. (Different from `sps skill add` — that's for project-level skill linking.)

**Built-in agent**: `claude` only (Codex / Gemini support removed in v0.38). Workers communicate via ACP JSON-RPC over stdio with `claude-agent-acp`.

**Agent skills auto-loaded by Claude Code**: `~/.claude/skills/` is scanned by `claude` itself — including `sps-pipeline`, `sps-memory`, `wiki-update`, and the 24 dev/persona skills. Skill descriptions trigger lazy load; no SPS prompt injection needed for harness mode.

**Daemon cwd caveat**: `sps console` and `sps agent --chat` start a session daemon (`~/.coral/sessions/daemon.sock`) that captures `process.cwd()` at startup and uses it as the default working directory for all chat workers. To switch the chat's working directory, restart the daemon: `sps agent daemon stop && sps agent daemon start` from the desired cwd.

---

## Console mode (`sps console`)

Local web UI bundled into the binary. Single-instance guard via `~/.coral/console.lock`.

```bash
sps console                          # opens http://127.0.0.1:4311
sps console --port 5000
sps console --no-open                # don't auto-open browser
sps console --kill                   # stop running console
sps console --dev                    # vite dev server (development)
```

Pages:

| Path | Purpose |
|---|---|
| `/projects` | List all projects with status |
| `/projects/new` | Create project (form has Wiki toggle, v0.51+) |
| `/projects/<n>` | Pipeline editor + conf editor + delete |
| `/board` | Kanban (per-column scrolling, v0.51.1+) |
| `/workers` | Aggregate worker dashboard across projects |
| `/logs` | Live SSE log viewer |
| `/skills` | User-level skill management |
| `/system` | Global settings + daemon status |
| `/chat` | Agent chat (multi-session, persistent) |

Tech: Hono server on `127.0.0.1:4311`, chokidar watchers pushing SSE to React 19 + Vite + Tailwind v4 + shadcn/ui frontend. Design system: Pastel Neubrutalism, locked in [`console/DESIGN.md`](./console/DESIGN.md).

---

## Pipeline mode (`sps tick`)

Fully automated card-driven workflow. **One worker, one card at a time, serial.** Each card walks one or more YAML-defined stages (e.g. `develop → review → Done`); failure halts pipeline until you remove the `NEEDS-FIX` label.

### Create a project

```bash
sps project init my-app
# or use Console /projects/new — has a Wiki toggle (v0.51+)
```

Asks for: project dir, merge branch, max workers, ACK timeout, optional GitLab remote, optional Matrix room.

Generates:

```
~/.coral/projects/my-app/
├── conf                              # mode 600 — your active config
├── conf.example                      # full reference (read-only docs)
├── pipelines/
│   ├── project.yaml                  # default 1-stage pipeline (develop → Done)
│   └── sample.yaml.example           # heavily-commented YAML reference
└── pipeline_order.json               # active pipeline pointer
```

In the target repo (PROJECT_DIR):

```
.claude/CLAUDE.md                     # worker rules (auto-installed)
.claude/skills/                       # symlinked from ~/.coral/skills/
.claude/settings.local.json           # Claude Code local config
wiki/                                 # if WIKI_ENABLED — see doc-28
ATTRIBUTION.md                        # if WIKI_ENABLED
```

### Run

```bash
sps tick my-app                      # foreground tick loop
sps pipeline start my-app            # alias
sps pipeline stop my-app             # graceful stop (alias: sps stop my-app)
sps stop --all                       # stop all running ticks
sps status                           # all projects
```

### Pipeline YAML

`~/.coral/projects/<n>/pipelines/project.yaml` — single source of truth for stages.

```yaml
mode: project
git: true                            # false = non-code project, no git ops
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

Critical rules:
1. `mode: project` for state-machine pipelines; `mode: steps` for one-shot custom (use `sps pipeline run <name>`).
2. Each stage's `on_complete` must point to the **next** stage's target state.
3. Last stage's `on_complete: "move_card Done"`.
4. Don't write `agent:` field — it's silently ignored (v0.38+ Claude is the only worker).
5. `trigger` and `card_state` are auto-derived per stage.

Field reference: see `~/.coral/projects/<n>/pipelines/sample.yaml.example` (auto-generated, comment-rich) or [doc-17](../../docs/design/17-pipeline-configuration-design.md).

---

## Card lifecycle

```
Backlog → Todo → Inprogress → [QA / Review] → Done
   ↑↓                  ↓ fail
Planning           NEEDS-FIX (halt)
(manual park, v0.51.9+)
```

**v0.51.9 change**: `sps card add` puts cards directly in **Backlog** (used to go through Planning + auto-promote). Planning is now a manual parking lot — drag a card there to defer; drag back to Backlog to dispatch. Cards order strictly by seq.

Default states (configurable via YAML `pm.card_states`).

```bash
sps card add <p> "Title" "Description"
sps card add <p> "T" "D" --skills python,backend --labels feature

sps card dashboard <p>               # CLI table
                                     # console: /board?project=<n>

sps card mark-started <p> <seq>      # called by Claude Code UserPromptSubmit hook
sps card mark-complete <p> <seq>     # called by Claude Code Stop hook

sps reset <p>                        # reset all non-Done cards
sps reset <p> --card 5,6,7
sps reset <p> --all                  # full reset incl. Done + worktrees + branches
```

### Card label vocabulary

| Label | Meaning | Set by |
|---|---|---|
| `AI-PIPELINE` | Required to enter pipeline | User on creation |
| `STARTED-<stage>` | ACK signal — Claude received the prompt | UserPromptSubmit hook |
| `COMPLETED-<stage>` | Worker finished a stage | Stop hook |
| `CLAIMED` | StageEngine reserved a worker slot | Engine |
| `NEEDS-FIX` | Worker failed; pipeline halted | Engine |
| `BLOCKED` | External dep; pipeline skips | User |
| `WAITING-CONFIRMATION` | Worker waiting on user input | Engine |
| `STALE-RUNTIME` | Inprogress > timeout | MonitorEngine |
| `ACK-TIMEOUT` | Claude never ACK'd within `WORKER_ACK_TIMEOUT_S` | MonitorEngine |
| `skill:<name>` | Force-load specific skill | User |
| `conflict:<domain>` | Serial-with-others-in-same-domain | User |

The active stage writes a per-slot marker file at `~/.coral/projects/<p>/runtime/worker-<slot>-current.json` (v0.50.21+). Stop hook reads it to detect which card the worker just finished.

---

## Memory + Wiki

Two complementary persistence systems, both auto-injected into worker prompts.

| | **Memory** | **Wiki** (v0.51+) |
|---|---|---|
| Path | `~/.coral/memory/{user,agents,projects/<p>}/` | `<repo>/wiki/` (per-project, in repo) |
| Format | Flat markdown + YAML frontmatter | 5 page types with zod-validated frontmatter |
| Cross-link | None (flat index) | `[[type/Title]]` wikilinks |
| Auto-inject | `knowledge` section of prompt | `wikiContext` section (5-layer retrieval) |
| Opt-in | Always on (toggle via `ENABLE_MEMORY=false`) | Per-project (`WIKI_ENABLED=true`) |
| Best for | Personal prefs, ad-hoc decisions, gotchas | Structured project knowledge: modules, concepts, decisions, lessons |

### Memory CLI

```bash
sps memory list <p>                            # show project memory index
sps memory list                                # global view (user + agents)
sps memory context <p> --card <seq>            # preview prompt injection

sps memory add <p> --type convention --name "API uses camelCase" \
  --description "REST endpoints use camelCase" --body "..."
```

Types: `convention` (no decay), `decision` (slow), `lesson` (30 days), `reference` (no decay).

### Wiki CLI (when `WIKI_ENABLED=true`)

```bash
sps wiki init <p>                              # scaffold wiki/ (auto on project init if toggled on)
sps wiki update <p>                            # show source diff
sps wiki update <p> --finalize                 # flush manifest after worker writes pages
sps wiki check <p>                             # lint: orphan / dead-link / fm-gap / stale
sps wiki list <p> --type lesson --tag pipeline
sps wiki get <p> lessons/Stop-Hook-Race
sps wiki status <p>                            # source ↔ manifest ↔ pages diff
sps wiki add <p> ~/notes.md --category transcripts
sps wiki read <p> "<query>"                    # preview the 5-layer retrieval
```

The 5-layer retrieval: hot.md / index summary / pinned / skill-tag / BM25F keyword. Type priority: lesson = 3, decision = 3, concept = 2, module = 1, source = 1. Token budget capped at ~2000.

Worker SOP: [`skills/wiki-update/SKILL.md`](./skills/wiki-update/SKILL.md) (300 lines, single source of truth).

---

## Skills

User-level skills live in `~/.coral/skills/` (28 bundled, copied from npm package on `sps setup`). Symlinked into `~/.claude/skills/` so Claude Code auto-loads them.

```bash
sps skill list                                 # what's available + project status
sps skill add <name> --project <p>             # symlink into <repo>/.claude/skills/
sps skill remove <name> --project <p>
sps skill freeze <name> --project <p>          # symlink → real copy (allow project edits)
sps skill unfreeze <name> --project <p>        # back to symlink
sps skill sync                                 # ① bundled (npm pkg) → ~/.coral/skills/
                                               # ② ~/.coral/skills/ → ~/.claude/skills/
sps skill sync --force                         # ⭐ overwrite existing user skills (after sps-cli upgrade)
```

Bundled skills (v0.51.3):

- **Dev (23)**: `frontend`, `frontend-developer`, `backend`, `backend-architect`, `typescript`, `golang`, `rust`, `python`, `java`, `kotlin`, `swift`, `mobile`, `database`, `database-optimizer`, `qa-tester`, `security-engineer`, `architecture-decision-records`, `coding-standards`, `debugging-workflow`, `devops`, `devops-automator`, `git-workflow`, `code-reviewer`
- **Worker profiles (3)**: `dev-worker`, `tax-worker`, `reviewer` (referenced via `--profile`)
- **SPS-specific (5)**: `sps-pipeline`, `sps-memory`, `wiki-update`

---

## Command reference

```bash
# Setup & projects
sps setup [--force]
sps project init <name>
sps project doctor <name> [--fix] [--json] [--reset-state] [--skip-remote]
sps doctor <name> --fix              # alias

# Pipeline
sps tick <project> [--json]
sps pipeline start|stop|status|reset|workers|board|card|logs|list|run|use [project] [args]
sps pipeline run <name> "<prompt>"   # for mode: steps pipelines
sps pipeline tick <project>          # one-off StageEngine pass
sps scheduler tick <project>         # dormant since v0.51.9 (kept for tick orchestrator)
sps qa tick <project>                # QA → Done finalization
sps monitor tick <project>           # health probe (ACK timeout, stale)
sps pm scan <project>                # rebuild card index from disk

# Cards
sps card add <p> "title" ["description"] [--skills a,b] [--labels x,y]
sps card dashboard <p>
sps card mark-started <p> [seq] [--stage <name>]
sps card mark-complete <p> <seq> [--stage <name>]

# Worker
sps worker ps <project>
sps worker dashboard <project>
sps worker kill <project> <seq>
sps worker launch <project> <seq>

# Status / logs
sps status [--json]
sps stop <project> [--all]
sps reset <project> [--all] [--card N,N,N]
sps logs [project] [--err] [--lines N] [--no-follow]

# Memory
sps memory list [project] [--agent <id>]
sps memory context <project> [--card <seq>] [--agent <id>]
sps memory add <project> --type <T> --name "title" [--body "content"]

# Wiki (v0.51+)
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

# Hooks (called by Claude Code, not by users)
sps hook stop
sps hook user-prompt-submit

# ACP control (for advanced debugging)
sps acp <ensure|run|prompt|status|stop|pending|respond> <project> [args]
```

Add `--help` after any command to see its specific usage. Add `--json` for structured output where supported.

---

## Project config (conf)

Live at `~/.coral/projects/<name>/conf` (shell `export VAR="value"` syntax, mode 600). Full field reference (with comments) auto-generated at `~/.coral/projects/<name>/conf.example`.

| Field | Default | Notes |
|---|---|---|
| `PROJECT_NAME` | (required) | Internal id |
| `PROJECT_DIR` | (required) | Absolute path to repo |
| `GITLAB_PROJECT` | — | `user/repo` (optional, for GitLab API) |
| `GITLAB_PROJECT_ID` | — | Numeric ID (GitLab only; auto-resolved from path on first MR) |
| `GITLAB_MERGE_BRANCH` | `main` | Worker pushes here |
| `PM_TOOL` | `markdown` | **Only `markdown` supported as of v0.42**. Cards live in `~/.coral/projects/<n>/cards/<state>/<seq>.md` |
| `PIPELINE_LABEL` | `AI-PIPELINE` | Required label on cards to enter pipeline |
| `MR_MODE` | `none` | `none` (push direct) / `create` (open MR; needs `GITLAB_PROJECT_ID`) |
| `WORKER_TRANSPORT` | `acp-sdk` | Fixed; do not change |
| `MAX_CONCURRENT_WORKERS` | `1` | Slot count; cards still serial within a project |
| `MAX_ACTIONS_PER_TICK` | `3` | New tasks claimable per tick |
| `INPROGRESS_TIMEOUT_HOURS` | `2` | After this, MonitorEngine flags STALE-RUNTIME |
| `WORKER_ACK_TIMEOUT_S` | `300` | Wait for STARTED-<stage> label after dispatch (5min, raised in v0.50.24) |
| `WORKER_ACK_MAX_RETRIES` | `1` | ACK timeout retry count |
| `MONITOR_AUTO_QA` | `true` | Auto-advance to QA on stale runtime |
| `CONFLICT_DEFAULT` | `serial` | Fallback for cards without `conflict:` label |
| `MATRIX_ROOM_ID` | — | Project-level Matrix override |
| `WORKTREE_DIR` | `~/.coral/worktrees/<p>` | Worker scratch space |
| `DEFAULT_WORKER_SKILLS` | — | Comma-separated; fallback when no `profile:` and no `card.skills` |
| `ENABLE_MEMORY` | `true` | `false` skips memory write instructions in prompt |
| **`WIKI_ENABLED`** | unset (off) | **v0.51+**: `true` enables wiki context injection + reminder |
| `COMPLETION_SIGNAL` | `done` | Word the Stop hook listens for |

Global credentials at `~/.coral/env`: `GITLAB_URL`, `GITLAB_TOKEN`, `GITLAB_SSH_HOST`, `GITLAB_SSH_PORT`, `MATRIX_HOMESERVER`, `MATRIX_ACCESS_TOKEN`, `MATRIX_ROOM_ID`. Set via `sps setup` or `vim`.

---

## Project layout

```
~/.coral/                              # User-global state
├── env                                # Global credentials (mode 600)
├── skills/                            # User-level skills (synced from npm)
├── memory/{user,agents,projects}/     # 3-layer memory store
├── projects/<name>/                   # Per-project state
│   ├── conf                           # Project config (mode 600)
│   ├── conf.example                   # Field reference (auto-generated)
│   ├── pipelines/{project,*}.yaml     # Pipeline definitions
│   ├── pipeline_order.json            # Active pipeline pointer
│   ├── runtime/state.json             # Worker slot + active card state
│   ├── runtime/worker-<slot>-current.json   # Per-slot card marker (v0.50.21+)
│   ├── runtime/tick.lock              # Tick lock
│   ├── runtime/acp-state.json         # ACP session state
│   ├── cards/<state>/<seq>.md         # Card files (markdown PM backend)
│   ├── cards/seq.txt                  # Sequence counter
│   ├── logs/                          # Per-tick logs
│   └── pm_meta/                       # Card index
├── sessions/                          # Agent daemon (chat sessions)
│   ├── daemon.sock daemon.pid
│   └── chat-sessions/<id>.json        # Persisted chat sessions
├── console.lock                       # Single-instance guard for console
└── worktrees/<project>/<seq>/         # Worker worktree per active card
```

In the target repo (PROJECT_DIR):

```
.claude/
├── CLAUDE.md                          # Worker rules (project-specific + SPS-injected)
├── settings.local.json                # Claude Code local config
├── skills/                            # Symlinked from ~/.coral/skills/
└── hooks/{start,stop}.sh              # Lifecycle hooks (call into sps)
wiki/                                  # If WIKI_ENABLED — see docs/design/28-wiki-system.md
ATTRIBUTION.md                         # If WIKI_ENABLED
```

---

## Architecture

4-layer service architecture (v0.50+):

```
Delivery (commands/, console/routes/)        Thin parameter parsing + I/O orchestration
  ↓
Service (services/)                          ProjectService / ChatService / PipelineService /
                                             SkillService / WikiService — Result<T> + DomainEvent
  ↓
Domain (engines/)                            SchedulerEngine / StageEngine / MonitorEngine /
                                             CloseoutEngine / EventHandler — pipeline logic
  ↓
Infrastructure                               WorkerManager (single worker), ACPWorkerRuntime,
  (manager/, providers/, daemon/)            sessionDaemon, TaskBackend, RepoBackend
```

Engines:

- **SchedulerEngine** — dormant since v0.51.9 (cards go directly to Backlog on add; Planning is a manual park). Class kept as a no-op for the tick orchestrator's stable interface.
- **StageEngine** — drives card through stages; builds prompt (skill + projectRules + memory + **wikiContext** + task description + **wikiUpdateReminder**); kicks worker via ACP.
- **MonitorEngine** — ACK timeout detection, stale runtime, auto-QA promotion.
- **CloseoutEngine** + **EventHandler** — finalize completed cards.

**Single-worker is intentional**: v0.37.2 deleted multi-worker concurrency code. Don't propose "add a parallel mode" — the architecture relies on serial execution for state coherence. For higher throughput, run multiple projects in parallel.

For deep dives:
- [doc-27: Service Layer Architecture](../../docs/design/27-service-layer-architecture.md) — current architecture
- [doc-26: Console Architecture](../../docs/design/26-console-architecture.md) — console internals
- [doc-28: Wiki System](../../docs/design/28-wiki-system.md) — wiki design
- [doc-13: Development Guardrails](../../docs/design/13-development-guardrails.md) — hard rules for contributors
- [doc-17: Pipeline Configuration](../../docs/design/17-pipeline-configuration-design.md) — YAML field semantics
- [docs/design/](../../docs/design/) — full design tree (most v0.15-v0.32 docs are marked HISTORICAL)

---

## Troubleshooting

```bash
sps doctor <project> --fix           # ★ first thing to try
sps logs <project> --err             # stderr / errors only
sps reset <project> --card <seq>     # nuke a stuck card
sps reset <project> --all            # full project reset

# Worker / daemon issues
sps worker ps <project>
sps agent daemon status              # is the chat daemon up?
sps agent daemon stop && sps agent daemon start    # restart (clears stale cwd)

# Wiki issues
sps wiki check <project>
sps wiki status <project>
```

Common issues:

| Symptom | Cause / fix |
|---|---|
| Pipeline halted with `NEEDS-FIX` | Open the failed card, fix the issue, remove the label. Console makes this 2 clicks. |
| Worker not starting | `sps worker ps`, then `sps logs --err`. Often Claude API key missing or `claude-agent-acp` adapter not installed (`sps setup` reinstalls). |
| Cards stuck in Planning | Need `AI-PIPELINE` label. `sps card add` applies it automatically; if added externally, add manually. |
| ACK timeout on every card | Claude cold-start is slow with many skill / memory files. Raise `WORKER_ACK_TIMEOUT_S` (default 300s as of v0.50.24). |
| Console shows stale data | SSE may have dropped; reload page; if persistent, `sps console --kill && sps console`. |
| Wiki context not injecting | Verify `WIKI_ENABLED=true` in conf and `wiki/WIKI.md` exists. StageEngine logs a warning if conf says yes but scaffold is missing. |
| New skill SOP not pulling after upgrade | `sps skill sync --force` (default sync skips existing skills). |
| Daemon chat using wrong cwd | Daemon captures cwd at startup. `sps agent daemon stop && cd <repo> && sps agent daemon start`. |

---

## License & attribution

MIT, see [`LICENSE`](../../LICENSE).

The Wiki system (v0.51+) borrows ~70% from [claude-obsidian](https://github.com/kepano/claude-obsidian) (MIT) — three-layer architecture, manifest delta tracking, hot cache, ingest workflow, contradiction callouts, wikilinks. SPS-specific 30%: 5 page types, `sources={card,commit,path}`, 5-layer reader, `sps wiki check` exit gate. Mental model from Karpathy's "LLM Wiki" gist.

Full attribution: [`ATTRIBUTION.md`](./ATTRIBUTION.md).
