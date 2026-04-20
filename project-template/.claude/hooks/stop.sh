#!/bin/bash
# SPS Pipeline Worker — Stop hook
#
# Triggered when Claude finishes its current turn. The pipeline depends on
# Phase 1 to advance card state. Phase 2+ is user-customizable.
#
# Env vars (set by SPS worker at spawn time):
#   SPS_PROJECT       Project name (matches ~/.coral/projects/<name>/)
#   SPS_CARD_ID       Card sequence number
#   SPS_CARD_TITLE    Human-readable card title (optional)
#   SPS_STAGE         Pipeline stage name (develop, qa, integrate, ...)
#   SPS_WORKER_SLOT   Worker slot (worker-1, ...)
#
# Claude-native env also available:
#   CLAUDE_PROJECT_DIR, CLAUDE_SESSION_ID

set -e

# ─── Phase 1: SPS official action (do NOT remove) ────────────────────
# Mark the card complete so pipeline can advance state.
if [ -n "$SPS_PROJECT" ] && [ -n "$SPS_CARD_ID" ]; then
  sps card mark-complete "$SPS_PROJECT" "$SPS_CARD_ID"
fi

# ─── Phase 2: User-customizable actions (edit as needed) ────────────

# Example: record the session transcript location for later audit.
# if [ -n "$CLAUDE_SESSION_ID" ] && [ -n "$SPS_CARD_ID" ]; then
#   echo "$CLAUDE_SESSION_ID" >> "$CLAUDE_PROJECT_DIR/.sps/session-log.txt"
# fi

# Example: third-party knowledge base capture.
# if command -v your-kb-cli &>/dev/null; then
#   your-kb-cli capture --project "$SPS_PROJECT" --session "$CLAUDE_SESSION_ID"
# fi

# Example: notify on completion.
# sps notify matrix "[$SPS_PROJECT] seq $SPS_CARD_ID ($SPS_STAGE) done"

# Example: post-task CI trigger.
# curl -sfX POST "$CI_WEBHOOK" -d "{\"project\":\"$SPS_PROJECT\",\"card\":\"$SPS_CARD_ID\"}"

exit 0
