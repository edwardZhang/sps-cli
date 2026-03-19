#!/usr/bin/env bash
# batch_scheduler.sh — project-local cron entry point
# Delegates to the SPS CLI tick command.
set -euo pipefail

PROJECT_NAME="$(basename "$(cd "$(dirname "$0")" && pwd)")"

exec sps tick "$PROJECT_NAME" "$@"
