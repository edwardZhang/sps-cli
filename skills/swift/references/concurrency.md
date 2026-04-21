# Swift — Concurrency

`async/await`, `Task`, actors, `@MainActor`, `AsyncSequence`, cancellation.

## `async/await`

```swift
func fetchUser(id: String) async throws -> User {
    let (data, _) = try await URLSession.shared.data(from: url(id))
    return try JSONDecoder().decode(User.self, from: data)
}

// Caller
let u = try await fetchUser(id: "u1")
```

`async` functions suspend at `await` without blocking a thread. `throws` propagates errors.

## `Task`

`Task` creates a new concurrent context.

```swift
// Fire-and-forget
Task {
    await sendAnalytics()
}

// Get a result
let task = Task {
    try await fetchUser(id: "u1")
}
let user = try await task.value

// Detached — no inherited context, rare
Task.detached(priority: .background) { await heavyWork() }
```

Prefer structured `Task {}` (inherits parent's priority, cancellation, actor). `Task.detached` only when you genuinely need to break the hierarchy.

## Structured concurrency — `async let`

```swift
func loadScreen() async throws -> Screen {
    async let user  = fetchUser(id: id)
    async let feed  = fetchFeed()
    async let prefs = fetchPrefs()
    return Screen(user: try await user, feed: try await feed, prefs: try await prefs)
}
```

All three requests start concurrently; `await` collects them. If one throws, the others are cancelled.

## Task groups — dynamic parallelism

```swift
func loadAll(ids: [String]) async throws -> [User] {
    try await withThrowingTaskGroup(of: User.self) { group in
        for id in ids {
            group.addTask { try await fetchUser(id: id) }
        }
        var users: [User] = []
        for try await u in group { users.append(u) }
        return users
    }
}
```

On error: cancel the group or rethrow. Siblings complete (or get cancelled if you throw).

### Bounded concurrency

```swift
try await withThrowingTaskGroup(of: User.self) { group in
    let limit = 10
    var inFlight = 0
    var iter = ids.makeIterator()

    while let id = iter.next(), inFlight < limit {
        group.addTask { try await fetchUser(id: id) }
        inFlight += 1
    }

    var out: [User] = []
    while let u = try await group.next() {
        out.append(u)
        if let id = iter.next() {
            group.addTask { try await fetchUser(id: id) }
        }
    }
    return out
}
```

## Cancellation

Cancellation is cooperative. A cancelled task continues unless it checks.

```swift
func work() async throws {
    for item in bigList {
        try Task.checkCancellation()     // throws CancellationError if cancelled
        process(item)
    }
}
```

Most stdlib `async` calls check cancellation (`URLSession`, `Task.sleep`). Your own loops must opt in.

## Timeouts

```swift
func withTimeout<T>(_ seconds: Double, _ op: @escaping () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await op() }
        group.addTask {
            try await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
            throw CancellationError()
        }
        guard let first = try await group.next() else { throw CancellationError() }
        group.cancelAll()
        return first
    }
}
```

(In Swift 6, `ContinuousClock` / `withTaskGroup`'s timeouts are cleaner.)

## Actors — shared mutable state

An actor serializes access. Only one method runs at a time; readers wait.

```swift
actor Cache {
    private var data: [String: Data] = [:]

    func get(_ key: String) -> Data? { data[key] }

    func set(_ key: String, _ value: Data) {
        data[key] = value
    }
}

let cache = Cache()
let v = await cache.get("u1")     // await — crossing actor boundary
```

From outside, calls are `await`; inside the actor, they're synchronous. Don't expose internal mutable state; return values, not references to the actor's storage.

## `@MainActor` — UI-thread isolation

```swift
@MainActor
class ViewModel: ObservableObject {
    @Published var state: State = .loading

    func load() async {
        state = .loading
        do {
            let u = try await service.fetch()    // hops off main for network
            state = .loaded(u)                    // back on main — safe
        } catch {
            state = .error(error)
        }
    }
}
```

Any view model / UI code runs on `MainActor` by default. `await` on non-MainActor code hops off the main thread; results return via `await`, preserving main-thread safety.

Individual functions: `@MainActor func update(...) { ... }`.

## `Sendable`

Types crossing actor / Task boundaries must be `Sendable` — "safe to transfer across concurrency domains".

```swift
struct User: Sendable { ... }                 // struct of Sendable fields is Sendable
final class Foo: Sendable { ... }             // needs: final, immutable, or internal sync
```

Swift 6 enforces Sendable at the compiler level. Common fixes:
- Make the type a `struct` (value type, usually Sendable automatically).
- Make reference types `final` and all fields `let` + `Sendable`.
- For mutable types crossing boundaries, wrap in an `actor`.

## `AsyncSequence` — streams

```swift
for try await line in fileHandle.bytes.lines {
    process(line)
}

// Build your own
struct Counter: AsyncSequence {
    typealias Element = Int
    struct Iterator: AsyncIteratorProtocol {
        var i = 0
        mutating func next() async -> Int? {
            guard i < 10 else { return nil }
            try? await Task.sleep(nanoseconds: 100_000_000)
            defer { i += 1 }
            return i
        }
    }
    func makeAsyncIterator() -> Iterator { Iterator() }
}

for await n in Counter() { print(n) }
```

Great for paginated APIs, file reads, WebSocket messages.

## Continuations — bridging callback APIs

```swift
func legacy(id: String, completion: @escaping (User?, Error?) -> Void) { ... }

func fetch(id: String) async throws -> User {
    try await withCheckedThrowingContinuation { continuation in
        legacy(id: id) { user, error in
            if let user = user { continuation.resume(returning: user) }
            else if let error = error { continuation.resume(throwing: error) }
            else { continuation.resume(throwing: URLError(.unknown)) }
        }
    }
}
```

**Call `resume` exactly once.** Calling twice crashes; not calling leaks the coroutine. Use `withCheckedContinuation` during development (crashes on misuse); switch to `withUnsafeContinuation` in release if you need the perf.

## Priority & throttling

Task priorities: `.userInitiated`, `.userInteractive`, `.utility`, `.background`. Lower priority in background tasks; the scheduler throttles.

```swift
Task(priority: .background) { await indexDatabase() }
```

## Avoiding blocking

Don't call blocking APIs from async code.

```swift
// ❌
Task { sleep(5); await doThing() }

// ✅
Task { try await Task.sleep(nanoseconds: 5_000_000_000); await doThing() }
```

File I/O: use `URLSession` for network, `FileHandle.bytes` for async reads, or `Task.detached(priority: .utility)` for genuinely blocking calls.

## Bridging to / from main thread

```swift
// From background, update UI on main
Task { @MainActor in
    self.state = .loaded
}

// Call a MainActor method from non-MainActor
await viewModel.update()
```

Don't use `DispatchQueue.main.async` in new Swift code — `@MainActor` / `Task { @MainActor in ... }` is the native way.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `DispatchSemaphore.wait` to bridge async → sync | Restructure caller as async; semaphores deadlock the runtime |
| `Task { await ... }.value` from sync code to "await" | Don't; make the caller `async` |
| `DispatchQueue.main.sync` from background | `await MainActor.run { ... }` or `@MainActor` |
| Unchecked continuations with complex flow | Use `withCheckedContinuation` during development |
| Shared mutable struct state across tasks | Use an actor |
| Detached tasks for everything | Structured `Task {}` inherits context; detached is an escape hatch |
| Ignoring `Task.isCancelled` / `checkCancellation` in loops | Cancellation is cooperative |
| `async` on sync functions "for consistency" | `async` has a cost; don't add without reason |
| Storing `Task` references without cancellation story | Keep a handle; cancel on deinit / view disappearance |
