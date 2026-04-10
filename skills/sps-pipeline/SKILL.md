---
name: sps-pipeline
description: |
  SPS pipeline management — create YAML configs, manage task cards, start/stop pipelines,
  memory system, and monitor worker status. Use when asked to "create a pipeline", "set up a project",
  "add tasks", "start the pipeline", "check pipeline status", or manage SPS workflow.
  Proactively use when the user discusses project setup, task planning, or CI/CD automation. (🪸 Coral SPS)
---

# SPS Pipeline Management (v0.37.0 — Single Worker Model)

Manage the full lifecycle of SPS development pipelines: project setup, YAML configuration, task cards, memory system, and pipeline execution.

## Interactive Pipeline Creation

When the user asks to create a pipeline, set up a project, or configure YAML, follow this guided flow:

### Step 1: Gather project info

Ask the user:
1. **项目名称** — 用于 SPS 内部标识（如 `my-app`）
2. **代码仓库路径** — 本地路径（如 `~/projects/my-app`）
3. **Git 远程仓库** — GitLab/GitHub 项目路径（如 `user/my-app`），留空则跳过
4. **合并目标分支** — 默认 `main`
5. **PM 后端** — `markdown`（本地文件，零配置）/ `plane` / `trello`

### Step 2: Design the pipeline stages

Ask the user:
1. **项目类型** — 是否需要 git（代码开发 = git: true，文档/数据处理 = git: false）
2. **你的开发流程有几个阶段？** 常见选择：
   - **简单**（1 stage）：处理完直接 Done
   - **标准**（2 stages）：开发 → 合并（git）/ 提取 → 汇总（非 git）
   - **完整**（3+ stages）：开发 → Code Review → 测试 → 合并
3. **每个阶段用什么 Agent？** — `claude`（默认）/ `codex` / `gemini`
4. **需要什么 skill profile？** — 如 `frontend`、`backend`、`tax-worker`（可选）
5. **最大并发 Worker 数？** — 默认 `1`

**If git: false:**
- All stages MUST use `completion: exit-code` (no git-evidence or fast-forward-merge)
- Workers operate directly in PROJECT_DIR, no branch/worktree isolation
- Recommend MAX_CONCURRENT_WORKERS=1 or task-specific subdirectories to avoid conflicts

### CRITICAL: State Chain Rules

When generating multi-stage YAML, follow these rules strictly:

1. **Each stage's `on_complete` MUST point to the NEXT stage's `trigger` state** — never skip stages, never loop back to the same state
2. **Each stage MUST have a unique `card_state`** — no two stages share the same active state
3. **The last stage's `on_complete` MUST be `"move_card Done"`**
4. **The last stage SHOULD have `queue: fifo`** and `completion: fast-forward-merge` for safe merging
5. **States flow in one direction**: Ready → Stage1Active → Stage2Active → ... → Done

Example state chain for 3 stages:
```
Ready → [develop] Inprogress → [code-review] CodeReview → [integrate] QA → Done
         trigger    card_state    trigger       card_state    trigger   card_state
```

WRONG patterns to avoid:
- `on_complete: "move_card Done"` on a non-last stage (skips remaining stages)
- `trigger: "card_enters 'Done'"` (Done is the terminal state, never trigger from it)
- Two stages with same `card_state: QA` (ambiguous, both stages compete)

### Step 3: Generate and deploy

Based on the answers:
1. Run `sps project init <name>` if project doesn't exist
2. Generate the pipeline YAML file at `~/.coral/projects/<name>/pipelines/project.yaml`
3. Update project conf at `~/.coral/projects/<name>/conf`
4. Run `sps doctor <name> --fix` to validate
5. Show the user the generated YAML and explain each section

### Pipeline YAML location

The YAML file lives in `~/.coral/projects/<name>/pipelines/`:
```
~/.coral/projects/<name>/
└── pipelines/
    └── project.yaml    ← pipeline definition
```

### Example conversation

User: "帮我创建一个新项目的 pipeline"

Agent flow:
1. Ask project name and repo path
2. Ask how many stages they want
3. Ask agent preference
4. Generate YAML + conf
5. Run doctor to validate
6. Show next steps (add cards, start pipeline)

---

## Quick Reference

### Project Setup

```bash
# Install SPS CLI
npm install -g @coralai/sps-cli

# Initial setup (creates directories, installs skills, configures credentials)
sps setup

# Initialize a new project
sps project init <project-name>

# Edit project config
vim ~/.coral/projects/<project-name>/conf

# Health check
sps doctor <project-name> --fix
```

### Pipeline YAML Configuration

Create `.sps/pipelines/<name>.yaml` in the project repo. Minimum viable config (1 stage):

