#!/usr/bin/env bash
# batch_scheduler.sh — project-local cron entry point
# Delegates to the unified workflow CLI tick command.
# All scheduling, pipeline, QA, and monitor logic lives in the Node CLI.
set -euo pipefail

PROJECT_NAME="$(basename "$(cd "$(dirname "$0")" && pwd)")"
WORKFLOW_CLI="$HOME/jarvis-skills/coding-work-flow/bin/workflow"

exec "$WORKFLOW_CLI" tick "$PROJECT_NAME" "$@"
