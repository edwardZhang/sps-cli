#!/bin/bash
# SPS Pipeline Worker — Stop hook
#
# Triggered when Claude finishes its current turn. The pipeline depends on
# Phase 1 to advance card state. Phase 2+ is user-customizable.
#
# Env vars (set by SPS worker at spawn time, frozen for the process lifetime):
#   SPS_PROJECT       Project name (stable across card reuse)
#   SPS_WORKER_SLOT   Worker slot name (stable across card reuse)
#
# These two env vars form the index to locate the per-slot marker file:
#   ~/.coral/projects/$SPS_PROJECT/runtime/worker-$SPS_WORKER_SLOT-current.json
#
# Per-card info (card id, stage name, card title) is intentionally NOT in env.
# POSIX freezes env at spawn; when the claude process is reused for the next
# card, any per-card env would go stale. Always read the marker file (or use
# `sps` CLI) to get current card information.
#
# Claude-native env also available:
#   CLAUDE_PROJECT_DIR, CLAUDE_SESSION_ID

set -e

# ─── Phase 1: SPS official action (do NOT remove) ────────────────────
# Mark the card complete so pipeline can advance state.
# We call mark-complete WITHOUT a seq — the command reads the per-slot
# current-card marker file (written by the worker manager on each dispatch)
# to get the authoritative current card. This is the only way to be correct
# when the same claude process handles multiple cards in sequence.
if [ -n "$SPS_PROJECT" ] && [ -n "$SPS_WORKER_SLOT" ]; then
  sps card mark-complete "$SPS_PROJECT"
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
