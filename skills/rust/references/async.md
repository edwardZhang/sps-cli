# Rust — Async

`async fn`, futures, `tokio`, cancellation, `select!`, pinning traps.

## `async fn` basics

```rust
async fn fetch(url: &str) -> Result<String, reqwest::Error> {
    reqwest::get(url).await?.text().await
}
```

`async fn` returns a `Future`. The future does nothing until awaited.

```rust
// ❌ nothing runs
let f = fetch("https://x.com");

// ✅
let body = fetch("https://x.com").await?;
```

## Runtimes

Rust doesn't ship a runtime. Pick one:

- **tokio** — de facto standard; multi-threaded; huge ecosystem
- **async-std** — simpler, fewer features; smaller
- **smol** — lightweight; good for embedded / minimal binaries

Most production code is tokio. Mixing runtimes in one process is painful — pick early.

```rust
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    run().await
}
```

## `.await` is a suspension point

Every `.await` can be where another task takes over. Anything you hold across `.await` must be `Send` if the runtime moves tasks between threads.

```rust
// ❌ std::sync::MutexGuard isn't Send; holding across .await breaks
let g = mu.lock().unwrap();
do_something().await;            // compile error on tokio multi-threaded
g.push(x);

// ✅ tokio::sync::Mutex is async-aware
let mut g = mu.lock().await;
do_something().await;
g.push(x);

// ✅ or drop the guard first
{
    let mut g = mu.lock().unwrap();
    g.push(x);
}
do_something().await;
```

## Concurrency primitives

### `tokio::spawn` — fire a task

```rust
let handle = tokio::spawn(async move {
    work().await
});
let result = handle.await??;         // first ? for JoinError, second for inner Result
```

`spawn` requires `Send + 'static`. For local-only (non-`Send`) work on the current thread, use `tokio::task::spawn_local` inside a `LocalSet`.

### `join!` — run futures in parallel, wait for all

```rust
let (u, o) = tokio::join!(get_user(id), get_orders(id));
```

Same task; no threads involved. All futures must be awaitable concurrently.

### `try_join!` — parallel, short-circuit on first error

```rust
let (u, o) = tokio::try_join!(get_user(id), get_orders(id))?;
```

### `select!` — wait on the first of several

```rust
tokio::select! {
    r = fetch(url) => handle(r),
    _ = tokio::time::sleep(Duration::from_secs(5)) => timeout(),
    _ = ctx.cancelled() => cancelled(),
}
```

`select!` drops the non-winning futures (cancellation). Anything side-effectful in the dropped branch must be cancellation-safe. **Many operations aren't** — databases mid-transaction, partial writes. Use `Pin<Box<...>>` + `futures::future::FutureExt::fuse` or structure with cancellation guards.

## Cancellation

In Rust async, cancellation = dropping the future. It happens:
- When a `tokio::select!` branch loses.
- When a `spawn`ed `JoinHandle` is aborted.
- When the caller stops awaiting (e.g., `timeout` fires).

**Cancellation-safety** is a property of individual futures. Not all are safe to drop mid-flight. Library docs usually say.

Rule: critical writes should complete in a non-cancellable section. `tokio::spawn(async { ... }).await` insulates from caller cancellation (but the spawned task gets its own drop path).

## Timeouts

```rust
use tokio::time::{timeout, Duration};

match timeout(Duration::from_secs(5), fetch(url)).await {
    Ok(Ok(body)) => ...,
    Ok(Err(e))   => return Err(e.into()),
    Err(_)       => return Err(anyhow!("timeout")),
}
```

Budget timeouts across layers — inner < outer.

## Bounded concurrency

```rust
use futures::stream::{StreamExt, iter};

let results: Vec<_> = iter(urls)
    .map(|u| fetch(u))
    .buffer_unordered(10)           // 10 in flight
    .collect()
    .await;
```

`buffer_unordered` for order-insensitive; `buffered` preserves order.

## Channels

| Channel | Use |
|---|---|
| `tokio::sync::mpsc` | Multi-producer, single-consumer |
| `tokio::sync::broadcast` | Multi-producer, multi-consumer (fan-out); bounded, drops if lagging |
| `tokio::sync::watch` | Single-slot "latest value"; good for config / state updates |
| `tokio::sync::oneshot` | One-shot; request → response |

```rust
let (tx, mut rx) = tokio::sync::mpsc::channel(100);
tokio::spawn(async move {
    while let Some(msg) = rx.recv().await {
        process(msg).await;
    }
});
tx.send(msg).await?;
```

Bounded channels = backpressure. Use unbounded sparingly; unbounded sends can run the receiver out of memory.

## Avoid blocking the executor

```rust
// ❌ blocks the worker thread — starves other tasks
std::thread::sleep(Duration::from_secs(1));
std::fs::read_to_string("big.txt")?;

// ✅
tokio::time::sleep(Duration::from_secs(1)).await;
tokio::fs::read_to_string("big.txt").await?;

// ✅ offload CPU-bound / blocking I/O to a blocking-friendly pool
tokio::task::spawn_blocking(|| do_cpu_work())
    .await?;
```

A single blocking call on a worker thread pauses every async task on that worker.

## Pinning — the big word, rare in application code

Async state machines live in memory at addresses their own self-references assume are stable. `Pin<P<T>>` is how the language tells you "don't move this".

You typically only care if you write your own `Future`. With `async fn` + `tokio`, pinning is handled for you. If you see a compile error about `Unpin`, `Pin::new_unchecked`, or "future cannot be unpinned" — that's when you read up. Day-to-day, ignore.

## Structured concurrency — `JoinSet`

```rust
use tokio::task::JoinSet;

let mut set = JoinSet::new();
for url in urls {
    set.spawn(fetch(url));
}
while let Some(res) = set.join_next().await {
    match res {
        Ok(Ok(body)) => use_body(body),
        Ok(Err(e))   => log::warn!("fetch failed: {e}"),
        Err(e) if e.is_panic() => log::error!("task panicked"),
        Err(_) => {},
    }
}
```

Better than loose `spawn` + vector of handles — `JoinSet` cleans up on drop.

## Debugging

- **tokio-console** — live task inspector; shows stuck tasks, contention.
- `RUST_LOG=debug` with `tracing-subscriber` for structured async logs.
- `#[tokio::main(flavor = "current_thread")]` temporarily for deterministic local repros.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `std::thread::sleep` / `std::fs::*` in async | Use `tokio::*` equivalents or `spawn_blocking` |
| Holding `std::sync::MutexGuard` across `.await` | Drop before await or use `tokio::sync::Mutex` |
| Unbounded channels everywhere | Use bounded; apply backpressure |
| `async` on functions that do no awaiting | Drop `async`; callers shouldn't need to await |
| `tokio::spawn` with captured `&` references | Move owned data; tasks are `'static` |
| `.await` inside a loop that could be parallel | `buffer_unordered` or `JoinSet` |
| `select!` over non-cancellation-safe futures | Read the docs; wrap in `spawn` if unsafe to drop |
| Runtimes nested in runtimes (calling `Runtime::new().block_on(...)` inside an async fn) | Don't; `.await` or use `spawn_blocking` |
