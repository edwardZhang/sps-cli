# Python Async / Concurrency

`asyncio` patterns for I/O-bound concurrency. For CPU-bound work, use processes, not async.

## When to use what

| Workload | Tool | Why |
|---|---|---|
| I/O-bound (network, files, DB) | `asyncio` | One thread, thousands of connections |
| CPU-bound (crunching, crypto) | `multiprocessing` / `concurrent.futures.ProcessPoolExecutor` | GIL blocks threads |
| Blocking library you can't async-ify | `asyncio.to_thread()` | Offload to the default thread pool |
| Parallelizing blocking syscalls | `concurrent.futures.ThreadPoolExecutor` | Simple, no asyncio required |

`asyncio` without I/O is pointless — a `async def` that only does CPU work gives you no concurrency.

## `async def` / `await` basics

```python
import asyncio
import httpx

async def fetch(url: str) -> str:
    async with httpx.AsyncClient() as client:
        r = await client.get(url)
        return r.text

async def main() -> None:
    html = await fetch("https://example.com")
    print(len(html))

asyncio.run(main())
```

Rule: never call `asyncio.run()` from inside already-running async code. It's the entry point, not a utility.

## Concurrency — run coroutines in parallel

### `asyncio.gather` (legacy, still common)

```python
async def fetch_all(urls: list[str]) -> list[str]:
    return await asyncio.gather(*(fetch(u) for u in urls))

# With return_exceptions — failures don't cancel siblings
results = await asyncio.gather(*tasks, return_exceptions=True)
for r in results:
    if isinstance(r, Exception):
        log.warning("one failed: %s", r)
```

### `asyncio.TaskGroup` (Python 3.11+) — preferred

Structured concurrency: if any task raises, siblings are cancelled and errors are aggregated into an `ExceptionGroup`.

```python
async def fetch_all(urls: list[str]) -> list[str]:
    async with asyncio.TaskGroup() as tg:
        tasks = [tg.create_task(fetch(u)) for u in urls]
    return [t.result() for t in tasks]

# Error handling
try:
    await fetch_all(urls)
except* httpx.ConnectError as eg:
    log.warning("network failures: %d", len(eg.exceptions))
except* httpx.HTTPStatusError as eg:
    log.error("HTTP errors: %s", [e.response.status_code for e in eg.exceptions])
```

Prefer `TaskGroup` over `gather` in new code — cancellation is correct by default.

## Timeouts

### Python 3.11+: `asyncio.timeout`

```python
async def with_deadline():
    async with asyncio.timeout(5.0):
        return await slow_operation()

# Nested / reschedulable
async with asyncio.timeout(None) as cm:
    cm.reschedule(asyncio.get_running_loop().time() + 10)
    ...
```

### Older: `asyncio.wait_for`

```python
result = await asyncio.wait_for(slow_operation(), timeout=5.0)
```

## Cancellation

Cancellation is a `CancelledError` injected at the next `await`. Rules:

- **Never swallow `CancelledError`** except to run cleanup; always re-raise.
- Cleanup in `finally` must itself be fast and cancellation-safe.
- `asyncio.shield()` protects a critical section from outer cancellation.

```python
async def worker():
    try:
        while True:
            await do_work()
    except asyncio.CancelledError:
        await cleanup()    # fast, idempotent
        raise              # REQUIRED — don't swallow

async def critical_write(path, data):
    # Outer cancel won't interrupt the write
    await asyncio.shield(write_file(path, data))
```

## Offloading blocking code

Never call blocking code from an async function — it stalls the event loop for everyone.

```python
# Wrong: blocks the event loop
async def handler(req):
    data = requests.get(req.url).text   # ❌ blocking library in async code
    return data

# Right: offload to thread pool
async def handler(req):
    data = await asyncio.to_thread(requests.get, req.url)
    return data.text

# Or use an async-native library
async def handler(req):
    async with httpx.AsyncClient() as client:
        r = await client.get(req.url)
        return r.text
```

`time.sleep()` in async code is always a bug — use `await asyncio.sleep()`.

## Async iteration & generators

```python
# Async iterator
async def stream_lines(url: str) -> AsyncIterator[str]:
    async with httpx.AsyncClient() as client:
        async with client.stream("GET", url) as resp:
            async for line in resp.aiter_lines():
                yield line

async for line in stream_lines(url):
    process(line)

# Async comprehension
urls = [u async for u in stream_urls() if u.startswith("https://")]
```

## Async context managers

```python
from contextlib import asynccontextmanager

@asynccontextmanager
async def db_transaction(conn):
    tx = await conn.begin()
    try:
        yield tx
    except Exception:
        await tx.rollback()
        raise
    else:
        await tx.commit()

async with db_transaction(conn) as tx:
    await tx.execute(...)
```

## Backpressure with semaphores

Limit in-flight concurrency when the downstream can't take unlimited load.

```python
async def fetch_bounded(urls: list[str], limit: int = 10) -> list[str]:
    sem = asyncio.Semaphore(limit)

    async def one(u):
        async with sem:
            return await fetch(u)

    async with asyncio.TaskGroup() as tg:
        tasks = [tg.create_task(one(u)) for u in urls]
    return [t.result() for t in tasks]
```

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `asyncio.run()` inside async code | Pass awaitables up; `asyncio.run()` is the entry point only |
| `time.sleep()` in async | `await asyncio.sleep()` |
| `requests` / blocking HTTP in async | Use `httpx.AsyncClient` or `asyncio.to_thread` |
| Swallowing `CancelledError` | Always re-raise after cleanup |
| Fire-and-forget `asyncio.create_task(x)` without keeping a reference | Reference dropped → task can be garbage-collected mid-flight |
| Mixing threads and asyncio naively | Use `asyncio.to_thread` / `loop.run_in_executor`, not raw `threading` |
| Using async just because "it's modern" | Async has real overhead; pure CPU or simple scripts don't need it |

## Running background tasks correctly

```python
# Wrong: task may be GC'd before it runs
asyncio.create_task(background())

# Right: keep a reference
_background_tasks: set[asyncio.Task] = set()

def schedule(coro):
    t = asyncio.create_task(coro)
    _background_tasks.add(t)
    t.add_done_callback(_background_tasks.discard)
```
