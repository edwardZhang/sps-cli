# Kotlin — Coroutines

`suspend`, scopes, dispatchers, `Flow`, cancellation. Structured concurrency is the model.

## `suspend` functions

A `suspend fun` is a function that can pause (free its thread) and resume later.

```kotlin
suspend fun fetchUser(id: String): User {
    val raw = httpClient.get("/users/$id")
    return User.fromJson(raw)
}
```

Call from another `suspend` function or from a `CoroutineScope.launch { ... }`. You can't call them from a regular function without `runBlocking` (for main / tests only).

## Structured concurrency

Every coroutine runs in a `CoroutineScope`. When the scope is cancelled, all its children are cancelled. No orphan work.

```kotlin
coroutineScope {
    val user = async { fetchUser(id) }
    val prefs = async { fetchPrefs(id) }
    render(user.await(), prefs.await())
    // if either throws, the other is cancelled and the exception bubbles
}
```

Rule: **no `GlobalScope.launch`, no bare `launch` at top level.** Attach every coroutine to a scope with a known lifecycle.

## Dispatchers

| Dispatcher | Use |
|---|---|
| `Dispatchers.Default` | CPU-bound work (limited to # of cores) |
| `Dispatchers.IO` | Blocking I/O (file, network, blocking JDBC) |
| `Dispatchers.Main` | UI thread (Android, JavaFX) |
| `Dispatchers.Unconfined` | Rarely needed; tests and hacks |

```kotlin
suspend fun readFile(path: String): String =
    withContext(Dispatchers.IO) { File(path).readText() }
```

Only switch dispatchers at boundaries. Don't spray `withContext(IO)` inside tight logic.

## `coroutineScope` vs. `supervisorScope`

```kotlin
// coroutineScope: one failure cancels siblings (default)
coroutineScope {
    launch { critical1() }
    launch { critical2() }
}

// supervisorScope: failures isolated
supervisorScope {
    launch { optional1() }   // if this fails, optional2 still runs
    launch { optional2() }
}
```

Default to `coroutineScope`. Use `supervisorScope` for independent tasks where one failure shouldn't kill the rest (e.g., background refreshes).

## Cancellation

Cancellation is cooperative. A coroutine is cancelled when:
- Its scope is cancelled.
- A structured sibling throws (in `coroutineScope`).
- `cancel()` is called on its `Job`.

`suspend` functions check cancellation at suspension points. CPU-heavy loops must opt in:

```kotlin
repeat(1_000_000) {
    doWork()
    yield()                   // or ensureActive()
}
```

Handle `CancellationException`:
```kotlin
try {
    doWork()
} catch (e: CancellationException) {
    // clean up, then RETHROW — don't swallow
    throw e
} catch (e: Exception) {
    log.error("failed", e)
}
```

**Swallowing `CancellationException` breaks the scope contract.** Always re-throw.

## `async` / `await`

For parallel computations that return values.

```kotlin
val (u, o) = coroutineScope {
    val userD  = async { getUser(id) }
    val ordsD  = async { getOrders(id) }
    userD.await() to ordsD.await()
}
```

Don't use `async { ... }.await()` back-to-back when you could just call the `suspend` function. That's sequential work dressed up as parallel.

## Timeouts

```kotlin
withTimeout(5.seconds) {
    slowOp()
}                           // throws TimeoutCancellationException on timeout

withTimeoutOrNull(5.seconds) {
    slowOp()
}                           // returns null on timeout
```

## `Flow` — asynchronous streams

`Flow` is a cold async sequence. It doesn't run until collected.

```kotlin
fun tick(interval: Duration): Flow<Int> = flow {
    var i = 0
    while (currentCoroutineContext().isActive) {
        emit(i++)
        delay(interval)
    }
}

scope.launch {
    tick(1.seconds)
        .map { it * 2 }
        .filter { it > 10 }
        .take(5)
        .collect { println(it) }
}
```

Operators (`map`, `filter`, etc.) return new Flows; `collect` is the terminal.

### Cold vs. hot

- **Cold** (`flow { }`, `flowOf`): starts fresh per collector.
- **Hot** (`SharedFlow`, `StateFlow`): shared; values emitted regardless of collectors.

Use `StateFlow` for "current value of X" (UI state). Use `SharedFlow` for events (broadcast). Use plain `Flow` for request/response.

### Backpressure

```kotlin
flow.buffer(100)              // buffered producer
flow.conflate()               // keep only latest
flow.collectLatest { ... }    // cancel prior collector when new value arrives
```

## Channels

One-shot or producer/consumer.

```kotlin
val channel = Channel<Job>(capacity = 100)
launch {
    for (job in channel) { process(job) }
}
channel.send(job)
channel.close()
```

For most use cases, `Flow` is enough. Use `Channel` when you need direct send/receive semantics.

## Exception handling

Exceptions propagate up the structured-concurrency tree. The parent coroutine sees them at `.await()` or when children complete.

```kotlin
try {
    coroutineScope {
        launch { throwSomething() }
    }
} catch (e: SomeError) {
    // caught here
}
```

Install a `CoroutineExceptionHandler` on a `CoroutineScope` for top-level handlers (Android ViewModel, server main). Don't scatter try/catch inside coroutines.

## `runBlocking` — only for `main` and tests

Bridges blocking and suspending worlds. Inside a request handler or a library, `runBlocking` deadlocks threads. Don't.

```kotlin
fun main() = runBlocking {
    myApp()
}

@Test fun test() = runBlocking {
    assertEquals(5, add(2, 3))
}
```

For tests, prefer `runTest` (from `kotlinx-coroutines-test`) — it virtualizes time.

## `runTest` — deterministic async tests

```kotlin
@Test
fun fetches() = runTest {
    val result = fetchUser("u1")     // no real delay; virtual scheduler
    assertEquals("u1", result.id)
    advanceTimeBy(5.seconds)         // control time
}
```

## Android-specific coroutine scopes

- `viewModelScope` — cancels on `ViewModel.onCleared()`
- `lifecycleScope` — cancels on lifecycle destroy
- `repeatOnLifecycle(STARTED) { flow.collect { ... } }` — cancels on stop, resumes on start

Never use `GlobalScope` or raw `Job()` from within a component with a defined lifecycle.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `GlobalScope.launch` | Attach to a scope with a known lifecycle |
| `runBlocking` in request path / library code | Make the function `suspend` |
| Swallowing `CancellationException` | Rethrow; scope relies on it |
| `withContext(IO) { ... }` wrapping every line | Switch at I/O boundary only |
| `async { x() }.await()` with no other work in parallel | Just call `x()` as a suspend fun |
| `Thread.sleep` in `suspend fun` | Use `delay` |
| `while (true) { doWork() }` with no yield | Add `yield()` / `ensureActive()` for cancellation |
| `StateFlow` for events (drops duplicates) | Use `SharedFlow` for events |
| Long-running Flow in `collect { ... }` on UI thread that blocks | `flowOn(Dispatchers.IO)` upstream |
