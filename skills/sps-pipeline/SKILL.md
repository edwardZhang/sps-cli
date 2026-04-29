---
name: sps-pipeline
description: |
  SPS pipeline & project management — set up projects, configure YAML pipelines, manage
  task cards, drive worker lifecycle, run web console, monitor health. Use when the user
  asks to "create a pipeline", "set up a project", "add tasks", "start the pipeline",
  "open console", "check status", or anything in the SPS workflow. (🪸 Coral SPS)
---

# SPS Pipeline (v0.51.x — Single-Worker Card Pipeline + Web Console + Wiki)

SPS drives an AI worker through task cards. **One worker, one card at a time, serial
execution.** Each card walks one or more YAML-defined stages (e.g. `develop → review →
Done`); failure halts until the user resolves it. v0.50 added a 4-layer service
architecture; v0.51 added per-project Wiki knowledge base injection.

## Two ways to operate

| Mode | Command | Use when |
|---|---|---|
| **Web Console** (preferred) | `sps console` | Daily work — kanban, logs, worker dashboard, project create, conf editor, pipeline editor, chat with agent, all in one UI |
| **CLI** | `sps tick / card / worker / wiki / …` | Scripting, troubleshooting, headless servers |

Console listens on `127.0.0.1:4311` by default; opens browser auto. Single-instance
guard via `~/.coral/console.lock`.

---

## 1. First-time setup

```bash
npm install -g @coralai/sps-cli      # latest (currently 0.51.x)
sps setup                            # ⭐ MUST RUN: interactive wizard
```

`sps setup` does:
1. Creates `~/.coral/` directory tree (`projects/`, `memory/user/`, `memory/agents/`).
2. Copies bundled skills → `~/.coral/skills/`.
3. Interactively writes `~/.coral/env` (Git remote token, Matrix credentials, etc.).
4. Symlinks user skills → `~/.coral/.claude/skills/` and `~/.claude/skills/`.
5. Installs `@agentclientprotocol/claude-agent-acp` globally if missing.

Re-run safe: `sps setup --force` keeps existing values as defaults.

**No separate console config**. Console reads `~/.coral/env` + per-project conf.

---

## 2. Create a project

### Option A — Console (recommended)
Open `sps console` → `/projects/new` → fill form → submit. Form provides:
- Project name + repo path
- Git toggle (worker commits + pushes? off for non-code projects)
- **Wiki toggle** (v0.51+): scaffolds `wiki/` + writes `WIKI_ENABLED=true` to conf
- Merge branch, max workers, ACK timeout, Matrix room

### Option B — Interactive CLI
```bash
sps project init <name>      # asks the same questions on tty
```

### What gets created

```
~/.coral/projects/<name>/
├── conf                      # your active settings (private, mode 600)
├── conf.example              # full reference with comments (read-only docs)
├── pipelines/
│   ├── project.yaml          # default 1-stage pipeline (develop → Done)
│   └── sample.yaml.example   # heavily-commented YAML reference
├── pipeline_order.json       # active pipeline pointer
├── runtime/
│   ├── state.json            # worker slot + active card state (machine-managed)
│   └── tick.lock             # lock file
├── logs/                     # per-tick logs
├── pm_meta/                  # markdown card backend metadata
└── cards/                    # state subdirs created on first use
    └── seq.txt
```

Plus, in the **target repo** (PROJECT_DIR):
- `.claude/CLAUDE.md` — worker rules + (if wiki=on) wiki SOP block
- `.claude/skills/` — symlinked from `~/.coral/skills/`
- `.claude/settings.local.json` — Claude Code local config
- `wiki/` (if wiki=on) — knowledge base scaffold
- `ATTRIBUTION.md` (if wiki=on) — borrows declaration

---

## 3. Pipeline YAML

**Location**: `~/.coral/projects/<name>/pipelines/project.yaml`

**Single source of truth** for stages, profiles, transitions. Edit this file (or in
console at `/projects/<name>` pipeline editor) to customize.

### Critical YAML rules

1. **`mode: project`** — orchestrate cards through states. (`mode: steps` is for
   one-shot custom pipelines via `sps pipeline run <name>`.)
2. **`on_complete` of each stage points to the next stage's target state.** No
   skipping, no looping.
3. **Last stage's `on_complete: "move_card Done"`.**
4. **Don't write `agent:` field** — it's accepted for back-compat but ignored.
   Claude (via ACP) is the only supported worker as of v0.38.0.
5. **Single worker, serial execution** — set `MAX_CONCURRENT_WORKERS` in conf if
   you want >1 slot reserved, but cards still run one at a time.
6. **Failure halts pipeline** by default (`on_fail.halt: true`). Worker labels card
   `NEEDS-FIX`; user must resolve before next card runs.

### Templates

