# SPS CLI — AI Agent Harness & Development Pipeline

[![npm](https://img.shields.io/npm/v/@coralai/sps-cli)](https://www.npmjs.com/package/@coralai/sps-cli)

> **中文文档**: See `README-CN.md` in the source repository for Chinese documentation.

**v0.32.0**

SPS (Smart Pipeline System) is an AI Agent harness and automated development pipeline. Two modes:

- **Harness mode** (`sps agent`): Zero-config agent interaction — one-shot, multi-turn chat, persistent sessions
- **Pipeline mode** (`sps pipeline`): Fully automated card-driven development workflow with YAML-configurable stages

```bash
# Harness mode — talk to any agent instantly
sps agent "Explain this repo"
sps agent --chat                              # multi-turn REPL (daemon-backed)
sps agent --tool codex "Fix the failing tests"
sps agent --profile reviewer --context src/auth.ts "Review this module"
sps agent --verbose --output report.md "Security audit"

# Pipeline mode — automated development workflow
sps pipeline start my-project                 # or: sps tick my-project
sps pipeline workers my-project               # worker dashboard
sps pipeline board my-project                 # card board
```

## Harness Mode (`sps agent`)

Zero-config direct agent interaction. No project setup, PM tools, or Git required.

### One-shot

```bash
sps agent "What does this codebase do?"
sps agent --tool codex "Fix the bug in auth.ts"
sps agent --output summary.md "Summarize this repo"
```

### Multi-turn Chat (Persistent)

Sessions survive terminal closures via background daemon:

```bash
sps agent --chat                          # start chat (daemon auto-starts)
> Analyze the auth module
> Now refactor it to use bcrypt
> /exit                                   # detach (session stays alive)

sps agent --chat                          # reconnect — agent remembers context
> What did we do last time?
```

### Advanced Flags

| Flag | Description | Example |
|------|-------------|---------|
| `--tool <agent>` | Choose agent | `--tool codex`, `--tool gemini` |
| `--chat` | Multi-turn REPL mode | `sps agent --chat` |
| `--name <name>` | Named session (persistent) | `--name backend` |
| `--verbose` / `-v` | Show tool calls | Shows Read, Edit, Bash in yellow |
| `--context <file>` | Attach file content | `--context src/main.ts` (multiple OK) |
| `--system "<text>"` | System instruction | `--system "Reply in Chinese"` |
| `--profile <name>` | Load role profile | `--profile reviewer`, `--profile security` |
| `--output <file>` | Save output to file | `--output report.md` |
| `--json` | JSON output for scripting | `sps agent --json "2+2"` |
| `--hook <cmd>` | Post-prompt feedback loop | `--hook "npm test"` (multiple OK) |
| `--mcp <server>` | Attach MCP server | `--mcp postgres`, `--mcp github` |
| `--attach` | Read-only session viewer | `--attach --name backend` |

### Hook Feedback Loop

Agent completes → hooks run → if any fail → failure fed back to agent → agent fixes → retry (max 5):

```bash
# Auto-fix until tests pass
sps agent --hook "npm test" "Fix the failing auth test"

# Multi-hook: lint + typecheck
sps agent --hook "npm run lint" --hook "npm run typecheck" "Refactor utils"

# Multi-agent: writer + reviewer loop
sps agent --hook "sps agent --json --profile reviewer 'Review. Reply PASS or FAIL.'" "Write auth module"
```

### MCP Server Integration

Attach MCP servers to give the agent additional tools:

```bash
sps agent --mcp postgres "Show all tables and row counts"
sps agent --mcp github "List open issues in this repo"
sps agent --mcp filesystem --mcp fetch "Download the API spec and save it locally"
```

Built-in: `filesystem`, `postgres`, `sqlite`, `github`, `memory`, `fetch`. Custom: any command path.

### Session Management

```bash
sps agent status                  # list active sessions
sps agent close --name backend    # close a session
sps agent --attach --name backend # read-only view of session output
sps agent daemon start            # start background daemon manually
sps agent daemon stop             # stop daemon (kills all sessions)
sps agent daemon status           # check daemon status
```

### Cross-Server Remote Sessions

Access a remote server's daemon via SSH tunnel:

```bash
# Remote server: start daemon
sps agent daemon start

# Remote server: bridge socket to TCP (run once)
node -e "
const net = require('net');
const server = net.createServer(c => {
  const d = net.createConnection('/home/user/.coral/sessions/daemon.sock');
  c.pipe(d); d.pipe(c);
  c.on('error', () => d.destroy()); d.on('error', () => c.destroy());
});
server.listen(19876, '127.0.0.1', () => console.log('Bridge ready'));
" &

# Local machine: SSH tunnel
ssh -L 19876:127.0.0.1:19876 user@server -N &

# Local machine: bridge TCP back to socket
node -e "
const net = require('net');
try { require('fs').unlinkSync('/tmp/sps-remote.sock'); } catch {}
const server = net.createServer(c => {
  const r = net.createConnection(19876, '127.0.0.1');
  c.pipe(r); r.pipe(c);
  c.on('error', () => r.destroy()); r.on('error', () => c.destroy());
});
server.listen('/tmp/sps-remote.sock', () => console.log('Local bridge ready'));
" &

# Local machine: use remote daemon
SPS_DAEMON_SOCKET=/tmp/sps-remote.sock sps agent --name work "Analyze the codebase"
```

### Custom Agents

```bash
sps agent add cursor cursor-agent acp     # register custom ACP agent
sps agent add my-bot ./bin/my-server      # register local agent
sps agent list                            # show all available agents
sps agent --tool cursor "Review this PR"  # use custom agent
```

Available built-in agents: `claude` (default), `codex`, `gemini`

## Pipeline Mode (`sps pipeline`)

Fully automated card-driven development workflow. Requires project configuration.

```bash
sps pipeline start my-project     # start continuous pipeline (= sps tick)
sps pipeline stop my-project      # stop pipeline
sps pipeline status               # show all projects
sps pipeline reset my-project     # reset cards for re-execution
sps pipeline workers my-project   # worker dashboard
sps pipeline board my-project     # card board
sps pipeline logs my-project      # log viewer
```

All old commands still work as aliases: `sps tick`, `sps stop`, `sps status`, `sps reset`, `sps logs`, `sps worker dashboard`, `sps card dashboard`.

### Pipeline YAML Configuration

Create `.sps/pipelines/<name>.yaml` in your project to customize the pipeline:

```yaml
mode: project

pm:
  card_states:
    planning: Planning
    backlog: Backlog
    ready: Todo
    active: Inprogress
    review: QA
    done: Done

stages:
  - name: develop
    trigger: "card_enters 'Todo'"
    card_state: Inprogress
    agent: claude              # per-stage agent (claude/codex/gemini)
    profile: phaser,typescript # skill profiles to load
    completion: git-evidence   # git-evidence | fast-forward-merge | exit-code
    on_complete: "move_card QA"
    on_fail:
      action: "label NEEDS-FIX"
      comment: "Development failed."

  - name: integrate
    trigger: "card_enters 'QA'"
    card_state: QA
    agent: codex               # use different agent for integration
    completion: fast-forward-merge
    on_complete: "move_card Done"
    queue: fifo
```

Switch between multiple pipelines:

```bash
sps pipeline use my-project develop   # activate develop.yaml
sps pipeline use my-project docs      # switch to docs.yaml
```

### Worker Management

```bash
sps worker ps my-project              # show worker status, pid, runtime
sps worker kill my-project 42         # kill specific worker by seq
```

### Skill Management

Skills are loaded from `~/.coral/skills/` via symlink to agent directories:

```bash
sps skill sync                        # sync skills to ~/.claude/skills/ + ~/.codex/skills/
```

### Global Configuration

Set default agent in `~/.coral/env`:

```bash
export DEFAULT_AGENT="claude"         # or "codex"
```

`sps agent` priority: `--tool` flag > `DEFAULT_AGENT` env > `'claude'`

## Architecture

```
SPS CLI
├── Harness Mode (sps agent)
│   ├── SessionDaemon (Unix socket, background persistent)
│   ├── DaemonClient (NDJSON RPC)
│   └── AcpSdkAdapter
│        ├── claude-agent-acp (Anthropic official SDK)
│        ├── codex-acp (Zed Rust binary)
│        └── gemini --acp (native)
│
└── Pipeline Mode (sps pipeline)
    ├── WorkerManager + CompletionJudge
    ├── 4-Engine Tick Loop (Scheduler → Closeout → Execution → Monitor)
    └── AcpSdkAdapter (shared with harness)
```

ACP SDK transport: structured JSON-RPC over stdio. No terminal scraping. Deterministic state detection via protocol events.

## Table of Contents

- [Installation](#installation)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Harness Mode](#harness-mode-sps-agent)
- [Pipeline Mode](#pipeline-mode-sps-pipeline)
- [Architecture](#architecture)
- [State Machine](#state-machine)
- [Command Reference](#command-reference)
- [Worker Rule Files](#worker-rule-files)
- [Project Configuration](#project-configuration)
- [Multi-Project Parallel Execution](#multi-project-parallel-execution)
- [Architecture Overview](#architecture-overview)
- [Directory Structure](#directory-structure)

---

## Installation

```bash
npm install -g @coralai/sps-cli
```

Local development:

```bash
cd coding-work-flow/workflow-cli
npm run build
# Or run directly with tsx
npx tsx src/main.ts --help
```

## Prerequisites

| Dependency | Minimum Version | Description |
|------------|----------------|-------------|
| Node.js | 18+ | CLI runtime |
| git | 2.x | Branch and worktree management |
| Claude Code CLI or Codex CLI | Latest | AI Worker |
| tmux | 3.x | No longer required (legacy dependency removed in v0.26.1) |

## Quick Start

```bash
# 1. Global environment initialization (first-time setup, configure GitLab/PM/notification credentials)
sps setup

# 2. Clone your project repository (prerequisite)
git clone git@gitlab.example.com:team/my-project.git ~/projects/my-project

# 3. Initialize SPS project management directory
sps project init my-project

# 4. Edit project configuration
vim ~/.coral/projects/my-project/conf

# 5. Health check + auto-fix (generates CLAUDE.md, AGENTS.md, initializes state.json, etc.)
sps doctor my-project --fix

# 6. (Optional) Edit Worker rules to add project-specific coding standards
vim ~/projects/my-project/CLAUDE.md

# 7. Create task cards
sps card add my-project "Implement user login" "JWT authentication endpoint"
sps card add my-project "Implement order system" "CRUD API + pagination"

# 8. Start pipeline (fully automated, exits when all cards are complete)
sps tick my-project

# 9. (Optional) Monitor Worker status in real time
sps worker dashboard

# 10. (Optional) Monitor task cards in board view
sps card dashboard my-project
```

---

## State Machine

Each task card progresses through the following state machine, fully driven by SPS:

### MR_MODE=none (Default, Recommended)

The main path is now a worker-owned two-phase flow:

```
Planning -> Backlog -> Todo -> Inprogress -> QA -> Done
```

| Phase | Trigger Engine | Action |
|-------|---------------|--------|
| Planning -> Backlog | SchedulerEngine | Select card for queue, check admission criteria |
| Backlog -> Todo | ExecutionEngine | Create branch, create worktree, generate phase prompts |
| Todo -> Inprogress | ExecutionEngine | Assign Worker slot, launch development worker |
| Inprogress -> QA | PostActions | Detect development completion, release slot, move card to QA |
| QA -> Done | CloseoutEngine | Launch/resume integration worker, verify merge evidence, release resources, clean up worktree |

In this model, the development worker stops at “implementation complete and committed on the task branch”. The QA worker owns integration: it must inspect the current worktree, rebase/merge the task branch back into the target branch, resolve conflicts, and finish the integration. If a development worker merges early anyway, SPS absorbs that as an exception from git evidence and closes the task directly instead of forcing an extra QA run. See `docs/design/10-acp-worker-runtime-design.md` for the persistent Agent transport model, the full worker state breakdown, and the local same-user OAuth reuse boundary. See `docs/design/11-runtime-state-authority-and-recovery-redesign.md` for the redesign that demotes `state.json` / `acp-state.json` to projections and re-centers recovery around PM state plus worktree/git evidence. See `docs/design/12-unified-runtime-state-machine.md` for the current unified state-machine model. See `docs/design/13-development-guardrails.md` for the non-negotiable development rules that prevent future features from reintroducing old state, merge, or prompt-model drift.

The autonomous main path uses ACP SDK transport by default. `WORKER_TRANSPORT=acp-sdk` is the workflow transport for `tick`, `pipeline tick`, `qa tick`, `worker launch`, and `recovery`; workers communicate via structured ACP JSON-RPC over stdio. `proc` one-shot mode (`codex exec` / `claude -p`) is available as fallback via `WORKER_TRANSPORT=proc`. `sps acp` commands provide diagnostic and manual-control capabilities.

### MR_MODE=create (Optional)

After completing coding, the Worker creates an MR. The task is then considered complete. MR review is handled by subsequent processes (under development):

```
Planning -> Backlog -> Todo -> Inprogress -> Done (MR created)
```

| Phase | Trigger Engine | Action |
|-------|---------------|--------|
| Inprogress -> Done | ExecutionEngine | Detect Worker completion (MR created), release resources, clean up worktree |

### Auxiliary Status Labels

Cards may be tagged with the following labels, indicating special handling is needed:

| Label | Meaning | Handling |
|-------|---------|----------|
| `BLOCKED` | Blocked by external dependency | Skipped, awaiting manual intervention |
| `NEEDS-FIX` | Worker failure or CI failure | Auto-fix or manual intervention |
| `WAITING-CONFIRMATION` | Worker awaiting destructive operation confirmation | Notify for manual confirmation |
| `CONFLICT` | Merge conflict | Worker auto-resolves or manual handling |
| `STALE-RUNTIME` | Worker runtime anomaly | MonitorEngine cleanup |

---

## Command Reference

### Global Options

All commands support:

| Option | Description |
|--------|-------------|
| `--json` | Output structured JSON (for script/cron consumption) |
| `--dry-run` | Preview actions without executing |
| `--help` | Show help |
| `--version` | Show version number |

### Exit Codes

| Exit Code | Meaning |
|-----------|---------|
| `0` | Success |
| `1` | Business failure / validation failure |
| `2` | Argument error |
| `3` | External dependency unavailable (GitLab / PM / Worker) |

---

### sps setup

Global environment initialization wizard for configuring external system credentials. Preserves existing values by showing current configuration as defaults -- press Enter to keep the current value.

```bash
sps setup [--force]
```

**Interactive configuration items:**

- GitLab: `GITLAB_URL`, `GITLAB_TOKEN`, `GITLAB_SSH_HOST`, `GITLAB_SSH_PORT`
- Plane: `PLANE_URL`, `PLANE_API_KEY`, `PLANE_WORKSPACE_SLUG`
- Trello: `TRELLO_API_KEY`, `TRELLO_TOKEN`
- Matrix: `MATRIX_HOMESERVER`, `MATRIX_TOKEN`, `MATRIX_ROOM_ID`

Credentials are stored in `~/.coral/env` (permissions 0600), shared across all projects.

| Option | Description |
|--------|-------------|
| `--force` | Overwrite existing `~/.coral/env` |

---

### sps project init

Initialize an SPS project management directory.

```bash
sps project init <project> [--force]
```

**Created directory structure:**

```
~/.coral/projects/<project>/
├── conf                    # Project configuration file (generated from template)
├── logs/                   # Log directory
├── pm_meta/                # PM metadata cache
├── runtime/                # Runtime state
├── pipeline_order.json     # Card execution order
├── batch_scheduler.sh      # cron-compatible entry script
└── deploy.sh               # Deployment script template
```

| Option | Description |
|--------|-------------|
| `--force` | Overwrite template files (conf will not be overwritten) |

**Example:**

```bash
sps project init accounting-agent
# -> Creates ~/.coral/projects/accounting-agent/
# -> Next step: edit conf to fill in configuration values
```

---

### sps doctor

Project health check and auto-repair.

```bash
sps doctor <project> [--fix] [--json] [--skip-remote]
```

Equivalent to `sps project doctor <project>`.

**Checks:**

| Check | Description | --fix |
|-------|-------------|-------|
| global-env | Whether `~/.coral/env` exists | -- |
| global-env-vars | Whether GITLAB_URL / GITLAB_TOKEN are loaded | -- |
| conf-load | Whether configuration file can be loaded | -- |
| conf-fields | Whether all required fields are present | -- |
| instance-dir / logs-dir / runtime-dir / pm-meta-dir | Directory structure | Create missing directories |
| repo-dir | Whether project repo exists and is a git repository | -- |
| gitignore-sps | Whether `.sps/` is in .gitignore | Append |
| worker-rules | Whether CLAUDE.md / AGENTS.md exist in repo root | Generate and commit (including .gitignore) |
| skill-profiles | Whether profile files specified by DEFAULT_WORKER_SKILLS exist | -- |
| state-json | Whether runtime state file is valid | Initialize |
| pipeline-order | Whether execution order file exists | Create empty |
| conf-cli-fields | Whether CLI-required Provider field mappings are complete (Plane only) | Append mappings |
| gitlab | GitLab API connectivity | -- |
| plane | Plane API connectivity (PM_TOOL=plane only) | -- |
| pm-states / pm-lists | Whether PM state/list UUIDs are valid | Auto-create + write to conf |
| worker-tool | Whether Claude Code / Codex CLI is in PATH | -- |
| acp-runtime | Whether ACP agent binaries are available | -- |

| Option | Description |
|--------|-------------|
| `--fix` | Auto-fix repairable issues (create directories, generate files, initialize state) |
| `--json` | Output check results in JSON format |
| `--skip-remote` | Skip remote connectivity checks (GitLab/Plane) |

**Example:**

```bash
# Check + auto-fix
sps doctor my-project --fix
#   ok  global-env        /home/user/.coral/env
#   ok  global-env-vars   GITLAB_URL and GITLAB_TOKEN set
#   ok  conf-load         Loaded ~/.coral/projects/my-project/conf
#   ok  conf-fields       All required fields present
#   ok  repo-dir          /home/user/projects/my-project
#   ok  gitignore-sps     .sps/ in .gitignore
#   ok  worker-rules      Generated and committed: CLAUDE.md, AGENTS.md
#   ok  skill-profiles    DEFAULT_WORKER_SKILLS="senior" -- all profiles found
#   ok  state-json        Initialized with 3 worker slots
#   ok  acp-runtime       claude-agent-acp and codex-acp available

# JSON output
sps doctor my-project --json
```

---

### sps card add

Create a task card.

```bash
sps card add <project> "<title>" ["description"]
```

Cards are created in the Planning state, automatically tagged with `AI-PIPELINE`, and appended to `pipeline_order.json`.

After creation, add a `skill:` label to specify the Worker's expertise (see label descriptions below).

| Option | Description |
|--------|-------------|
| `--json` | Output creation result in JSON format |

**Example:**

```bash
# Create cards + add skill labels
sps card add my-project "Implement user login" "JWT authentication endpoint"
sps pm addLabel my-project 1 "skill:backend"

sps card add my-project "Implement order list" "CRUD API + pagination"
sps pm addLabel my-project 2 "skill:backend"

sps card add my-project "Write API documentation" "User and order endpoint docs"
sps pm addLabel my-project 3 "skill:writer"
```

### sps card dashboard

Kanban-style dashboard for task cards. Single-project mode renders a full board, while multi-project mode renders compact mini boards side by side.

```bash
sps card dashboard [project1] [project2] ... [--once] [--json]
```

| Option | Description |
|--------|-------------|
| (no arguments) | Auto-discovers all projects under `~/.coral/projects/` and renders compact multi-project panels |
| `<project>` | Render a full single-project board with `Planning / Backlog / Todo / In Progress / QA / Done` columns |
| `--once` | Output one snapshot and exit |
| `--json` | Output structured card/board snapshots for scripting |

Single-project mode shows:
- Project title and live counts
- Six workflow columns
- Compact task cards with title, label summary, worker/runtime state, and conflict/waiting badges

Multi-project mode shows:
- One panel per project
- Compact per-state counts
- Hot cards summary for running / waiting / conflict items

**Example:**

```bash
# Full board for one project
sps card dashboard my-project

# Compact board snapshots for all projects
sps card dashboard

# Single JSON snapshot
sps card dashboard my-project --json
```

#### Skill Labels

Each card should have **one** `skill:` label. The Pipeline automatically loads the corresponding Worker skill profile and injects it into the prompt:

| Label | Worker Role | Deliverables |
|-------|------------|--------------|
| `skill:architect` | Architecture design | ADR, design docs, directory structure |
| `skill:frontend` | Frontend development | Components, pages, frontend tests |
| `skill:backend` | Backend development | API, DB migration, backend tests |
| `skill:fullstack` | Full-stack development | Frontend + backend + DB integrated |
| `skill:prototyper` | Rapid prototyping | Runnable MVP |
| `skill:reviewer` | Code review | Review report + fix commits |
| `skill:security` | Security audit | Audit report + vulnerability fixes |
| `skill:writer` | Technical writing | README, API docs, PRD |
| `skill:optimizer` | Performance optimization | Benchmark report + optimization commits |
| `skill:senior` | General purpose (fallback) | High-quality general implementation |

Profile files are located at `~/.coral/profiles/<name>.md`. When no label is present, it falls back to the project conf's `DEFAULT_WORKER_SKILLS`.

---

### sps tick

Unified main loop -- orchestrates all engines, executing scheduler -> qa -> pipeline -> monitor in sequence.

```bash
sps tick <project> [project2] [project3] ... [--json] [--dry-run]
```

**Execution order (per tick cycle):**

1. **scheduler tick** -- Planning -> Backlog (select cards for queue)
2. **qa tick** -- QA -> integration worker -> Done (prioritize finishing branch integration and freeing Worker slots)
3. **pipeline tick** -- Backlog -> Todo -> Inprogress (prepare environment + launch Worker)
4. **monitor tick** -- Anomaly inspection and alignment

**Run modes:**

| Mode | Behavior |
|------|----------|
| Continuous (default) | Cycles every 30 seconds, auto-exits when all cards are complete |

**Concurrency mutex:**

Only one `tick` instance is allowed per project at any time. Mutex is implemented via `runtime/tick.lock` (PID + timestamp). Locks exceeding `TICK_LOCK_TIMEOUT_MINUTES` (default 30 minutes) are considered deadlocked and can be forcibly taken over.

**Failure classification:**

| Type | Behavior | Example |
|------|----------|---------|
| Fatal failure | Short-circuits the entire tick | Corrupted conf, PM unavailable |
| Degraded continuation | Subsequent steps run with limitations | Scheduler failure -> pipeline won't launch new cards |
| Non-critical failure | Logged and continued | Notification send failure |

| Option | Description |
|--------|-------------|
| `--once` | Exit after single execution |
| `--json` | Output aggregated results in JSON format |
| `--dry-run` | Preview actions without executing |

**Example:**

```bash
# Single project continuous run
sps tick my-project

# Multi-project simultaneous management
sps tick project-a project-b project-c

# JSON output (suitable for cron)
sps tick my-project --json

# Preview mode
sps tick my-project --dry-run
```

**JSON output format:**

```json
{
  "project": "my-project",
  "component": "tick",
  "status": "ok",
  "exitCode": 0,
  "steps": [
    { "step": "scheduler", "status": "ok", "actions": ["..."] },
    { "step": "qa", "status": "ok", "actions": ["..."] },
    { "step": "pipeline", "status": "ok", "actions": ["..."] },
    { "step": "monitor", "status": "ok", "checks": ["..."] }
  ]
}
```

---

### sps status

Show running status of all projects.

```bash
sps status [--json]
```

| Option | Description |
|--------|-------------|
| `--json` | Output structured JSON |

---

### sps acp

Manage persistent session-backed worker sessions directly for diagnostics, manual intervention, and experiments. This is no longer the default transport used by `sps tick`.

```bash
sps acp ensure <project> <slot> [claude|codex] [--json]
sps acp run <project> <slot> [claude|codex] "<prompt>" [--json]
sps acp prompt <project> <slot> [claude|codex] "<prompt>" [--json]
sps acp status <project> [slot] [--json]
sps acp stop <project> <slot> [--json]
```

Current behavior:

- `ensure` starts or reuses an ACP SDK session for the specified worker slot
- `run` submits a prompt onto the session and records a new run snapshot
- `status` refreshes session and run state from the local gateway
- `stop` terminates the persistent session and marks the slot `offline`
- `sps tick` does not use this transport as its default autonomous execution chain
- retry / conflict follow-up runs reuse the same slot session when possible, and now recreate a fresh persistent session automatically if the old one has already disappeared

Observed session states:

| State | Meaning |
|-------|---------|
| `ready` | Session is authenticated and idle, ready to accept a prompt |
| `busy` | Session is alive and currently working |
| `booting` | Session started but is still blocked on onboarding or authentication |
| `offline` | Session is not reachable |

Current verification scope:

- Codex is verified in this release for `ensure -> run -> status -> stop`
- Claude session bootstrap and status detection are implemented, but prompt execution still depends on host-side `claude auth login`

---

### sps scheduler tick

Manually execute the scheduling step: Planning -> Backlog.

```bash
sps scheduler tick <project> [--json] [--dry-run]
```

- Reads `pipeline_order.json` to determine card priority
- Checks admission criteria (Worker availability, conflict domains, etc.)
- Moves eligible cards from Planning to Backlog

**Example:**

```bash
sps scheduler tick my-project
sps scheduler tick my-project --dry-run
```

---

### sps pipeline tick

Manually execute the execution chain: Backlog -> Todo -> Inprogress.

```bash
sps pipeline tick <project> [--json] [--dry-run]
```

**Internal steps:**

1. **Check Inprogress cards** -- Detect Worker completion status. MR_MODE=none pushes directly to Done; MR_MODE=create confirms MR then pushes to Done
2. **Process Backlog cards** -- Create branch + create worktree + generate phase prompts -> push to Todo
3. **Process Todo cards** -- Assign Worker slot + build task context + launch Worker -> push to Inprogress

Limited by `MAX_ACTIONS_PER_TICK` (default 1) to prevent launching too many Workers in a single tick cycle. There is a delay between multiple Worker launches (2 seconds in print mode, 10 seconds in interactive mode).

When ResourceLimiter blocks a launch, SPS now logs the exact reason (`worker cap reached` vs `memory threshold reached`) together with `active/max` and `memory/current-threshold` diagnostics.

If `MAX_CONCURRENT_WORKERS` is increased after a project was already running, SPS now auto-reconciles legacy `state.json` worker slots to the new configured count on the next read.

Cards with `BLOCKED`, `NEEDS-FIX`, `CONFLICT`, `WAITING-CONFIRMATION`, or `STALE-RUNTIME` labels are skipped.

**Example:**

```bash
sps pipeline tick my-project
sps pipeline tick my-project --json
```

---

### sps worker

Worker lifecycle management.

#### sps worker launch

Manually launch a single Worker.

```bash
sps worker launch <project> <seq> [--json] [--dry-run]
```

If the card is in Backlog state, it will automatically execute prepare first (create branch + worktree), then launch the Worker.

**Launch process:**

1. Assign an available Worker slot
2. Write `.sps/task_prompt.txt` to the worktree
3. Launch Worker process
4. Push card to Inprogress

**Worker transport modes (`WORKER_TRANSPORT`):**

| Transport | Default | Description |
|-----------|---------|-------------|
| `acp-sdk` | **Yes** | ACP JSON-RPC over stdio — structured, deterministic state detection |
| `proc` | No | One-shot execution (`claude -p` / `codex exec`), process exit = task complete |

**ACP SDK mode (default):**

Workers communicate via structured ACP JSON-RPC protocol over stdio. Claude uses `claude-agent-acp` (Anthropic's official SDK), Codex uses `codex-acp` (Zed's Rust native binary).

Key advantages:
- **Structured communication** -- JSON-RPC protocol, no terminal screen-scraping
- **Deterministic state detection** -- No regex parsing, no guessing
- **Permission handling** -- Programmatic per-tool-call approval via `requestPermission` callback
- **Real-time logs** -- ACP events stream to `*-acp-*.log` files
- **No external dependencies** -- Pure process management, suitable for CI/CD environments

**Proc mode (fallback):**

The Worker runs as a one-shot subprocess:

```
Claude:  claude -p --output-format stream-json --dangerously-skip-permissions
Codex:   codex exec - --json --sandbox danger-full-access
```

**Session Resume chain:**

Multiple tasks on the same worktree (initial implementation -> CI fix -> conflict resolution) share the same session:

```
Task 1: claude -p "Implement feature"              -> session_id_1 (stored in state.json)
CI fix: claude -p "Fix CI" --resume sid             -> Inherits full context from task 1
Conflict: claude -p "Resolve conflict" --resume sid -> Inherits all historical context
```

**Example:**

```bash
sps worker launch my-project 24
sps worker launch my-project 24 --dry-run
```

#### sps worker dashboard

Real-time dashboard for monitoring all Worker running states.

```bash
sps worker dashboard [project1] [project2] ... [--once] [--json]
```

| Option | Description |
|--------|-------------|
| (no arguments) | Auto-discovers all projects under `~/.coral/projects/` |
| `--once` | Output a single snapshot then exit (no real-time mode) |
| `--json` | Output in JSON format (all projects, all Worker slot states + output preview) |

**Real-time mode:**

- Refreshes every 3 seconds by default (adjustable via `SPS_DASHBOARD_INTERVAL` environment variable)
- Press `q` to quit, press `r` to force refresh
- Uses alternate screen buffer (does not pollute terminal scrollback)
- Adaptive grid layout, one panel per Worker
- Proc mode panels show: PID, exit code, JSONL-rendered human-readable output
- ACP SDK panels show: transport, session/run status, model, cwd, pending confirmation, and the latest structured summary line

**Example:**

```bash
# Monitor all projects
sps worker dashboard

# Monitor specific projects
sps worker dashboard my-project

# Single snapshot
sps worker dashboard --once

# JSON output (for script consumption)
sps worker dashboard --json

# Custom refresh interval
SPS_DASHBOARD_INTERVAL=5000 sps worker dashboard
```

---

### sps pm

PM backend operations.

#### sps pm scan

View card list.

```bash
sps pm scan <project> [state]
```

Lists all cards when `state` is not specified.

**Example:**

```bash
# View all cards
sps pm scan my-project

# Filter by state
sps pm scan my-project Inprogress
sps pm scan my-project Planning
```

#### sps pm move

Manually move a card's state.

```bash
sps pm move <project> <seq> <state>
```

**Example:**

```bash
sps pm move my-project 24 QA
sps pm move my-project 25 Done
```

#### sps pm comment

Add a comment to a card.

```bash
sps pm comment <project> <seq> "<text>"
```

**Example:**

```bash
sps pm comment my-project 24 "CI passed, awaiting review"
```

#### sps pm checklist

Manage card checklists.

```bash
# Create checklist
sps pm checklist create <project> <seq> "item1" "item2" "item3"

# View checklist
sps pm checklist list <project> <seq>

# Check/uncheck items
sps pm checklist check <project> <seq> <item-id>
sps pm checklist uncheck <project> <seq> <item-id>
```

**Example:**

```bash
sps pm checklist create my-project 24 "Unit tests" "Integration tests" "Code review"
sps pm checklist list my-project 24
sps pm checklist check my-project 24 item-001
```

---

### sps qa tick

QA close-out and worktree cleanup.

```bash
sps qa tick <project> [--json]
```

**When MR_MODE=none:** QA is the integration phase. The QA worker must inspect the task worktree, continue merge/rebase work, resolve conflicts, and drive the branch back into the target branch. `qa tick` launches or resumes that integration worker and only moves the card to `Done` after merge evidence is observed.

**When MR_MODE=create:** QA remains a compatibility path while MR flow is still being converged on the same worker-owned model.

**Automatic worktree cleanup:**

After each qa tick cycle, items in the `state.worktreeCleanup` queue are automatically processed:

1. `git worktree remove --force <path>` -- Remove worktree directory
2. `git branch -d <branch>` -- Delete merged local branch
3. `git worktree prune` -- Clean up residual references

Failed cleanup entries remain in the queue and are automatically retried in the next tick cycle.

**Example:**

```bash
sps qa tick my-project
sps qa tick my-project --json
```

---

### sps monitor tick

Manually execute anomaly detection and health inspection.

```bash
sps monitor tick <project> [--json]
```

**Inspection items:**

| Check | Description |
|-------|-------------|
| Orphan slot cleanup | Worker process is dead but slot is still marked active |
| Timeout detection | Inprogress exceeds `INPROGRESS_TIMEOUT_HOURS` |
| State alignment | Whether PM state and runtime state are consistent |

**Example:**

```bash
sps monitor tick my-project
sps monitor tick my-project --json
```

---

### sps stop

Stop running tick process(es).

```bash
sps stop <project>    # stop specific project
sps stop --all        # stop all running ticks
```

---

### sps reset

Reset cards for re-execution. Performs 5 atomic steps: stop tick, clean state, remove worktrees + branches, move cards to Planning, report.

```bash
sps reset <project>              # reset all non-Done cards
sps reset <project> --all        # reset ALL cards including Done
sps reset <project> --card 5     # reset specific card
sps reset <project> --card 5,6,7 # reset multiple cards
```

Typical workflow after version upgrade:

```bash
npm i -g @coralai/sps-cli    # upgrade
sps reset my-project          # clean reset
sps tick my-project           # re-run
```

---

### sps logs

Real-time log viewer.

```bash
sps logs [project]                    # follow pipeline log
sps logs <project> --err              # follow error log
sps logs <project> --lines 50         # show last 50 lines
sps logs <project> --no-follow        # print and exit
```

---

## Worker Rule Files

`sps doctor --fix` generates rule files based on the configured `WORKER_TOOL`:

| File | Purpose | Required by | Committed to git |
|------|---------|-------------|-----------------|
| `CLAUDE.md` | Project rules for Claude Code Worker | `WORKER_TOOL=claude` | Yes |
| `AGENTS.md` | Project rules for Codex Worker | `WORKER_TOOL=codex` | Yes |
| `.sps/development_prompt.txt` | Development-phase prompt (debug archive) | — | No (.gitignore) |
| `.sps/integration_prompt.txt` | Integration-phase prompt (debug archive) | — | No (.gitignore) |
| `docs/DECISIONS.md` | Architecture decisions (worker auto-maintained) | — | Yes |
| `docs/CHANGELOG.md` | Change log (worker auto-maintained) | — | Yes |

**Note**: Prompts are generated in-memory and passed via stdin (v0.25.0+). The `.sps/` files are debug archives only — their absence does not block the pipeline.

**Skill Profile injection (v0.16+):**

| File | Purpose |
|------|---------|
| `~/.coral/profiles/<name>.md` | Loaded into Worker prompt via `skill:<name>` label |

Prompt assembly order: Skill Profile -> CLAUDE.md/AGENTS.md -> DECISIONS.md/CHANGELOG.md -> Task description

### How It Works

1. `CLAUDE.md` and `AGENTS.md` are committed to the repository's main branch
2. When creating a git worktree, these files are automatically inherited
3. On startup, the Worker reads CLAUDE.md to understand project rules (auto-discovered in interactive mode; auto-loaded from cwd in print mode)
4. Task-specific information is written into `.sps/development_prompt.txt` and `.sps/integration_prompt.txt` inside each worktree; `.sps/task_prompt.txt` remains as a development-phase compatibility alias
5. Development workers use the development prompt and stop at a committed task branch; QA workers use the integration prompt and complete merge/conflict work

### Project Knowledge Base

Each Worker is instructed in the task prompt to:

- **Before starting**: Read `docs/DECISIONS.md` and `docs/CHANGELOG.md` to understand decisions and changes from preceding tasks
- **After completion**: Append their architecture decisions to `docs/DECISIONS.md` and change summaries to `docs/CHANGELOG.md`

These files are merged with the code into the target branch. The next Worker inherits them when creating a worktree, enabling cross-task knowledge transfer.

### Customizing Project Rules

The generated CLAUDE.md includes a "Project-Specific Rules" placeholder section where you can add:

```markdown
## Project-Specific Rules
- Language: TypeScript strict mode
- Test framework: vitest, coverage 80%+
- Architecture: src/modules/<domain>/ directory structure
- Linting: eslint + prettier, must pass before commit
```

SPS will not overwrite existing CLAUDE.md / AGENTS.md files.

---

## Project Configuration

Configuration is split into two layers:

| File | Scope | Description |
|------|-------|-------------|
| `~/.coral/env` | Global | Credentials shared across all projects (GitLab token, PM API key, etc.) |
| `~/.coral/projects/<project>/conf` | Project | Project-specific configuration (repository, branch, Worker parameters, etc.) |

Project conf can reference global variables (e.g., `${PLANE_URL}`).

### Configuration Field Reference

#### Project Basics

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `PROJECT_NAME` | Yes | -- | Project name |
| `PROJECT_DIR` | No | `~/projects/<project>` | Project repository path |

#### GitLab

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `GITLAB_PROJECT` | Yes | -- | GitLab project path (e.g., `group/repo`) |
| `GITLAB_PROJECT_ID` | Yes | -- | GitLab project numeric ID |
| `GITLAB_MERGE_BRANCH` | Yes | `develop` | MR target branch |

#### PM Backend

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `PM_TOOL` | No | `trello` | PM backend type: `plane` / `trello` / `markdown` |
| `PIPELINE_LABEL` | No | `AI-PIPELINE` | Pipeline card label |
| `MR_MODE` | No | `none` | Merge mode: `none` (worker-owned QA integration back to target branch) / `create` (create MR, review flow under development) |

#### Worker

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `WORKER_TOOL` | No | `claude` | Worker type: `claude` / `codex` |
| `WORKER_TRANSPORT` | No | `acp-sdk` | Worker transport: `acp-sdk` (ACP JSON-RPC, default), `proc` (one-shot fallback) |
| `ACP_AGENT` | No | `WORKER_TOOL` | Default ACP tool when `sps acp` does not receive a tool override |
| `MAX_CONCURRENT_WORKERS` | No | `3` | Maximum parallel Workers (worker slot ceiling) |
| `WORKER_RESTART_LIMIT` | No | `2` | Maximum restart count after Worker death |
| `MAX_ACTIONS_PER_TICK` | No | `1` | Maximum launches per tick cycle; raise with `MAX_CONCURRENT_WORKERS` if one tick should fill all slots |

#### Timeouts and Policies

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `INPROGRESS_TIMEOUT_HOURS` | No | `8` | Inprogress timeout in hours |
| `MONITOR_AUTO_QA` | No | `false` | Whether Monitor auto-pushes completed cards to QA |
| `CONFLICT_DEFAULT` | No | `serial` | Default conflict domain strategy: `serial` / `parallel` |
| `TICK_LOCK_TIMEOUT_MINUTES` | No | `30` | Tick lock timeout in minutes |

#### Paths

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `WORKTREE_DIR` | No | `~/.coral/worktrees/` | Worktree root directory |

### Configuration Example

```bash
# ~/.coral/projects/my-project/conf

PROJECT_NAME="my-project"
PROJECT_DIR="/home/user/projects/my-project"

# GitLab
GITLAB_PROJECT="team/my-project"
GITLAB_PROJECT_ID="42"
GITLAB_MERGE_BRANCH="develop"

# PM (uses variables from global ~/.coral/env)
PM_TOOL="plane"
PLANE_API_URL="${PLANE_URL}"
PLANE_PROJECT_ID="project-uuid-here"

# Worker
WORKER_TOOL="claude"
MAX_CONCURRENT_WORKERS=3
MAX_ACTIONS_PER_TICK=1

# Merge mode
MR_MODE="none"                   # none (worker-owned QA integration) or create (create MR)
```

---

## Multi-Project Parallel Execution

SPS supports managing multiple projects simultaneously in a single process:

```bash
sps tick project-a project-b project-c
```

Each project is fully isolated:
- Independent ProjectContext, Provider instances, Engine instances
- Independent tick.lock (non-blocking between projects)
- Independent state.json (Worker slots are not mixed)
- Errors in one project do not affect others

Multi-Worker parallel configuration:

```bash
# Set in project conf
MAX_CONCURRENT_WORKERS=3
CONFLICT_DEFAULT=parallel
```

---

## Architecture Overview

### Four-Layer Architecture

```
Layer 3  Commands + Engines    CLI commands + state machine engines
Layer 2  Providers             Concrete backend implementations
Layer 1  Interfaces            Abstract interfaces
Layer 0  Core Runtime          Configuration, paths, state, locks, logging
```

### Supported Backends

| Type | Provider | Interface |
|------|----------|-----------|
| PM Backend | Plane CE / Trello / Markdown | TaskBackend |
| Code Hosting | GitLab | RepoBackend |
| AI Worker (print) | ClaudePrintProvider / CodexExecProvider | WorkerProvider |
| AI Worker (interactive) | ClaudeTmuxProvider / CodexTmuxProvider | WorkerProvider |
| Notifications | Matrix | Notifier |

### Engines

| Engine | Responsibility |
|--------|---------------|
| SchedulerEngine | Planning -> Backlog (card selection, sorting, admission checks) |
| ExecutionEngine | Backlog -> Todo -> Inprogress (prepare environment, launch development Worker, detect completion handoff to QA) |
| CloseoutEngine | Worktree cleanup (legacy QA card handling when MR_MODE=create) |
| MonitorEngine | Anomaly detection (orphan cleanup, timeouts, blocks, state alignment, dead Worker completion detection) |

---

## Directory Structure

```
workflow-cli/
├── src/
│   ├── main.ts                 # CLI entry point, command routing
│   ├── commands/               # Command implementations
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
│   ├── core/                   # Core runtime
│   │   ├── config.ts           #   Configuration loading (shell conf parsing)
│   │   ├── context.ts          #   ProjectContext
│   │   ├── paths.ts            #   Path resolution
│   │   ├── state.ts            #   Runtime state (state.json)
│   │   ├── lock.ts             #   Tick lock
│   │   ├── logger.ts           #   Logging + structured events
│   │   └── queue.ts            #   Pipeline queue
│   ├── engines/                # State machine engines
│   │   ├── SchedulerEngine.ts  #   Card selection and queuing
│   │   ├── ExecutionEngine.ts  #   Execution chain
│   │   ├── CloseoutEngine.ts   #   QA close-out
│   │   └── MonitorEngine.ts    #   Anomaly detection
│   ├── manager/                # Worker process management module (v0.16.0)
│   │   ├── supervisor.ts       #   fd-redirected spawn, child handle, exit callbacks
│   │   ├── completion-judge.ts #   git output checks, marker/keyword detection
│   │   ├── post-actions.ts     #   merge + PM update + slot release + notify
│   │   ├── pm-client.ts        #   Lightweight PM operations (Plane/Trello/Markdown)
│   │   ├── resource-limiter.ts #   Global worker count cap + memory checks
│   │   └── recovery.ts         #   Post-restart PID scan recovery
│   ├── interfaces/             # Abstract interfaces
│   │   ├── TaskBackend.ts      #   PM backend interface
│   │   ├── RepoBackend.ts      #   Code repository interface
│   │   ├── Notifier.ts         #   Notification interface
│   │   └── HookProvider.ts     #   Hook interface
│   ├── models/                 # Type definitions
│   │   └── types.ts            #   Card, CommandResult, WorkerStatus, etc.
│   └── providers/              # Concrete implementations
│       ├── registry.ts         #   Provider factory
│       ├── PlaneTaskBackend.ts
│       ├── TrelloTaskBackend.ts
│       ├── MarkdownTaskBackend.ts
│       ├── adapters/           #   ACP SDK adapters
│       │   └── AcpSdkAdapter.ts #  Unified ACP adapter (JSON-RPC over stdio)
│       ├── outputParser.ts      #   JSONL output parsing, process management utilities
│       ├── streamRenderer.ts    #   JSONL -> human-readable text (for Dashboard)
│       ├── GitLabRepoBackend.ts
│       └── MatrixNotifier.ts
├── package.json
└── tsconfig.json
```

---

## Manager Module (v0.16.0)

v0.16.0 introduced the `src/manager/` directory, decoupling Worker process management from Engines into independent modules that run as internal tick modules (not standalone daemons).

| Module | Lines | Responsibility |
|--------|-------|---------------|
| `supervisor.ts` | 288 | fd-redirected spawn (OS-level guaranteed output writing), holds child handle, exit callback triggers post-processing, three-layer env var merging (system -> global credentials -> project config) |
| `completion-judge.ts` | 110 | phase-aware git evidence checks (branch commits vs merged target), marker file detection, completion keyword fallback |
| `post-actions.ts` | 412 | Complete post-Worker-exit chain: merge -> PM state update -> slot release -> notify |
| `pm-client.ts` | 294 | Lightweight PM operation wrapper, supports Plane/Trello/Markdown backends |
| `resource-limiter.ts` | 103 | Global worker count cap check + memory check + launch interval control |
| `recovery.ts` | 205 | Post-tick-restart PID scan to recover orphan worker processes |

**Refactoring results:**
- ExecutionEngine reduced from 1219 to 916 lines (removed attemptResume, completeAndRelease)
- MonitorEngine reduced from 974 to 750 lines (removed direct PID detection)
- tick.ts added ~80 lines (initialize shared Manager modules, run Recovery on startup)

---

## Label-Driven Skill Injection (v0.16.0)

Worker expertise is injected via PM card labels, allowing customization of Worker behavior for different tasks without code changes.

**Mechanism:**
- Adding a `skill:xxx` label to a PM card -> automatically loads `~/.coral/profiles/xxx.md` into the Worker prompt
- Multiple `skill:` labels can be stacked for combined injection
- Projects can configure default skills via `DEFAULT_WORKER_SKILLS`; card labels override project defaults

**Prompt assembly order:**
1. Skill Profiles (skill templates)
2. Project Rules (CLAUDE.md / AGENTS.md)
3. Project Knowledge (docs/DECISIONS.md, docs/CHANGELOG.md)
4. Task (.sps/task_prompt.txt)

**Built-in skill templates:**

| File | Purpose |
|------|---------|
| `~/.coral/profiles/_template.md` | Template for creating new skills |
| `~/.coral/profiles/typescript.md` | TypeScript project coding standards |
| `~/.coral/profiles/phaser.md` | Phaser game framework development guide |

**Adding new skills requires zero code:** Simply create an md file in `~/.coral/profiles/` directory, then add the corresponding `skill:xxx` label to the PM card.

---

## License

MIT
