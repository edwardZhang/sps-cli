# @coralai/sps-cli

AI-driven development pipeline orchestrator. Automates the full development lifecycle from task creation to code merge and deployment.

## Install

```bash
npm install -g @coralai/sps-cli
```

Requires Node.js >= 18.

## Usage

```bash
sps <command> [subcommand] <project> [options]
```

### Commands

| Command | Description | Usage |
|---------|-------------|-------|
| `tick` | Run continuous pipeline | `sps tick <project> [--once]` |
| `card` | Card management | `sps card add <project> "<title>" ["desc"]` |
| `doctor` | Project health check | `sps doctor <project> [--json] [--skip-remote]` |
| `scheduler` | Planning → Backlog promotion | `sps scheduler <tick\|inspect\|validate> <project>` |
| `pipeline` | Execution chain (Backlog → Todo → Inprogress) | `sps pipeline <tick\|inspect> <project>` |
| `worker` | Worker lifecycle management | `sps worker <launch\|release\|inspect> <project> [seq\|slot]` |
| `pm` | PM backend operations | `sps pm <scan\|move\|comment\|checklist> <project> [args...]` |
| `qa` | QA / closeout (QA → merge → Done) | `sps qa <tick\|inspect> <project>` |
| `monitor` | Anomaly detection and diagnostics | `sps monitor <tick\|inspect-worker\|inspect-card> <project>` |
| `project` | Project init and validation | `sps project <init\|doctor\|validate\|paths> <project>` |

### Global Options

- `--json` — Output structured JSON
- `--dry-run` — Preview actions without executing
- `--help` — Show help
- `--version` — Show version

## Quick Start

```bash
# Initialize a new project
sps project init my-project

# Run health check
sps doctor my-project

# Add a task card
sps card add my-project "feat: implement user auth" "Add JWT-based authentication"

# Run pipeline (single tick)
sps tick my-project --once

# Run pipeline (continuous)
sps tick my-project
```

## Multi-Project Support

Run multiple projects in a single process:

```bash
sps tick project-a project-b project-c
```

Each project is fully isolated with its own context, providers, engines, lock, and state. One project's error does not affect others.

## Architecture

SPS orchestrates a state machine pipeline:

```
Backlog → Todo → InProgress → QA → Done
```

### Supported Backends

- **Task Management**: Trello, Plane, Markdown
- **Repository**: GitLab
- **Workers**: Claude Code, OpenAI Codex
- **Notifications**: Matrix

## Configuration

Projects are configured via `~/.projects/<name>/conf`. Run `sps project init <name>` to generate a template.

## License

MIT