**Simple (1 stage):**
```yaml
mode: project
git: true
stages:
  - name: develop
    on_complete: "move_card Done"
    on_fail:
      action: "label NEEDS-FIX"
      halt: true
```

**With review (2 stages):**
```yaml
mode: project
git: true
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

**Non-git (data / docs project):**
```yaml
mode: project
git: false
stages:
  - name: process
    profile: tax-worker
    on_complete: "move_card Done"
    on_fail: { action: "label PROCESS-FAILED", halt: true }
```

### YAML field reference

| Field | Required | Notes |
|---|---|---|
| `mode` | yes | `project` (state machine) or `steps` (one-shot, run via `sps pipeline run`) |
| `git` | no | `true` (default) — worker commits + pushes / `false` — no git ops |
| `stages` | yes | Array |
| `stages[].name` | yes | Unique within file |
| `stages[].profile` | no | Skill profile (e.g. `fullstack` / `reviewer` / `tax-worker`); falls back to `DEFAULT_WORKER_SKILLS` in conf |
| `stages[].on_complete` | yes | `"move_card <NextState>"` |
| `stages[].on_fail.action` | no | `"label NEEDS-FIX"` etc. |
| `stages[].on_fail.halt` | no | default `true` |
| `stages[].on_fail.comment` | no | Comment text |
| `stages[].timeout` | no | `30s` / `5m` / `2h` (rare) |

`trigger` and `card_state` are auto-derived per stage from the position. Don't set
manually.

### Custom pipelines (mode: steps)

For one-shot scripted runs (e.g. canary deploy, bulk ingest), use `mode: steps` and
invoke via `sps pipeline run <pipeline-name> "<prompt>"`. Out of scope for normal
card pipelines; see `sample.yaml.example` for syntax.

---

## 4. Card state machine

```
Since v0.51.9:

Backlog → Todo → Inprogress → [QA / Review] → Done
   ↑↓
Planning (manual staging by the user; not auto-dispatched)
                                  ↓ fail
                            NEEDS-FIX (halt)
```

Default states (configurable in YAML `pm.card_states`):
- **Planning** — v0.51.10+: manual staging / draft. The **console "New card" form** defaults here; the user drags to Backlog to run.
- **Backlog** — **`sps card add` (CLI / agent)** defaults here; StageEngine claims and runs the card.
- **Todo** — StageEngine has prepped (branch / worktree); the next tick dispatches a worker.
- **Inprogress** — worker active
- **QA** (or **Review**) — code complete, awaiting human/auto verification
- **Done** — finished
- **Canceled** — folded into Done view (rare state)

Engines walk this graph each tick. The **active stage** writes a per-slot marker
file at `~/.coral/projects/<p>/runtime/worker-<slot>-current.json` (v0.50.21+).
Stop hook reads this to detect which card the worker just finished.

---

## 5. Card management

### Where new cards land — depends on caller (v0.51.10+)

| Caller | Default entry state | Behavior |
|---|---|---|
| **`sps card add`** (CLI / Worker / agent) | **Backlog** | StageEngine claims it on the next tick and runs |
| **Console "New card" form** | **Planning** | Staged; runs only when the user drags it to Backlog on the board |
| **`POST /api/projects/<p>/cards`** (direct API call) | **Planning** | Defaults to the manual semantics; pass `initialState: 'Backlog'` in the body to run immediately |

**Agent calls `sps card add` → card lands in Backlog → runs automatically.** This is the main SPS path. When a Worker inside one card needs to "spawn a sub-task," it calls `sps card add` — the sub-task is auto-picked up on the next tick.

```bash
# Agent / Worker main path — lands in Backlog and runs automatically
sps card add <project> "Title" "Description"
sps card add <project> "T" "D" --skills python,backend --labels feature

# Stage instead (let the user review / drag to dispatch later)
sps card add <project> "Title" "Description" --draft
                                  # → card lands in Planning, awaits manual drag to Backlog
```

### View

```bash
sps card dashboard <project>       # CLI table
                                   # console: /board?project=<name>
