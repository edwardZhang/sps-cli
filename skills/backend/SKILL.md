---
name: backend
description: Backend end skill — API design, layering, data access, caching, auth, resilience, observability. Language-neutral. Combine with a language skill (`python`, `typescript`, `golang`, etc.) for syntax, and with persona skills (`backend-architect`, `database-optimizer`) for mindset.
origin: ecc-fork + original (https://github.com/affaan-m/everything-claude-code, MIT)
---

# Backend

Server-side architecture patterns. **Language-neutral by design** — examples use pseudocode or diagrams, never a specific language. Pair with a language skill for idiomatic implementation.

## When to load

- Designing or reviewing server-side code (API, service, worker)
- Deciding layering (repository, service, controller, domain)
- Data access: queries, transactions, migrations, N+1, connection pooling
- Caching, queuing, background jobs
- Authentication, authorization, rate limiting, input validation
- Resilience: retries, timeouts, circuit breakers, idempotency
- Observability: structured logging, metrics, traces, health checks

## Core principles

1. **Keep the domain ignorant of infrastructure.** Business logic doesn't import HTTP, DB drivers, or queues directly — those cross the boundary through interfaces.
2. **The caller should be able to swap the implementation.** If you can't replace the DB with an in-memory fake in tests, your layering is wrong.
3. **Every write is either idempotent or transactional.** Retries must be safe.
4. **Input validation happens at the edge.** Once data is inside the domain, it is trusted.
5. **Timeouts on every outbound call.** No unbounded network wait. Ever.
6. **Never log secrets, tokens, PII.** Redact at the logger, not at the call site.
7. **Observability is not optional.** A request you can't trace is a bug you can't fix.
8. **Errors cross the boundary as data, not as exceptions.** The HTTP layer decides status codes; the domain raises domain errors.

## How to use references

| Reference | When to load |
|---|---|
| [`references/api-design.md`](references/api-design.md) | REST/GraphQL/gRPC conventions, versioning, error format, pagination |
| [`references/layering.md`](references/layering.md) | Repository / service / controller, hexagonal, dependency direction |
| [`references/data-access.md`](references/data-access.md) | Transactions, N+1, migrations, connection pooling |
| [`references/caching.md`](references/caching.md) | Cache-aside, write-through, TTL, invalidation, stampede protection |
| [`references/security.md`](references/security.md) | AuthN vs authZ, sessions vs tokens, RBAC, rate limiting, input validation |
| [`references/resilience.md`](references/resilience.md) | Retries, timeouts, circuit breakers, idempotency, background jobs |
| [`references/observability.md`](references/observability.md) | Structured logging, metrics, traces, health checks, correlation IDs |

## Language binding

This skill has no language-specific content. For concrete syntax:

- Python backend → load `python` + this skill
- TypeScript/Node → load `typescript` + this skill
- Go → load `golang` + this skill
- etc.

## Forbidden patterns (auto-reject)

- Business logic that imports HTTP request/response objects directly
- DB queries issued from controllers (bypass the repository)
- Outbound HTTP / DB call with no timeout
- Writes that aren't idempotent AND aren't in a transaction
- Secrets or tokens in logs
- Unvalidated input reaching the domain layer
- Catch-all `500 Internal Server Error` as the only error response
- Silent swallowing of background-job failures (no dead-letter, no alert)
