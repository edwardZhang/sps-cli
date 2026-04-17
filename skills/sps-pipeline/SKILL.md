---
name: sps-pipeline
description: |
  SPS pipeline management — create projects, configure YAML pipelines, manage task cards,
  start/stop pipelines, and monitor worker status. Single worker serial execution model.
  Use when asked to "create a pipeline", "set up a project", "add tasks", "start the pipeline",
  "check pipeline status", or manage SPS workflow. (🪸 Coral SPS)
---

# SPS Pipeline Management (v0.37.2 — Single Worker Model)

SPS runs a single AI worker that processes task cards one at a time. Each card goes through
one or more stages (develop, review, etc.) before moving to Done. If a card fails, the
pipeline halts until the issue is resolved.

## Interactive Pipeline Creation

When the user asks to create a pipeline, set up a project, or configure YAML:

### Step 1: Gather project info

Ask the user:
1. **Project name** — SPS identifier (e.g. `my-app`)
2. **Repository path** — local path (e.g. `~/projects/my-app`)
3. **Git remote** — GitLab/GitHub project path (e.g. `user/my-app`), blank to skip
4. **Target branch** — default `main` or `develop`
5. **PM backend** — `markdown` (zero-config) / `plane` / `trello`

### Step 2: Design the pipeline

Ask the user:
1. **Project type:**
   - `git: true` (default) — code project, worker commits + pushes to current branch
   - `git: false` — non-code project (document processing, data tasks, no git ops)
2. **How many stages?**
   - **Simple** (1 stage): develop → Done
   - **With review** (2 stages): develop → review → Done
3. **Skill profile?** — e.g. `fullstack`, `frontend`, `backend`, `reviewer`, `tax-worker` (optional)

### Step 3: Generate and deploy

1. Run `sps project init <name>` if project doesn't exist
2. Generate YAML at `~/.coral/projects/<name>/pipelines/project.yaml`
3. Show the generated YAML and explain each section

### CRITICAL: YAML Rules

1. **`on_complete` of each stage MUST point to the next stage's target state** — no skipping, no looping
2. **Last stage's `on_complete` MUST be `"move_card Done"`**
3. **`trigger` and `card_state` are auto-derived** — you don't need to specify them
4. **Completion is always `exit-code`** — worker finishes when the AI process exits
5. **Single worker** — cards are processed one at a time, no concurrency

### YAML Examples

**Simple (1 stage):**

```yaml
mode: project
git: true

stages:
  - name: develop
    agent: claude
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
    agent: claude
    profile: fullstack
    on_complete: "move_card Review"
    on_fail:
      action: "label NEEDS-FIX"
      halt: true

  - name: review
    profile: reviewer
    on_complete: "move_card Done"
    on_fail:
      action: "label REVIEW-FAILED"
      halt: true
```

**Non-code (data processing):**

```yaml
mode: project
git: false

stages:
  - name: process
    profile: tax-worker
    on_complete: "move_card Done"
    on_fail:
      action: "label PROCESS-FAILED"
      halt: true
```

### YAML Location

```
~/.coral/projects/<name>/pipelines/project.yaml
```

### YAML Field Reference

| Field | Required | Description |
|-------|----------|-------------|
| `mode` | yes | Always `project` |
| `git` | no | `true` (default, commit+push) or `false` (no git) |
| `stages` | yes | Array of stage definitions |
| `stages[].name` | yes | Stage name (unique) |
| `stages[].agent` | no | Accepted for backward-compat only; value ignored (claude is the only supported CLI) |
| `stages[].profile` | no | Skill profile to load |
| `stages[].on_complete` | yes | `"move_card <State>"` — next state |
| `stages[].on_fail.action` | no | `"label <LABEL>"` — add label on failure |
| `stages[].on_fail.halt` | no | `true` (default) stop pipeline / `false` continue |
| `stages[].on_fail.comment` | no | Comment text on failure |
| `stages[].timeout` | no | Max duration: `30s` / `5m` / `2h` |

---

## Quick Reference

### Project Lifecycle

```bash
# Install
npm install -g @coralai/sps-cli

# Setup (credentials, skills, directories)
sps setup

# Initialize project (interactive)
sps project init <name>

# Create pipeline YAML
vim ~/.coral/projects/<name>/pipelines/project.yaml

# Add task cards
sps card add <name> "Task title" "Description"

# Start pipeline
sps tick <name>

# Monitor
sps card dashboard <name>
sps worker ps <name>
sps status

# Stop
sps stop <name>
```

### Card Management

```bash
sps card add <project> "Title" "Description"
sps card dashboard <project>
sps reset <project>              # Reset all non-Done cards
sps reset <project> 5 6 7       # Reset specific cards
```

### Memory System

```bash
sps memory list <project>
sps memory context <project>
sps memory add <project> --type convention --name "Title" --body "Content"
```

Types: `convention` (no decay), `decision` (slow), `lesson` (30 days), `reference` (no decay).

---

## Architecture

```
SchedulerEngine
  → Planning cards with AI-PIPELINE label → Backlog → Ready

StageEngine (single worker, serial)
  → Take one card → run stage 1 → run stage 2 → ... → Done
  → Fail → NEEDS-FIX → halt pipeline

MonitorEngine
  → Worker health check
```

### Execution Model

- **One card at a time** — no concurrency, no worktrees, no feature branches
- **Worker runs in PROJECT_DIR** — directly on the current branch
- **git: true** — worker commits and pushes to current branch
- **git: false** — worker processes files, no git operations
- **Failure halts pipeline** — NEEDS-FIX label blocks next card until resolved
- **Auto-recovery** — orphaned Inprogress cards reset to Ready on tick restart

### Card State Flow

```
Planning → Backlog → Ready → Inprogress → [Review] → Done
                                  ↓ fail
                            NEEDS-FIX (halt)
```

---

## Config Reference (conf)

| Field | Description |
|-------|-------------|
| `PROJECT_NAME` | Project identifier |
| `PROJECT_DIR` | Repository path |
| `GITLAB_PROJECT` | Git remote path (optional) |
| `GITLAB_MERGE_BRANCH` | Target branch |
| `PM_TOOL` | `markdown` / `plane` / `trello` |
| `PIPELINE_LABEL` | Card label for pipeline (default: `AI-PIPELINE`) |

## Card Labels

| Label | Purpose |
|-------|---------|
| `AI-PIPELINE` | Required — marks card for pipeline |
| `skill:xxx` | Load specific skill profile |
| `NEEDS-FIX` | Worker failed — pipeline halted |
| `BLOCKED` | External dependency |

## Troubleshooting

```bash
sps doctor <project> --fix       # Health check
sps logs <project>               # View logs
sps reset <project> <seq>        # Reset stuck card
```

Common issues:
- **Pipeline halted** — check `sps card dashboard`, remove NEEDS-FIX label from failed card
- **Worker not starting** — check `sps worker ps`, verify API credentials
- **Cards stuck in Planning** — ensure cards have `AI-PIPELINE` label