```

### Lifecycle (machine-managed, but you can intervene)

```bash
sps card mark-started <p> <seq>    # called by Claude Code UserPromptSubmit hook
sps card mark-complete <p> <seq>   # called by Claude Code Stop hook
sps reset <p>                      # reset all non-Done
sps reset <p> --card 5,6,7         # reset specific seq
sps reset <p> --all                # full reset incl. Done
```

Note: `sps reset` returns the card to **Planning** (not Backlog) — reset = back to manual control; you must drag to Backlog again to re-run. This semantic applies since v0.51.9.

### Card label vocabulary

| Label | Meaning | Who sets |
|---|---|---|
| `AI-PIPELINE` | Marker for "SPS pipeline cards" (since v0.51.9+ no auto behavior is triggered — purely identification) | Auto-added by `sps card add` |
| `STARTED-<stage>` | ACK signal — Claude received the prompt | UserPromptSubmit hook |
| `COMPLETED-<stage>` | Worker finished a stage | Stop hook |
| `CLAIMED` | StageEngine reserved a worker slot | Engine |
| `NEEDS-FIX` | Worker failed; pipeline halted | Engine |
| `BLOCKED` | External dep; pipeline skips | User |
| `WAITING-CONFIRMATION` | Worker waiting on user input | Engine |
| `STALE-RUNTIME` | Inprogress > timeout | MonitorEngine |
| `ACK-TIMEOUT` | Claude never ACK'd within `WORKER_ACK_TIMEOUT_S` | MonitorEngine |
| `skill:<name>` | Force-load specific skill | User on card |
| `conflict:<domain>` | Serial-with-others-in-same-domain | User |

---

## 6. Pipeline lifecycle commands

```bash
# Run continuously (one tick spawns next via cron-like loop)
sps tick <project>                 # foreground tick(s) — Ctrl+C to stop
sps pipeline start <project>       # alias for tick
sps pipeline stop <project>        # graceful stop
sps stop <project>                 # CLI alias for stop
sps stop --all                     # stop all running ticks

# Status
sps status                         # all projects
sps pipeline status                # alias
sps doctor <project>               # health check
sps doctor <project> --fix         # auto-repair drift

# One-off ticks (each engine separately, useful for cron / debugging)
sps scheduler tick <p>             # No-op since v0.51.9 (dormant; interface kept for compatibility)
sps pipeline tick <p>              # full StageEngine pass
sps qa tick <p>                    # QA → Done finalization
sps monitor tick <p>               # health probe (ACK timeout, stale runtime)
sps pm scan <p>                    # rebuild card index from disk
```

### Worker control

```bash
sps worker ps <project>            # list slots + PIDs
sps worker dashboard <project>     # rich UI (also in console)
sps worker kill <project> <seq>    # SIGKILL one slot
sps worker launch <project> <seq>  # manual spawn (debugging)
```

### Logs

```bash
sps logs <project>                 # follow mode (default)
sps logs <project> --err           # stderr only
sps logs <project> --lines 50 --no-follow
                                   # console: /logs?project=<name> (live SSE)
```

---

## 7. Web Console (`sps console`)

Single binary launches the web UI:

```bash
sps console                        # opens http://127.0.0.1:4311
sps console --port 5000
sps console --no-open
sps console --kill                 # stop running console
sps console --dev                  # vite dev server (development)
```

Pages:
- `/projects` — list, summary cards
- `/projects/new` — create project (with Wiki toggle, v0.51)
- `/projects/<n>` — pipeline editor + conf editor + delete
- `/board` — kanban (with **per-column scrolling**, v0.51.1+)
- `/workers` — aggregate worker dashboard (all projects)
- `/logs` — live SSE log viewer
- `/skills` — user-level skill management
- `/system` — global settings, daemon status
- `/chat` — agent chat (multi-session, persistent)

---

## 8. Memory & Wiki (auto-injected into Worker prompts)

| | **Memory** (`sps-memory` skill) | **Wiki** (`wiki-update` skill) |
|---|---|---|
| Purpose | Ad-hoc facts, user prefs, decisions, gotchas | Structured project knowledge: modules, concepts, decisions, lessons |
| Path | `~/.coral/memory/{user,agents,projects/<p>}/` | `<repo>/wiki/` (per-project, in repo) |
| Schema | Markdown + YAML frontmatter (`type: convention/decision/lesson/reference`) | 5 page types with zod-validated frontmatter |
| Cross-link | None (flat index) | `[[type/Title]]` wikilinks |
| Auto-inject | `buildFullMemoryContext` → prompt's `knowledge` section | `wikiRead` 5-layer → prompt's `wikiContext` section (only when `WIKI_ENABLED=true`) |
| When to use | Personal style notes, "remember X" requests | Project knowledge that benefits future cards |

If you're configuring a project that needs structured knowledge accumulation,
**enable Wiki** at create time. For ad-hoc facts only, memory alone is enough.

CLI helpers:
```bash
sps memory list <p>
sps memory context <p>             # preview what gets injected
sps memory add <p> --type convention --name "title" --body "content"

