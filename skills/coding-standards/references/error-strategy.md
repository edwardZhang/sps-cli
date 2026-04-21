# Error Strategy

When to raise, when to return a result, when to log, when to retry. Language-neutral decisions. For syntax (`try/except`, chaining, exception groups), see the language skill.

## The question tree

```
Is this an expected outcome?
  yes → return a result (Option, Result, ValidationResult, nullable)
  no ↓
Can this layer recover meaningfully?
  yes → catch specifically, handle, don't re-raise
  no ↓
Propagate. Let the edge (HTTP handler, CLI, worker) decide.
```

One sentence: **expected = data, unexpected = exception, recoverable = catch narrowly, else propagate.**

## Expected vs. exceptional

| Case | Treatment | Why |
|---|---|---|
| User input invalid | Return errors to the caller | User mistakes are expected; not exceptional |
| Item not found on lookup | Return `None` / `Option::None` | Missing is a normal outcome |
| DB connection dropped | Raise | Infrastructure failure; unexpected |
| Optimistic-lock version conflict | Raise a domain `ConflictError` | Expected under concurrency; caller decides retry |
| Programmer bug (null where not-null) | Raise (let it crash) | Hiding this creates a zombie system |

The dividing line: if it's part of the normal business flow, return data; if it breaks the flow, raise.

## Catch only what you can handle

```
# ❌ swallow-all
try:
    do_thing()
except Exception:
    pass              # now it looks fine; tomorrow something real is lost

# ❌ swallow-and-log (better, still bad if you can't recover)
try:
    do_thing()
except Exception as e:
    log.error("oops: %s", e)

# ✅ catch the specific type you know how to handle
try:
    return cache.get(key)
except CacheUnavailable:
    return source.load(key)      # real fallback

# ✅ the rest propagates
```

Rule: if catching doesn't let you recover, re-raise. The higher layer knows what to do.

## Exception hierarchy

Per service / module, one base, several subclasses for kinds of failure.

```
AppError (base)
├── ValidationError        # 4xx-ish
├── NotFoundError          # 404
├── ConflictError          # 409
├── AuthError              # 401/403
└── ExternalServiceError   # 502/503
```

- The edge (HTTP handler) maps `NotFoundError` → 404, `AuthError` → 401, etc. One translation layer, not scattered throughout the app.
- Never leak framework exceptions (`SQLAlchemyIntegrityError`, `httpx.TimeoutException`) above the adapter. Translate at the adapter boundary into domain errors.

## Preserve the cause

When re-raising as a different type, chain the original so the traceback still makes sense. Every language has a form of `raise new from original`. Use it.

```
try:
    response = http.get(url)
except NetworkTimeout as e:
    raise ExternalServiceError("pricing down") from e
```

Losing the cause makes incidents take twice as long to diagnose.

## Result / Option types

Some languages (Rust, Kotlin, Swift, Haskell) prefer typed results over exceptions. The calculus is the same, syntax differs:

```
# Result-style
fn find_user(id: UserId) -> Result<User, FindError>

match find_user(id):
    Ok(user) -> ...
    Err(FindError::NotFound) -> ...
    Err(FindError::DbDown) -> ...
```

In languages without sum types, the idiomatic equivalent is `Optional` for missing + exceptions for failure.

Don't fight the language. Use its native style.

## Validation — return data, don't raise

User-facing validation almost always returns data, not an exception. You want to collect *all* errors, not stop at the first.

```
result = validate(input)            # returns { ok: false, errors: [...] }
if not result.ok:
    return 422, result.errors
```

Reserve exceptions for truly exceptional validation — "the request doesn't even parse as JSON", for example.

## Retries — only at the right layer

Retries belong at the boundary that knows the call is retry-safe. Not inside a domain method, not sprinkled at every layer.

```
# ✅
edge → retrier(timeout=5s, attempts=3) → adapter → network

# ❌
adapter retries, service retries, handler retries
# → user waits 5× the timeout; retry storms on the dependency
```

See `backend/references/resilience.md` for retry patterns; this skill just says *where* the retry sits.

## Logging exceptions

Log at the layer that decided not to re-raise. Logging at every level produces log storms and duplicate reports.

```
# Bad — logged three times, same error
handler:   log.error(e); raise
service:   log.error(e); raise
adapter:   log.error(e); raise

# Good — log once, at the boundary
handler:  log.exception(...); return 500
service:  (no log, propagate)
adapter:  (no log, propagate)
```

Include context in the log (request id, user id, inputs), never the secret values.

## `finally` — for cleanup only

Use `finally` / equivalent for release-the-resource logic (close file, release lock, restore state). Never put business logic in `finally`; it runs even on errors.

```
# ✅
try:
    lock.acquire()
    do_critical_section()
finally:
    lock.release()

# ❌
try:
    submit_order()
finally:
    send_confirmation_email()       # sends even if submit failed
```

## Crash early, crash clearly

When an invariant breaks (null where not-null, state impossibility, config missing at boot), fail loudly at the earliest point. Don't try to "keep going".

```
# ✅ at boot
assert config.db_url, "DB_URL is required"

# ❌
db_url = config.db_url or "localhost"      # silently masked; prod points at localhost
```

A service that refuses to start is easier to fix than one that pretends to work.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `try: ... except: pass` | Catch specific, handle or re-raise |
| Converting exception into `return None` | Caller loses the "why" — expose the error |
| Re-raising with a new message but no `from` | Traceback becomes useless |
| Logging and re-raising at every layer | Log once, at the decider |
| Catching `Exception` at a tight scope | You don't actually know what can happen there |
| Control flow via exceptions (`raise StopIteration` to break a loop) | Use explicit flow |
| Different error shapes for similar failures | Pick one base + specific subclasses |
| Leaking adapter exceptions to the domain | Translate at the boundary |
