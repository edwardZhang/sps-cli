---
name: dev-worker
description: |
  Development worker skill profiles for SPS pipeline tasks. Activated when working on
  coding tasks with skill labels (skill:frontend, skill:backend, skill:phaser, etc).
  Provides role-specific coding standards, architecture patterns, and best practices. (🪸 Coral SPS)
---

# SPS Development Worker Skills

This skill provides role-specific coding expertise for SPS pipeline workers. Each reference file defines standards and patterns for a specific technology or role.

## Usage

When a task has a `skill:xxx` label, load the corresponding reference file and follow its rules strictly.

Available profiles:

| Label | Reference | Description |
|-------|-----------|-------------|
| `skill:frontend` | `references/frontend.md` | React/TypeScript UI development |
| `skill:backend` | `references/backend.md` | API, database, server-side logic |
| `skill:fullstack` | `references/fullstack.md` | End-to-end feature development |
| `skill:phaser` | `references/phaser.md` | Phaser 3 game development |
| `skill:typescript` | `references/typescript.md` | TypeScript-specific patterns |
| `skill:architect` | `references/architect.md` | System architecture and design |
| `skill:security` | `references/security.md` | Security audit and hardening |
| `skill:reviewer` | `references/reviewer.md` | Code review and quality audit |
| `skill:optimizer` | `references/optimizer.md` | Performance optimization |
| `skill:prototyper` | `references/prototyper.md` | Rapid prototyping |
| `skill:senior` | `references/senior.md` | Senior engineering practices |
| `skill:writer` | `references/writer.md` | Technical writing and documentation |

## Rules

1. Read the task prompt first to understand the requirement
2. If the task has skill labels, read the corresponding reference files from `references/`
3. Follow the coding standards and patterns defined in the reference
4. If multiple skills are specified, combine their rules (no conflicts — each covers different aspects)
5. If no skill label is present, use your best judgment for the technology stack
