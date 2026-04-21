# Java — Concurrency

Virtual threads (21+), `ExecutorService`, `CompletableFuture`, structured concurrency.

## Virtual threads — Java 21+

Cheap threads mapped many-to-one onto OS threads. For I/O-bound work, replace platform-thread pools.

```java
// One virtual thread per request — simple, no thread-pool sizing
var executor = Executors.newVirtualThreadPerTaskExecutor();
executor.submit(() -> handle(req));

// Or inline:
Thread.startVirtualThread(() -> handle(req));
```

Virtual threads block cheaply. A thread per request becomes a reasonable model. `Thread.sleep`, blocking I/O (JDBC, filesystem), locks — all yield the carrier thread rather than burning it.

When NOT to use virtual threads:
- CPU-bound work (thousands of virtual threads running compute just migrate between OS threads; no gain).
- Code heavy on `synchronized` blocks (pinning problem — before Java 24 the carrier is locked; better in 24+).
- Legacy reactive code where migration is a separate project.

## Platform threads — `ExecutorService`

For CPU-bound work or when you need explicit thread-pool sizing.

```java
try (var exec = Executors.newFixedThreadPool(Runtime.getRuntime().availableProcessors())) {
    var futures = items.stream()
        .map(i -> exec.submit(() -> compute(i)))
        .toList();
    for (var f : futures) results.add(f.get());
}
```

`try-with-resources` on `ExecutorService` (Java 19+) shuts it down cleanly.

Sizing:
- CPU-bound: `n = cores` or `cores + 1`.
- Mixed: `n = cores × (1 + wait/compute ratio)`.
- If you can't estimate, virtual threads take the question away.

## `CompletableFuture` — composable async

```java
CompletableFuture<User> userF  = fetchUser(id);
CompletableFuture<Prefs> prefsF = fetchPrefs(id);

CompletableFuture<Screen> result = userF.thenCombine(prefsF, Screen::new);

result.thenAccept(screen -> render(screen))
      .exceptionally(err -> { log.error(err); return null; });
```

`supplyAsync`, `thenApply`, `thenCompose`, `thenCombine`, `allOf`, `anyOf`, `exceptionally` — the basic toolkit.

**Always** provide an explicit `Executor`:

```java
CompletableFuture.supplyAsync(this::load, executor)
```

Default is `ForkJoinPool.commonPool()` — OK for CPU-bound, wrong for I/O. Named executors are clearer and tune-able.

Rules:
- `.get()` blocks; use `.join()` in lambdas if you must.
- Don't mix async chains with blocking calls; stay reactive all the way or don't bother.
- With virtual threads, plain imperative code is usually preferable to `CompletableFuture` chains.

## Structured concurrency (preview → stable)

```java
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    Subtask<User>  userT  = scope.fork(() -> fetchUser(id));
    Subtask<Prefs> prefsT = scope.fork(() -> fetchPrefs(id));

    scope.join().throwIfFailed();
    return new Screen(userT.get(), prefsT.get());
}
```

Ties child tasks' lifecycle to the enclosing scope. Compiler / runtime ensures all children finish (or are cancelled) before the scope exits. Pairs nicely with virtual threads.

Check your JDK version — this API has been in preview; use the stable namespace (available in 25 LTS+).

## Locks

| Use | Tool |
|---|---|
| Short critical section | `synchronized` block |
| Read-heavy | `ReadWriteLock` / `StampedLock` |
| Atomic counter / flag | `java.util.concurrent.atomic.*` |
| One-time init | `volatile` + double-checked init, or `Holder` class pattern |

```java
private final Object lock = new Object();
private int counter;

void inc() {
    synchronized (lock) { counter++; }
}
```

Prefer `AtomicInteger` / `AtomicReference` over mutex + primitive for simple cases.

`Lock` interface (`ReentrantLock`) for tryLock, timeouts, fairness. Don't reach for it unless you need one of those.

## Concurrent collections

| Type | Use |
|---|---|
| `ConcurrentHashMap<K,V>` | Thread-safe map; scales to many cores |
| `CopyOnWriteArrayList<T>` | Mostly read, rarely written; snapshots |
| `BlockingQueue<T>` (`LinkedBlockingQueue`, etc.) | Producer / consumer |
| `ConcurrentLinkedQueue<T>` | Unbounded lock-free queue |

Don't wrap a regular `HashMap` in `Collections.synchronizedMap` and call it concurrent — it serializes every operation.

## `volatile`

Publishes writes to other threads. Does NOT make compound operations atomic.

```java
private volatile boolean running = true;
// other thread can see running = false without extra sync
```

Don't use `volatile` for counters. Use `AtomicInteger` / `AtomicLong` — `i++` is not atomic on `volatile int`.

## `ThreadLocal`

Per-thread storage. With platform threads + thread pools, a `ThreadLocal` can leak across requests because threads are reused. Use `try` / `finally` to clean up, or switch to `ScopedValue` (Java 21+).

```java
private static final ScopedValue<User> CURRENT_USER = ScopedValue.newInstance();

ScopedValue.where(CURRENT_USER, user).run(() -> {
    // CURRENT_USER.get() is user for the duration of this block
});
```

`ScopedValue` is immutable, bound by lexical scope, plays well with virtual threads.

## Avoid blocking in async frameworks

If you're on Reactor / RxJava / Mutiny (Quarkus), a blocking call on an event loop stalls the whole world. Mark blocking operations for a different scheduler:

```java
Mono.fromCallable(this::blockingThing).subscribeOn(Schedulers.boundedElastic());
```

Or move to virtual threads and stop needing reactive at all.

## Shutdown hooks

```java
Runtime.getRuntime().addShutdownHook(new Thread(() -> {
    exec.shutdown();
    try { exec.awaitTermination(30, TimeUnit.SECONDS); } catch (Exception ignored) {}
    db.close();
}));
```

Web frameworks do most of this for you. In plain-Java apps, do it explicitly.

## Timeouts

Every network / DB call has a timeout. Defaults are usually "infinite" or "very long".

```java
// HttpClient
var client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
var req    = HttpRequest.newBuilder(uri).timeout(Duration.ofSeconds(5)).GET().build();

// JDBC
statement.setQueryTimeout(5);
```

See `backend/references/resilience.md` for the full budget model.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `Thread.sleep` in request handlers | Use scheduled executors; or `VirtualThread.sleep` if truly needed |
| `new Thread(...).start()` for each task | Use an `ExecutorService` |
| `synchronized` across I/O calls | Hold locks briefly; never across network |
| Catching `InterruptedException` and discarding | `Thread.currentThread().interrupt()` before returning, or rethrow |
| `CompletableFuture` chains without an explicit executor | Always specify |
| `.get()` without timeout | `.get(timeout, unit)` or restructure async |
| Mutable shared state without synchronization | Lock it, use concurrent collections, or use an actor-ish pattern |
| `Future.cancel(true)` assumed to stop blocking I/O | Cancel interrupts; blocking calls may not honour it |
