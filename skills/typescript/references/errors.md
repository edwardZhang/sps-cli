# TypeScript — Errors

Error classes, `Result` types, catch semantics. For general strategy (when to raise vs return, where to log), see `coding-standards/references/error-strategy.md`.

## Custom error classes

Subclass `Error`. Always set `name`. Use `cause` to chain.

```ts
export class AppError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  constructor(public issues: { path: string; message: string }[]) {
    super('validation failed');
    this.name = 'ValidationError';
  }
}
```

Why `name`: stack traces use it, and `instanceof` can be unreliable across realms / duplicated module loads — the name string survives.

## Chain with `cause`

Preserve the original error (available in every modern runtime).

```ts
try {
  await db.query(...);
} catch (e) {
  throw new AppError('failed to load user', { cause: e });
}
```

Stack and `.cause` are both available for debugging / logging.

## Catch `unknown`

`catch (e)` in modern TS types `e` as `unknown`. Narrow before use.

```ts
try { ... } catch (e) {
  if (e instanceof NotFoundError) return null;
  if (e instanceof ValidationError) return { errors: e.issues };
  throw e;                       // propagate the rest
}
```

Never assume `e instanceof Error` without checking. Anything can be thrown — strings, numbers, `{}`, `null`.

## `Result` types — optional, not always

For operations where a failure is **expected**, a `Result` type makes the possibility visible in the signature and skips `try/catch`.

```ts
type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

async function findUser(id: string): Promise<Result<User, 'not_found' | 'db_down'>> {
  try {
    const u = await db.users.find(id);
    if (!u) return { ok: false, error: 'not_found' };
    return { ok: true, value: u };
  } catch (e) {
    return { ok: false, error: 'db_down' };
  }
}

const r = await findUser(id);
if (!r.ok) return handle(r.error);
use(r.value);
```

Libraries (`neverthrow`, `true-myth`) give you chainable `Result`s with more ergonomics.

**When NOT to use**: if every caller re-throws the error anyway, `Result` just adds noise. Use it when the choice is local and important.

## Mapping errors at the edge

Internal: throw freely. Edge (HTTP handler, CLI main, queue consumer): translate into response.

```ts
// The one translation layer
export function toHttpResponse(e: unknown): Response {
  if (e instanceof ValidationError)
    return json({ errors: e.issues }, { status: 422 });
  if (e instanceof NotFoundError)
    return json({ error: e.message }, { status: 404 });
  if (e instanceof AuthError)
    return json({ error: 'unauthorized' }, { status: 401 });

  log.error('unexpected', { err: e });
  return json({ error: 'internal error' }, { status: 500 });
}
```

One place for the mapping. Handlers just throw.

## Never silently swallow

```ts
// ❌ swallow
try { doThing(); } catch { /* oops, silently ignored */ }

// ✅ log and continue if that's really what you want
try { doThing(); }
catch (e) { log.warn('doThing failed', { err: e }); }

// ✅ best: the caller decides
```

## `finally` for cleanup

```ts
const conn = await pool.acquire();
try {
  await work(conn);
} finally {
  conn.release();
}
```

Don't put business logic in `finally` — it runs even on error.

## Assertion helpers

Cheap way to narrow + fail fast.

```ts
export function invariant(c: unknown, msg: string): asserts c {
  if (!c) throw new AppError(`invariant failed: ${msg}`);
}

invariant(user.active, 'user must be active by this point');
user.email;     // narrowed; no null check needed
```

Keep messages short and specific. `"user must be active"` beats `"check failed"`.

## Error handling across async boundaries

An error in an async function becomes a rejected promise. Don't mix sync `throw` with async rejection in a way callers can't predict.

```ts
// ❌ sometimes throws synchronously, sometimes rejects
async function bad(x: unknown) {
  if (!x) throw new Error('bad');    // rejection (we're in async)
  return await f(x);                  // rejection
}

function worse(x: unknown) {
  if (!x) throw new Error('bad');    // sync throw
  return f(x);                        // returns a rejected promise
}

// ✅ consistently one or the other
async function good(x: unknown) {
  if (!x) throw new Error('bad');
  return await f(x);
}
// callers can always `await good(x)` and catch both cases with try/catch
```

## Validation at boundaries

Validate at parse time, never deep inside.

```ts
import { z } from 'zod';

const Body = z.object({ email: z.string().email(), age: z.number().int().min(0) });

export async function POST(req: Request) {
  let input;
  try {
    input = Body.parse(await req.json());
  } catch (e) {
    return json({ errors: (e as z.ZodError).issues }, { status: 422 });
  }
  // inside the function, `input` is strongly typed and trusted
  await service.signup(input);
  return json({ ok: true });
}
```

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `throw 'bad'` (string) | Always `throw new Error(...)` — strings lose stack |
| `catch (e: any)` | Use `catch (e)` (unknown) + narrow |
| `catch { return null }` | Log + handle specifically, or rethrow |
| Checking error with `.message.includes('...')` | Use instanceof + a typed error class |
| `Promise.reject('...')` with a string | Reject with an `Error` |
| Over-broad error class hierarchy with 40 subtypes | Usually 5–8 is enough |
| Error messages leaking PII / secrets | Redact before logging; never in client response |
