---
name: sps-memory
description: |
  SPS persistent memory system — read and write project knowledge, user preferences,
  and agent experience across sessions. Proactively use when the user mentions remembering
  something, project conventions, past decisions, or when you discover important information
  worth persisting. (🪸 Coral SPS)
---

# SPS Memory System

You have a three-layer persistent memory system at `~/.coral/memory/`.
Use `cat` to read and `bash` to write. Use `mkdir -p` if a directory does not exist.

## Three Layers

### 1. User Memory (`~/.coral/memory/user/`)
Cross-project personal preferences. Shared across all projects and agents.
- Coding style, language preferences, workflow habits
- Example: "prefers Chinese comments", "uses strict TypeScript"

### 2. Agent Memory (`~/.coral/memory/agents/<session-name>/`)
Your personal experience as a daemon instance. Only you read this.
- User interaction patterns you've observed
- Pitfalls you've encountered
- Communication preferences specific to this user-agent relationship

### 3. Project Memory (`~/.coral/memory/projects/<project-name>/`)
Project-specific knowledge. Shared across all workers on this project.
- Conventions, architecture decisions, lessons learned, external references

To detect the current project, check if cwd matches any `PROJECT_DIR` in `~/.coral/projects/*/conf`.

## File Format

Each memory is a markdown file with YAML frontmatter:

```markdown
---
name: Short title
description: One-line summary for index search
type: convention | decision | lesson | reference
---

Content here. For decision/lesson types, include:
**Why:** reason
**Scope:** where this applies
```

## Index File (MEMORY.md)

Each memory directory has a `MEMORY.md` index. After writing a memory file, add one line:

```
- [Title](filename.md) — one-line description
```

## Memory Types

| Type | Decay | Use for |
|------|-------|---------|
| `convention` | Never | Project rules, coding standards, naming conventions |
| `decision` | Slow | Architecture choices, technology selections |
| `lesson` | 30 days | Pitfalls, debugging discoveries, things that went wrong |
| `reference` | Never | Links to external docs, tools, dashboards |

## When to Read

- At the start of a conversation or task, read the relevant MEMORY.md index
- Before making a recommendation that could conflict with past decisions
- When the user asks "do you remember" or references prior work

```bash
# Read project memory index
cat ~/.coral/memory/projects/<project>/MEMORY.md 2>/dev/null

# Read user preferences
cat ~/.coral/memory/user/MEMORY.md 2>/dev/null

# Read a specific memory file
cat ~/.coral/memory/projects/<project>/api-naming.md
```

## When to Write

- User states a project rule or preference → `convention`
- A technical choice is made or confirmed → `decision`
- Something unexpected happened or a workaround was found → `lesson`
- An external resource location is mentioned → `reference`
- You observe a user communication pattern → write to agent memory

Most conversations do NOT need memory. Only save non-obvious, future-useful information.

```bash
# Write a memory
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

# Update index
echo '- [API naming](api-naming.md) — camelCase for all REST endpoints' >> ~/.coral/memory/projects/my-project/MEMORY.md
```

## What NOT to Save

- Code structure, file paths (derivable from reading code)
- Git history (use `git log`)
- Temporary debugging state
- Anything already in CLAUDE.md or project docs

## CLI Commands

```bash
sps memory list <project>                  # Show memory index
sps memory context <project>               # Generate full memory context
sps memory add <project> --type convention --name "title" --body "content"
```
