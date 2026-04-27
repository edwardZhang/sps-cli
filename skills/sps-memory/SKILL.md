---
name: sps-memory
description: |
  SPS persistent memory system — read and write project knowledge, user preferences,
  and per-agent observations across sessions. **Auto-injected into Worker prompts**
  by StageEngine (no manual fetch needed inside cards). Proactively use when the
  user mentions remembering something, project conventions, past decisions, or when
  you discover non-obvious information worth persisting. (🪸 Coral SPS, v0.51+)
---

# SPS Memory (v0.51 — auto-injected into Worker prompts)

A 3-layer markdown-on-disk persistence used to carry **non-obvious, reusable facts**
across sessions and across pipeline cards. Lives entirely under `~/.coral/memory/`;
each layer is a flat directory of `*.md` files plus a `MEMORY.md` index.

## When SPS injects this for you (pipeline mode)

When a card is dispatched, `StageEngine.buildStagePrompt` calls
`buildFullMemoryContext({ project, cardSeq })` and folds the result into the prompt's
`knowledge` section — **before** the task description. So inside a card, **you
already see relevant memory**; you don't need to `cat` it.

What you still need to do:
1. **Read more context if relevant** — the auto-inject only includes the headline
   index + recent items. To see a specific memory file, `cat` it.
2. **Write new memories when discovery happens** — covered below.

In `sps agent` (harness) mode, memory is **not** auto-injected. Use the `cat`
patterns at the bottom to pull what you need.

## Three layers

| Layer | Path | Scope | When to use |
|---|---|---|---|
| **User** | `~/.coral/memory/user/` | Cross-project preferences | Coding style, language, workflow habits ("prefers Chinese comments", "uses strict TypeScript") |
| **Agent** | `~/.coral/memory/agents/<agentId>/` | Per daemon instance / per-agent identity | User-interaction patterns you observed, communication preferences specific to this agent ↔ user pair |
| **Project** | `~/.coral/memory/projects/<project-name>/` | Per project | Conventions, architecture decisions, lessons learned, external resource pointers |

To detect which project the cwd belongs to: scan `~/.coral/projects/*/conf` for a
matching `PROJECT_DIR=`. Pipeline workers always know via `$SPS_PROJECT` env var.

## File format

```markdown
---
name: Short title
description: One-line summary (used by index + future fuzzy search)
type: convention | decision | lesson | reference
---

Body. For decision/lesson types, include:

**Why:** the reason / past incident driving this
**Scope:** where this applies (file glob, module, role, ...)
```

Filename = slugified `name` (lowercase, hyphens). The CLI does this for you; if
writing by hand, keep it under 50 chars.

## Memory types

| Type | Decay | Use for |
|---|---|---|
| `convention` | Never | Project rules, coding standards, naming conventions |
| `decision` | Slow | Architecture choices, technology selections |
| `lesson` | 30 days | Pitfalls, debugging discoveries, things that broke |
| `reference` | Never | Pointers to external dashboards, runbooks, dependencies |

`convention` and `reference` never expire; `decision` is auto-deprioritized after
months of no touch; `lesson` decays at 30 days unless re-read.

## Index file (`MEMORY.md`)

Each layer's directory has a `MEMORY.md` index — one line per memory file:

```markdown
- [API uses camelCase](api-naming.md) — All REST endpoints use camelCase
- [Auth middleware location](auth-middleware.md) — middleware/auth.ts; not in routes
```

After writing a memory file, **always** append (or update) one line in the
sibling `MEMORY.md`. The auto-injector reads `MEMORY.md` first to decide what to
load.

## When to read

- At the start of a card or task — auto-injected for you in pipeline mode
- Before answering a question that could conflict with prior decisions
- When the user says "do you remember", "we agreed", "我们之前说过"
- Before recommending a pattern that might violate a known convention

```bash
# Project memory index
cat ~/.coral/memory/projects/<project>/MEMORY.md 2>/dev/null

# User preferences (always-applicable)
cat ~/.coral/memory/user/MEMORY.md 2>/dev/null

# Specific memory file
cat ~/.coral/memory/projects/<project>/api-naming.md
```

