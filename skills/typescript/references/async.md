# TypeScript — Async

Promises, async/await, error propagation, cancellation, concurrency.

## `async/await` is sugar for promises

```ts
// These are equivalent
async function f() { const x = await g(); return x + 1; }
function f()      { return g().then(x => x + 1); }
```

Prefer `async/await` for linear flows, `.then` chains for pipelines on a single value.

## Every promise must be awaited or handled

Unhandled rejections crash Node (in strict mode) or log cryptic warnings.

```ts
// ❌ fire-and-forget
sendEmail(user.email);           // if it rejects → unhandled
doThing().then(logSuccess);      // no .catch

// ✅
await sendEmail(user.email);

// ✅ intentional fire-and-forget: use .catch
void sendEmail(user.email).catch(err => log.error(err));
```

TS/ESLint rules: `@typescript-eslint/no-floating-promises` catches these.

## Error propagation

Throws inside `async` become rejections. `try/catch` catches them.

```ts
async function load() {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new HttpError(r.status);
    return await r.json();
  } catch (e) {
    if (e instanceof HttpError && e.status === 404) return null;
    throw e;
  }
}
```

`catch (e: unknown)` — always. `e` is not an `Error` in JS; could be anything thrown.

```ts
try { ... } catch (e) {
  if (e instanceof Error) log.error(e.message);
  else log.error('non-Error thrown', { e });
}
```

## Concurrency

### Parallel, all must succeed

```ts
const [u, o, p] = await Promise.all([
  getUser(id),
  getOrders(id),
  getPrefs(id),
]);
```

One rejection → whole thing rejects; other in-flight promises continue but their results are discarded.

### Parallel, any may fail

```ts
const results = await Promise.allSettled(tasks);
for (const r of results) {
  if (r.status === 'fulfilled') use(r.value);
  else log.warn(r.reason);
}
```

### First to finish wins

```ts
const winner = await Promise.race([req, timeout(5000)]);
```

### First to succeed (any)

```ts
const first = await Promise.any([primary(), secondary(), tertiary()]);
// rejects only if all fail
```

## Sequential vs. parallel — don't accidentally serialize

```ts
// ❌ serial (each waits for the prior)
for (const id of ids) {
  await fetchUser(id);
}

// ✅ parallel
await Promise.all(ids.map(fetchUser));
```

Sequential is correct when order matters or when you want backpressure. Parallel is often what you wanted but wrote wrong.

## Bounded parallelism

Unlimited parallelism blows up memory and hammers downstreams. Bound it.

```ts
import pLimit from 'p-limit';

const limit = pLimit(10);
const results = await Promise.all(ids.map(id => limit(() => fetchUser(id))));
```

Or chunk manually:

```ts
async function inChunks<T, R>(xs: T[], size: number, fn: (x: T) => Promise<R>) {
  const out: R[] = [];
  for (let i = 0; i < xs.length; i += size) {
    const chunk = xs.slice(i, i + size);
    out.push(...await Promise.all(chunk.map(fn)));
  }
  return out;
}
```

## Cancellation — `AbortController`

The standard cancellation primitive for fetch, streams, timers.

```ts
const ac = new AbortController();
setTimeout(() => ac.abort(), 5000);

try {
  const r = await fetch(url, { signal: ac.signal });
  return await r.json();
} catch (e) {
  if (e instanceof DOMException && e.name === 'AbortError') {
    // cancelled
  } else {
    throw e;
  }
}
```

For your own async functions, accept a `signal` and check / propagate it:

```ts
async function work({ signal }: { signal?: AbortSignal }) {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  signal?.addEventListener('abort', () => { /* clean up */ }, { once: true });
  ...
}
```

## Timeouts — `AbortSignal.timeout` (modern)

```ts
const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
```

Falls back to `AbortController` + `setTimeout` on older runtimes.

## Retry with backoff

```ts
async function withRetry<T>(
  fn: () => Promise<T>,
  { attempts = 3, baseMs = 100, maxMs = 10_000 } = {},
): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === attempts - 1) throw e;
      const delay = Math.min(maxMs, baseMs * 2 ** i) * (0.5 + Math.random());
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('unreachable');
}
```

Only retry idempotent operations. See `backend/references/resilience.md`.

## Async iterators & streams

For data you consume one chunk at a time.

```ts
async function* readLines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop()!;
    for (const line of lines) yield line;
  }
  if (buf) yield buf;
}

for await (const line of readLines(resp.body!)) {
  process(line);
}
```

## Microtasks & the event loop

`await` queues continuation as a microtask — runs before macro-tasks (`setTimeout`) even at delay 0.

```ts
Promise.resolve().then(() => console.log('A'));   // microtask
setTimeout(() => console.log('B'), 0);             // macrotask
// A then B
```

You rarely need to know this, until you're debugging an out-of-order log.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `new Promise((res) => { ... res(x) })` wrapping a callback API | Use `util.promisify` (Node) or a library wrapper |
| Rejecting with a string | Always `new Error(...)` |
| Nested `.then` chains | Flatten with `await` |
| `.catch` without re-throw on unknown errors | Narrow or rethrow |
| `await` inside a `.forEach` | Use `for...of` or `Promise.all` |
| `async` function returning `Promise<Promise<T>>` | Unnecessary; one `async` is enough |
| Dangling `setTimeout`/`setInterval` in React effects | Return cleanup or use a library |
| Fire-and-forget without `.catch` | Silent failures; add `.catch(log)` |
