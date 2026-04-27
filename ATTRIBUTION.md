# Attribution — SPS CLI

`@coralai/sps-cli` builds on prior open-source work. This file lists the
substantive borrows so future readers (and forks) can trace what came from
where.

## Wiki Knowledge Base (v0.51.0+)

The `sps wiki *` subsystem and the `skills/wiki-update/SKILL.md` SOP are
adapted from:

### claude-obsidian (MIT)

- Source: <https://github.com/kepano/claude-obsidian>
- Author: **kepano**
- Files we drew from: `skills/wiki/`, `skills/wiki-ingest/`, `skills/wiki-lint/`

Borrowed:
- Three-layer architecture (`.raw/` sources / `wiki/` generated / rule layer)
- Manifest-based delta tracking with sha256 per source
- Hot cache (`hot.md`) for recent context priming
- Single-source ingest workflow (read → cross-reference → file → log)
- Context-window discipline rules ("hot.md first, index second…")
- Contradiction callouts on conflicting claims
- Wikilink-only references between pages

Diverged for SPS:
- 5 page types (module / concept / decision / lesson / source) replace
  claude-obsidian's entities/concepts/sources/domains/comparisons
- `sources:` field accepts `{ card: N | commit: hash | path: ... }` so SPS
  cards trace into the wiki
- 5-layer reader (`hot.md / index / pinned / skill / keyword`) for
  prompt-time injection, instead of on-demand MCP reads
- `sps wiki check` lints + exit gate replaces the `wiki-lint` skill
- Plural type directories (`modules/`, `lessons/`, …)
- `WIKI_ENABLED` opt-in flag per project (claude-obsidian assumes always-on)

License: MIT — copy of original LICENSE retained at
`research/claude-obsidian/LICENSE` for reference.

### Andrej Karpathy — "LLM Wiki" gist

- Source: <https://gist.github.com/karpathy> (2024)

Borrowed: the mental model — atomic, dense, cross-linked pages populated by
the LLM via a structured workflow, with the wiki as a persistent compounding
artifact.

## Other dependencies

Runtime/dev deps are listed in `package.json` with their own licenses. Notable:

- `@agentclientprotocol/sdk` — Anthropic Claude ACP SDK
- `zod` — runtime schema validation
- `yaml` — YAML parser
- `hono` — console HTTP server
- `chokidar` — filesystem watcher

See `node_modules/<pkg>/LICENSE` for full terms.

## Conventions for forks

If you fork SPS-CLI and reuse the Wiki system, please:

1. Keep this `ATTRIBUTION.md` (or a derivative) at the repo root.
2. Keep the attribution comment at the top of `skills/wiki-update/SKILL.md`.
3. Keep the `ATTRIBUTION.md` template that `sps project init --wiki` drops
   into target repos (see `src/commands/projectInit.ts`).
