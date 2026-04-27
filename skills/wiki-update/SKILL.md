---
name: wiki-update
description: |
  SPS Wiki maintenance — ingest source diffs into structured pages, cross-reference,
  and keep the knowledge base coherent. Single source of truth for the SOP that
  Worker follows when "wiki update" runs (per card completion or via `sps wiki update`).
  Triggers on: "ingest source", "wiki update", "update wiki", "process wiki sources",
  "add to wiki", "lesson from this card", "decision from this design". (🪸 Coral SPS)

  Attribution: ~70% of the SOP is adapted from claude-obsidian/skills/wiki-ingest
  (MIT, https://github.com/kepano/claude-obsidian). 30% is SPS-specific:
  the 4-question entry filter, the 5 page types, sources={card:N|commit:hash},
  and the `sps wiki check` exit gate. See ATTRIBUTION.md.
allowed-tools: Read Write Edit Glob Grep Bash
---

# wiki-update — SPS Knowledge Maintenance

You are a knowledge architect inside an SPS pipeline. The wiki is a persistent,
cross-referenced artifact that compounds with every card the team finishes.
You don't dump source content; you **distill** facts, decisions, and lessons
into atomic, linkable pages.

This SKILL is the **single source of truth** for "what to write to the wiki."
CLAUDE.md only points here. Don't duplicate rules between the two files.

---

## When to invoke this skill

Two paths can trigger it:

1. **Manual** — user runs `sps wiki update <project>` and reads the diff.
2. **Auto** — at card completion, the StageEngine appends a wiki-update
   prompt to the Worker's session (no new ACP call).

In both cases your job is the same: read what changed, decide what to write,
keep the wiki coherent.

---

## The 4-Question Entry Filter

**Before writing anything**, answer these for the trigger that brought you here:

1. **Did a module change?** → write/update a `module/` page.
2. **Was a non-trivial decision recorded?** → write a `decision/` page.
3. **Did a bug or gotcha surface?** → write a `lesson/` page.
4. **Is there a recurring pattern worth naming?** → write a `concept/` page.

If none of the four hit: **don't write**. Empty wiki growth is worse than no
growth — every page is a future read budget cost. Add to `.hot.md` only if
context is recent and relevant; otherwise just append a `.log.md` entry.

---

## What to read first (context discipline)

Token budget matters. Follow this order on every invocation:

1. `wiki/.hot.md` — ~500-char recent context. If this answers your question, stop.
2. `wiki/index.md` — find existing pages **before** creating new ones.
3. Run `sps wiki update <project>` — see the manifest diff (added/changed/removed).
4. Run `sps wiki list <project> --tag <skill>` — find related pages by tag.
5. Read at most **3-5** existing pages per ingest. If you need 10+, you're scoping
   too broadly. Split the work across cards.
6. Use `sps wiki get <project> <pageId>` for surgical reads.

Never read whole wiki dumps. Use Edit (not Write) for in-place updates.

---

## Page Anatomy (mandatory)

Every page has YAML frontmatter + a body. The body **must** start with `## TL;DR`
followed by 1-3 sentences. The TL;DR is what `sps wiki read` injects into Worker
prompts; the rest is read on demand.

```markdown
---
type: lesson | module | concept | decision | source
title: "Short Descriptive Name"
created: 2026-04-27
updated: 2026-04-27
tags: ["pipeline", "race-condition"]   # use existing tags first; minimum 1
status: developing | mature | evergreen | stale
related: ["[[modules/PipelineService]]", "[[concepts/Async-Stop-Hook]]"]
sources:
  - { card: "42" }                      # SPS card seq
  - { commit: "abc1234" }               # git commit hash
  - { path: "src/services/X.ts", hash: "<sha256>" }
generated: manual | auto | semi
# type-specific fields below — see schema per type
---

## TL;DR
One to three sentences. **Dense facts**, no fluff. This is what other Workers
will see in their prompt context.

## Body
Whatever the page needs. Cross-reference other pages with `[[type/Title]]`.
```

### Type-specific fields

- **module**: `module_path: "src/services/X.ts"` (required)
- **concept**: `complexity: basic|intermediate|advanced`, `domain: "..."`, optional `aliases: [...]`
- **decision**: `version: "v0.51.0"` (the version this decision shipped in), optional `superseded_by: "[[decisions/...]]"`
- **lesson**: `severity: critical|major|minor` (default major), optional `seen_in_cards: ["42", "67"]`
- **source**: `source_type: pdf|article|image|transcript|data|note|unknown`, `original_path: "wiki/.raw/..."`

The CLI validates frontmatter with zod. If you write something invalid, `sps
wiki check` will scream at you. Don't ship a card without running it.

---

## Wikilinks

Use `[[type/Title]]` form everywhere — frontmatter `related[]` and body prose.
Bare `[[Title]]` works (linter resolves by title) but typed form is safer when
two pages share a title across types.

**Forbidden**: external markdown links to wiki files (`[X](./modules/X.md)`).
Use wikilinks so renames don't break references.

---

## SPS-specific sources field

The `sources:` field in frontmatter is how a page traces back to its origin.
SPS pipelines have three kinds:

```yaml
sources:
  - { card: "42" }                                    # card that produced this knowledge
  - { commit: "abc1234" }                             # git commit at the time of writing
  - { path: "src/services/X.ts", hash: "<sha256>" }   # the file the page summarizes
```

**Rules**:
- A `lesson/` page from a card MUST include `{ card: "<seq>" }`.
- A `module/` page MUST include `{ path: "<module_path>", hash: ... }`. The
  hash is read from `wiki/.manifest.json` (auto-managed by `sps wiki update --finalize`).
- A `decision/` page SHOULD include the commit hash that shipped the decision.
- A `source/` page MUST point at its original file in `.raw/`.

You don't have to include every applicable source — just the strongest 1-3.

---

## Writing a page (the 8 steps)

When the entry filter says "write":

1. **Search first** — `sps wiki list <project> --tag <skill>` and `sps wiki read
   <project> "<query>"`. If a page exists that's close, **update** it; don't make
   a duplicate.
2. **Pick the type** — module / concept / decision / lesson / source. If you're
   not sure between concept and decision, ask: "is this an architectural choice
   we made?" → decision. "Is this a pattern we name?" → concept.
3. **Choose a Title** — short, distinctive, no version suffix (avoid
   "PipelineService v2", just "PipelineService").
4. **Pick tags** — reuse existing tags from `index.md` first. Minimum 1, max 5.
   Tags map to skills (per StageEngine); a page with no tags won't surface via
   skill-match retrieval.
5. **Write the TL;DR** — first thing after frontmatter. 1-3 dense sentences.
   This is the page's elevator pitch and what other Workers see.
6. **Write the body** — what's not in the TL;DR. Use sub-headings (`## Body`,
   `## Why`, `## How to apply`, etc). Keep it ≤ 300 lines. Split at 300+.
