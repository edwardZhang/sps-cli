---
name: architecture-decision-records
description: Workflow skill — write, review, and maintain ADRs. Capture the *why* behind technical decisions so future readers don't re-litigate them.
origin: ecc-fork (https://github.com/affaan-m/everything-claude-code, MIT)
---

# Architecture Decision Records (ADRs)

Short, versioned documents capturing a single technical decision: what we decided, why, and what we'd need to reconsider it.

## When to load

- Making a technical decision with non-trivial reach (affects multiple teams / components / for > 6 months).
- Introducing a new technology, service, pattern.
- Deprecating a significant piece of infrastructure.
- Reviewing someone's proposed ADR.
- Wondering "why do we do X?" and finding no record.

## Why ADRs matter

A codebase without ADRs has this conversation every six months:

> "Why are we using Kafka here? MQ would be simpler."
> "I think… performance? I wasn't here when we decided."

The decision gets made again, people compromise on different tradeoffs, the choice drifts. An ADR records the decision while the context is fresh, so the next discussion starts from facts, not vibes.

## Anatomy of an ADR

```
# ADR-0007: Adopt Postgres as the primary OLTP store

Date: 2026-04-21
Status: Accepted
Deciders: Alice (CTO), Bob (Staff Eng), Carol (Platform)

## Context

We need a primary OLTP store for the new user service. Current options
considered: Postgres, MySQL, DynamoDB, CockroachDB.

Constraints:
- Must run in both AWS and on-prem (current requirement from Customer X).
- Expect 10k QPS peak, 1 TB at year 2.
- Team has strong Postgres experience; no DynamoDB experience.
- Budget constraint: self-hosted preferred over managed where reasonable.

## Decision

Adopt Postgres 16 as the primary OLTP store for the user service,
managed via RDS in AWS and self-hosted on-prem.

## Consequences

Positive:
- Team already fluent; hiring pool large.
- JSONB + strong relational semantics covers 95% of our model.
- Rich ecosystem (partitioning, logical replication, extensions).

Negative:
- Horizontal scaling requires sharding (future problem if we grow past
  a single-instance + read-replica topology).
- Less native cloud integration than DynamoDB on AWS.

## Alternatives considered

- MySQL: team less familiar; similar capability otherwise.
- DynamoDB: no on-prem story, access-pattern-locked schema design.
- CockroachDB: stronger horizontal scaling; team has no ops experience.

## Reconsider if

- We need genuine multi-region write active/active.
- On-prem requirement is dropped.
- Operational burden of sharding exceeds the effort to migrate.

## Related
- ADR-0003 (record why we split auth from user service)
- ADR-0005 (picked AWS as primary cloud)
```

## Structure — keep it short

Sections:

1. **Context** — the situation and constraints.
2. **Decision** — one paragraph. What we're doing.
3. **Consequences** — positive + negative + neutral effects.
4. **Alternatives considered** — what else we weighed.
5. **Reconsider if** — conditions that should trigger a revisit.
6. **Related** — links to prior ADRs, docs, tickets.

Two pages max. ADRs that bloat into design docs stop getting read.

## Numbering & status

Sequential: `ADR-0001-...md` in `docs/adr/` or similar. Status:

| Status | Meaning |
|---|---|
| **Proposed** | Up for review |
| **Accepted** | Approved and in effect |
| **Rejected** | Considered, not adopted |
| **Deprecated** | No longer applied; kept for history |
| **Superseded by ADR-XXXX** | Replaced; link the successor |

Don't edit accepted ADRs. Write a new one that supersedes, and update the old one's status to `Superseded by ADR-NNNN`.

## When to write one

Rule of thumb: if someone will ask "why did we do this?" in six months, there should be an ADR.

Triggers:
- Adopting or replacing infrastructure (DB, queue, cache, build tool).
- Choosing a communication style (REST vs. gRPC, sync vs. async).
- Non-obvious architectural constraints (single-writer model, tenant isolation scheme).
- Significant policy: code style, review rules, SLO definitions.
- Deprecations and removals.

Don't write one for:
- Naming a variable.
- Choosing an icon size.
- Local refactors without reach beyond the file.

## The review

Treat an ADR like a PR. Open it for comment with `Status: Proposed`. Reviewers focus on:
- Are the constraints accurate?
- Are the alternatives real alternatives?
- Are the consequences honest (including the painful ones)?
- Is the "reconsider if" section a real re-opener?

Timebox the review — ADRs that linger in review lose momentum. A week is usually enough.

## Who writes / approves

- **Author**: the engineer proposing or doing the work.
- **Reviewers**: peers, tech lead, any team directly affected.
- **Approver**: usually the senior engineer / architect responsible for the area. One approver is enough; more than three is a committee.

## Living with ADRs

The document isn't the point — the decision is. Refer to ADRs in:

- PR descriptions ("This implements the approach in ADR-0012").
- Onboarding docs ("Our conventions live in `docs/adr/`").
- Incident postmortems (when a decision's tradeoff bit).

A directory of ADRs is the most compact onboarding material you can give a new engineer.

## Tools

Minimal stack:
- `docs/adr/NNNN-short-title.md` in the repo.
- A script or `adr-tools` / `log4brains` for numbering.
- Index file listing all ADRs and statuses.

Heavier options (Confluence, Notion) work, but markdown-in-repo wins for:
- Version control (the decision is versioned with the code that enacts it).
- Easy diff when an ADR is updated.
- No hunting across multiple surfaces.

## What a good ADR feels like

- A reader can decide "should I care about this?" from the title + first sentence.
- A new hire reading it a year later can understand the choice without asking.
- The "reconsider if" section is specific enough that an engineer in 2028 knows when to revisit.

## What a bad ADR looks like

- Title: "ADR-12: Kafka" (no decision; no context).
- 15 pages describing the system in full, decision buried on page 9.
- No alternatives. No constraints. Reads like a sales pitch for the chosen option.
- No "reconsider if" — the decision looks eternal.
- Written after the decision was shipped, recast to fit what was built.

## Tradeoffs to always name

- **Write now vs. write later**: writing during the decision takes 30 min; reconstructing it a year later takes hours and produces lies.
- **Rigor vs. effort**: short-and-honest beats long-and-idealized.
- **Formal vs. casual process**: start casual; formalize as the org grows.
- **Centralized vs. team-local ADRs**: team-local for team-scoped decisions; central for cross-team.

## Common failure modes

| Failure | Why |
|---|---|
| No ADRs written | Decisions get re-litigated; tribal knowledge rots |
| ADRs written but ignored | Not linked from PRs / docs; unfindable |
| ADRs written post-hoc to justify | Lose the "we considered X and Y" honesty |
| ADRs that are 20 pages | Nobody reads them; collapse to summary |
| ADRs that keep getting edited | Write a new one that supersedes |
| "ADR" that just says "we'll use X" | Decision without context / alternatives / consequences |

## Anti-patterns

- Writing an ADR to lock down a decision that hasn't actually been discussed.
- Using ADRs as RFC-lite without a clear question and clear options.
- Updating an accepted ADR to change the decision — write a new superseding ADR.
- Endless review cycles (> 2 weeks) — call consensus and accept; iterate if reality disagrees later.
- Hiding ADRs in Confluence under three levels of navigation — in the repo is best.
- Treating ADRs as permission — the ADR records a decision, it doesn't replace engineering judgment on specifics.

## Pair with

- [`coding-standards/references/code-review.md`](../coding-standards/references/code-review.md) — review discipline.
- [`backend-architect`](../backend-architect/SKILL.md) — the role that most often drives ADRs.