sps wiki init <p>                  # scaffold (auto when WIKI_ENABLED=true)
sps wiki update <p>                # source diff
sps wiki update <p> --finalize     # flush manifest after pages written
sps wiki check <p>                 # lint
sps wiki read <p> "<query>"        # preview prompt injection
sps wiki list/get/add/status       # browse / inspect
```

---

## 9. Conf reference (essentials)

Live at `~/.coral/projects/<name>/conf` (shell `export VAR="value"` syntax).

| Field | Default | Notes |
|---|---|---|
| `PROJECT_NAME` | (required) | Internal id |
| `PROJECT_DIR` | (required) | Repo absolute path |
| `GITLAB_PROJECT` | — | `user/repo` (optional, for GitLab API) |
| `GITLAB_MERGE_BRANCH` | `main` | Worker pushes here |
| `PM_TOOL` | `markdown` | **Only `markdown` supported as of v0.42.0**. Plane/Trello removed. Cards live in `~/.coral/projects/<n>/cards/<state>/<seq>.md` |
| `PIPELINE_LABEL` | `AI-PIPELINE` | Marker label auto-added by `sps card add` — identifies SPS-managed cards. Since v0.51.9, no automatic state promotion is triggered (cards run based on their entry state) |
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
| `DEFAULT_WORKER_SKILLS` | — | Comma-separated skill list when no `profile:` and no `card.skills` |
| `ENABLE_MEMORY` | `true` | Set `false` to skip memory write instructions in prompt |
| **`WIKI_ENABLED`** | unset (off) | **v0.51+**: `true` enables wiki context injection + reminder block |
| `COMPLETION_SIGNAL` | `done` | Word the Stop hook listens for |

Full reference: `~/.coral/projects/<n>/conf.example` (auto-generated, comment-rich).

---

## 10. Architecture (4-layer, v0.50+)

```
Delivery (commands/, console/routes/)
  → execute* / HTTP routes; thin
Service (services/)
  → ProjectService / ChatService / PipelineService / SkillService — Result<T> + DomainEvent
Domain (engines/)
  → SchedulerEngine / StageEngine / MonitorEngine / EventHandler
Infrastructure (manager/, providers/, daemon/)
  → WorkerManager (single worker), ACPWorkerRuntime, sessionDaemon
```

### Engines

- **SchedulerEngine** — dormant since v0.51.9 (cards added directly to Backlog; no promotion needed)
- **StageEngine** — drives card through stages; builds prompt (skill + projectRules
  + memory + **wikiContext** + task description + **wikiUpdateReminder**); kicks
  Worker via ACP
- **MonitorEngine** — ACK timeout detection, stale runtime, auto-QA promotion
- **CloseoutEngine / EventHandler** — finalize completed cards

### Single worker is intentional

v0.37.2 deleted multi-worker concurrency code by design. Don't propose "add a
parallel mode" — the architecture relies on serial execution for state coherence.
For higher throughput, run multiple projects in parallel (each its own tick loop).

---

## 11. Troubleshooting

```bash
sps doctor <project> --fix         # ★ first thing to try
sps logs <project> --err           # stderr / errors
sps reset <project> --card <seq>   # nuke a stuck card
sps reset <project> --all          # full project reset (worktrees, branches, state)

# Worker / daemon issues
sps worker ps <project>
sps agent daemon status            # is the chat daemon up?
sps agent daemon stop && sps agent daemon start    # restart daemon (clears stale cwd)

# Wiki issues (v0.51+)
sps wiki check <project>           # lint
sps wiki status <project>          # source / manifest / pages diff
```

Common issues:

- **Pipeline halted with NEEDS-FIX** — open the failed card, fix the issue, remove
  the label. Console makes this 2 clicks.
- **Worker not starting** — `sps worker ps`, then check `sps logs --err`. Often
  Claude API key missing or `claude-agent-acp` adapter not installed (`sps setup`
  reinstalls it).
- **Cards stuck in Planning (v0.51.9+)** — Planning is manual staging. **The Console form creates cards here by default**; drag to Backlog to dispatch. Agent / `sps card add` defaults to Backlog and auto-runs (won't get stuck in Planning).
- **ACK timeout on every card** — Claude cold-start is slow with many skills/memory
  files. Raise `WORKER_ACK_TIMEOUT_S` in conf (default 300s as of v0.50.24).
- **Console shows stale data** — SSE may have dropped; reload page; if persistent,
  `sps console --kill && sps console`.
- **Wiki context not injecting** — verify `WIKI_ENABLED=true` in conf and
  `wiki/WIKI.md` exists. StageEngine logs a warning if conf says yes but scaffold
  is missing.

---

## 12. Skill ↔ project linkage

User-level skills live in `~/.coral/skills/`. To use one in a specific project:

```bash
sps skill list                             # what's available + project status
sps skill add <name> --project <p>         # symlink into <repo>/.claude/skills/
sps skill remove <name> --project <p>
sps skill freeze <name> --project <p>      # symlink → real copy (allow project edits)
sps skill unfreeze <name> --project <p>    # back to symlink
sps skill sync                             # ① bundled (npm pkg) → ~/.coral/skills/
                                           # ② ~/.coral/skills/ → ~/.claude/skills/
```

**After upgrading sps-cli**, run `sps skill sync` to pick up new bundled skills
(e.g. `wiki-update` added in v0.51.0).