7. **Cross-reference** — every relevant `[[type/Title]]` link in body and
   `related[]`. Don't bloat with weak links; aim for 2-5 strong ones.
8. **Save** with `Write` tool (or `Edit` if updating). Path:
   `wiki/<type>s/<Title>.md` (note plural directory).

---

## Updating an existing page

Prefer **Edit** over Write. Surgical changes only:

- Bump `updated:` to today.
- If TL;DR changed, edit just that line.
- If you added a section, append it; don't rewrite the page.
- If status changed (e.g. `developing → mature`), update only that field.

Never overwrite with a full re-write unless the page is genuinely re-scoped.
Re-writes lose the git history of what was when.

---

## Contradictions

When new info contradicts an existing page, **don't silently overwrite**. Add a
callout on both pages:

```markdown
> [!warning] Conflicts with [[decisions/Use-Karpathy-Wiki]]
> [[decisions/Use-Karpathy-Wiki]] (2026-04-23) said pages should be 100-300 lines.
> This page argues for ≤200. Needs reconciliation; flagged for review.
```

If you're not sure which side wins, leave both flagged and keep going. The user
will resolve.

---

## After writing: index, hot, log, check

In this order:

1. **Update `wiki/index.md`** — add a row for the new page (or bump the entry).
   Title + TL;DR + tags. Keep alphabetical within the type section.
2. **Update `wiki/.hot.md`** — overwrite "Last Updated" with this card's
   summary; append to "Recent Changes" the new wikilinks. Keep total ≤ 500 chars.
3. **Append to `wiki/.log.md`** at the **top** (newest-first):
   ```markdown
   ## 2026-04-27T14:30:00Z · ingest · card #42
   Wrote [[lessons/Stop-Hook-Race]] from card #42 review.
   - Pages: [[lessons/Stop-Hook-Race]], [[modules/PipelineService]]
   ```
4. **Run `sps wiki check <project>`** — fix any errors before exiting. Warnings
   (orphans, missing TL;DR) can wait, but errors (dead links in `related[]`,
   empty title) MUST be resolved.
5. **(Optional)** `sps wiki update <project> --finalize` — flushes the manifest
   so the next `update` shows clean diff.

---

## Quality bar

A page is **publishable** when:

- TL;DR is dense (no "this page describes…").
- At least one strong cross-reference in `related[]`.
- All wikilinks resolve (no `[[Ghost]]`).
- Tags overlap with at least one skill or active card label.
- Body is ≤ 300 lines (split otherwise).
- Frontmatter passes `sps wiki check`.

A page is **not** publishable when:

- It restates source verbatim.
- It's a placeholder ("TODO: fill in").
- It links to nothing.
- It uses generic tags like `["misc", "general"]`.

If a draft fails any of these, fix it or don't ship.

---

## What NOT to do

- **Don't** read a whole `.raw/` source if `wiki/.hot.md` already covers it.
- **Don't** create a page per card. Many cards produce zero wiki pages — that's
  correct.
- **Don't** mass-rename pages. Wikilinks break and the manifest goes stale.
  Use the Bash tool for sed renames only when you've also updated `related[]`
  in every linker.
- **Don't** edit `.raw/` files. They're immutable sources.
- **Don't** edit `wiki/.manifest.json` by hand. Use `sps wiki update --finalize`.
- **Don't** skip `sps wiki check`. A broken wiki costs the team more than the
  card's value.

---

## CLI cheat sheet

```bash
# Discover what changed
sps wiki update <project>

# After writing pages, flush the manifest
sps wiki update <project> --finalize

# Lint before merging
sps wiki check <project>

# Inspect single page
sps wiki get <project> lessons/Stop-Hook-Race

# Filter list
sps wiki list <project> --type lesson --tag pipeline

# Drop external file into vault
sps wiki add <project> ~/notes.md --category transcripts

# Inject context into the next prompt (used by StageEngine)
sps wiki read <project> "<keyword>"
```

---

## Reference

This SOP is adapted from `claude-obsidian/skills/wiki-ingest` (MIT). The
SPS-specific bits — 4 page types, sources={card,commit}, `sps wiki check` gate,
5-layer reader integration — are from `docs/design/28-wiki-system.md`.

If you find this skill conflicting with `docs/design/28-wiki-system.md`, the
design doc wins. File a card to update this SKILL.md.