```yaml
mode: project

states:
  backlog: Backlog
  ready: Todo
  done: Done

stages:
  - name: develop
    trigger: "card_enters 'Todo'"
    card_state: Inprogress
    agent: claude
    completion: git-evidence
    on_complete: "move_card Done"
```

Multi-stage example (any number of stages):

```yaml
mode: project

states:
  backlog: Backlog
  ready: Ready
  done: Done

stages:
  - name: develop
    trigger: "card_enters 'Ready'"
    card_state: Active
    agent: claude
    profile: fullstack
    completion: git-evidence
    on_complete: "move_card CodeReview"
    on_fail:
      action: "label NEEDS-FIX"
      comment: "Development worker failed."

  - name: code-review
    trigger: "card_enters 'CodeReview'"
    card_state: CodeReview
    agent: claude
    profile: reviewer
    completion: exit-code
    on_complete: "move_card QA"

  - name: integrate
    trigger: "card_enters 'QA'"
    card_state: QA
    agent: claude
    completion: fast-forward-merge
    on_complete: "move_card Done"
    queue: fifo
```

Only 3 fixed state roles required (backlog/ready/done). All intermediate states come from each stage's `card_state` and `on_complete`.

### Pipeline Switching

```bash
sps pipeline list
sps pipeline use <project> <pipeline-name>
```

### Card Management

```bash
sps card add <project> "Task title" --desc "Description"
sps card dashboard <project>
sps reset <project> <seq1> <seq2> ...
```

### Pipeline Execution

```bash
# Start continuous pipeline
sps tick <project>
# or: sps pipeline start <project>

# Stop pipeline
sps stop <project>

# Check status
sps status
```

### Worker Monitoring

```bash
sps worker ps <project>
sps worker kill <project> <seq>
sps worker dashboard <project>
```

### Memory System

Three-layer persistent memory at `~/.coral/memory/`:

```bash
# View memory index
sps memory list <project>

# Generate memory context for prompt injection
sps memory context <project>

# Add memory entries
sps memory add <project> --type convention --name "API naming" --body "Use camelCase"
sps memory add <project> --type decision --name "Use PostgreSQL" --body "Concurrent writes needed"
sps memory add <project> --type lesson --name "Migration order" --body "Schema first, then data"
sps memory add <project> --type reference --name "Design docs" --body "figma.com/file/..."
```

Types: `convention` (no decay), `decision` (slow decay), `lesson` (30-day decay), `reference` (no decay).

Workers receive memory in their prompt and can write new memories directly to `~/.coral/memory/projects/<name>/`.

### Skill Management

```bash
sps skill sync
```

## Architecture (Single Worker Model)

```
SchedulerEngine (orchestration)
  → Backlog cards with AI-PIPELINE label → Ready

StageEngine × N (serial execution)
  → Single worker processes one card at a time
  → Each stage: launch worker → wait completion → move card
  → Worker runs directly in PROJECT_DIR (no worktree/branch)
  → Failure halts pipeline until resolved

MonitorEngine (monitoring)
  → Worker health check
```

## Failure Handling

- Card fails → mark NEEDS-FIX → pipeline halts (halt: true)
- Retry up to N times (retryCount in card frontmatter)
- All retries exhausted → halt, wait for manual fix
- Remove NEEDS-FIX label to resume

## Card State Flow

```
Planning → Backlog → Ready → [Stage 1] → [Stage 2] → ... → Done
                                ↓ fail
                          NEEDS-FIX (halt)
```

## Key Config Fields (conf)

| Field | Description | Example |
|-------|-------------|---------|
| `PROJECT_NAME` | Project identifier | `my-project` |
| `PROJECT_DIR` | Repository path | `~/projects/my-project` |
| `GITLAB_PROJECT` | Git remote project path | `user/repo` |
| `GITLAB_MERGE_BRANCH` | Merge target branch | `main` |
| `PM_TOOL` | PM backend | `plane` / `trello` / `markdown` |
| `WORKER_TOOL` | Default AI agent | `claude` / `codex` |
| `MAX_CONCURRENT_WORKERS` | Max parallel workers | `1-5` |

## Card Labels

| Label | Purpose |
|-------|---------|
| `AI-PIPELINE` | Marks card for pipeline processing (required) |
| `skill:xxx` | Load specific skill profile for worker |
| `conflict:xxx` | Conflict domain (same domain = serial execution) |
| `NEEDS-FIX` | Worker failed, needs manual fix |
| `BLOCKED` | External dependency blocking |

## Troubleshooting

```bash
sps doctor <project> --fix
sps logs <project>
ls ~/.coral/projects/<project>/logs/acp-stderr-*.log
sps reset <project> <seq>
```
