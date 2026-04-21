#!/bin/bash
# SPS Pipeline Worker — UserPromptSubmit hook (v0.42.0+)
#
# Triggered synchronously before Claude processes each prompt. Used by SPS
# to label the card with STARTED-<stage> — this is the "ACK signal" that
# proves Claude received the prompt. Also injects skill hints based on the
# card's `skills` field (or legacy skill:* labels).
#
# Phase 2 is user-customizable: add audit logging, request rate limiting,
# prompt enrichment, etc. without touching Phase 1.
#
# Env vars (stable across claude process reuse):
#   SPS_PROJECT       Project name
#   SPS_WORKER_SLOT   Worker slot name
#
# Per-card info (card id, stage, title) is NOT in env — POSIX env freezes at
# spawn. Hook scripts must read the marker file instead. Phase 1 does this
# automatically via `sps hook user-prompt-submit`.

set -e

# ─── Phase 1: SPS official action (do NOT remove) ────────────────────
# Reads marker file → addLabel STARTED-<stage> + emit skill hints.
sps hook user-prompt-submit

# ─── Phase 2: User-customizable actions (edit as needed) ────────────

# Example: audit log of every prompt submission.
# if [ -n "$SPS_PROJECT" ] && [ -n "$SPS_WORKER_SLOT" ]; then
#   echo "$(date): prompt submitted to $SPS_PROJECT/$SPS_WORKER_SLOT" \
#     >> "$CLAUDE_PROJECT_DIR/.sps/user-prompts.log"
# fi

# Example: rate limiting (block if too many prompts in a window).
# count=$(find "$CLAUDE_PROJECT_DIR/.sps" -name 'last-prompt-*' -mmin -1 | wc -l)
# if [ "$count" -gt 30 ]; then
#   echo '{"decision":"block","reason":"rate limit exceeded (>30 prompts/min)"}'
#   exit 0
# fi

# Example: prompt-to-Slack mirror for team visibility.
# curl -sfX POST "$SLACK_WEBHOOK" -d "{\"text\":\"[$SPS_PROJECT] new prompt\"}"

exit 0