## When to write

Only when **all** are true:
- The fact is **non-obvious** (not derivable from `git log`, code, or CLAUDE.md)
- It will be **reusable** across future sessions / cards
- It's **stable enough** to outlive the current task

Trigger words / situations:
| Situation | Type |
|---|---|
| User states a project rule or preference | `convention` |
| Architectural choice discussed and agreed | `decision` |
| Bug fixed where the root cause was sneaky / non-obvious | `lesson` |
| User points to an external dashboard, runbook, or repo | `reference` |
| You observe a user communication style worth keeping | agent-layer note |

**Most cards do NOT need memory.** If you're unsure → don't write. Memory is
expensive (read budget on every future card). Empty growth is worse than no
growth.

## Writing patterns

### Via CLI (recommended for project memories)

```bash
sps memory add <project> \
  --type convention \
  --name "API uses camelCase" \
  --description "All REST endpoints use camelCase naming" \
  --body "REST API endpoints use camelCase. No snake_case.\n\n**Why:** Frontend SDK auto-generates types from API schema."
```

The CLI:
- Slugifies name → filename
- Writes the file with proper frontmatter
- Appends/updates the line in `MEMORY.md`

### By hand (for user / agent layer)

```bash
mkdir -p ~/.coral/memory/projects/my-project
cat > ~/.coral/memory/projects/my-project/api-naming.md << 'EOF'
---
name: API uses camelCase
description: All REST endpoints use camelCase naming
type: convention
---

REST API endpoints use camelCase. No snake_case.
**Why:** Frontend SDK auto-generates types from API schema.
EOF

# Update index — keep entry one line, ≤ 100 chars
echo '- [API naming](api-naming.md) — camelCase for all REST endpoints' \
  >> ~/.coral/memory/projects/my-project/MEMORY.md
```

## What NOT to save

- **Code structure / file paths** — derivable from `Read` / `Glob`
- **Git history / blame** — use `git log`
- **Temporary debugging state** — use the conversation
- **Anything already in CLAUDE.md or `docs/`** — don't duplicate
- **Card or task state** — that's runtime, not knowledge
- **Wiki content** — if it belongs in structured knowledge (modules / decisions /
  lessons cross-linked), use the **wiki-update skill** instead. Memory is for
  ad-hoc / personal facts; Wiki is for structured project knowledge with
  cross-references and 5-layer prompt injection.

## CLI commands

```bash
sps memory list <project>                  # show project memory index
sps memory list                            # global view (user)
sps memory list --agent <agentId>          # include agent layer

sps memory context <project>               # ★ preview full inject (debug)
sps memory context <project> --card <seq>  # card-scoped (matches Worker prompt)

sps memory add <project> \
  --type convention \
  --name "title" \
  --description "one-line summary" \
  --body "content"
```

## Memory vs Wiki — pick the right tool

| Need | Use |
|---|---|
| User said "remember I prefer ..." | Memory (`user` or `project` layer) |
| Decision recorded in a card review | Could be either; prefer **wiki/decisions/** if it's about the project's architecture (linkable, surfacable to all future cards), memory for personal/team workflow choices |
| Bug fix with non-obvious root cause | **wiki/lessons/** (cross-linked, structured) — memory `lesson` is fallback when wiki not enabled |
| Module purpose / API contract summary | **wiki/modules/** |
| External dashboard URL | Memory `reference` |
| Personal coding style note | Memory (`user`) |

**Wiki requires `WIKI_ENABLED=true` in project conf** (v0.51+). When wiki is on,
prefer it for project-level structured knowledge — it gets cross-references,
linting, and 5-layer prompt injection. Memory remains the right place for ad-hoc
flat facts and personal preferences.

## Honesty rules

- Don't invent memories. Only write what the user said or you genuinely discovered.
- Don't echo what's already in `MEMORY.md` index.
- If a memory turns out wrong later, **edit or delete it** — don't pile a
  contradiction on top.
- Stale `lesson` (>30 days, no recent reference) — feel free to delete or
  promote to `convention` if it's hardened into project rule.
