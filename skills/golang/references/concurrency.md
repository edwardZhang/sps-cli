# Go — Concurrency

Goroutines, channels, `sync`, `context.Context`, `errgroup`.

## The rules

1. Every goroutine must have a way to terminate.
2. Every blocking operation takes a `context.Context`.
3. Channels are for communication, not for every synchronization need. `sync.Mutex` and `sync.WaitGroup` are first-class tools.
4. "Do not communicate by sharing memory; share memory by communicating" is a guideline, not a law. Use what fits.

## `context.Context`

First parameter, always.

```go
func (s *Service) Get(ctx context.Context, id string) (*User, error) {
    // pass ctx to every I/O call
    row := s.db.QueryRowContext(ctx, "select ... where id=$1", id)
    ...
}
```

Responsibilities:
- **Cancellation** — `<-ctx.Done()` fires when the parent cancels.
- **Deadline** — `context.WithTimeout(ctx, 5*time.Second)`.
- **Request-scoped values** — small, process-wide identifiers (trace id, auth principal). NOT a general DI container.

Rules:
- Never store a context in a struct.
- Never pass `nil` context; use `context.TODO()` if you really don't have one yet (and fix it).
- Never ignore a cancelled context and continue — return the error.

## Goroutine lifecycle

```go
// ❌ detached; we have no way to stop or wait
go doWork()

// ✅ bounded by context; caller decides when we stop
go func() {
    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            doWork()
        }
    }
}()
```

Rule: if you spawn a goroutine, write down (in a comment or a test) how it exits.

## WaitGroups

For "wait for N goroutines to finish".

```go
var wg sync.WaitGroup
for _, x := range xs {
    wg.Add(1)
    go func(x T) {
        defer wg.Done()
        process(x)
    }(x)
}
wg.Wait()
```

Don't call `wg.Add` from inside the goroutine (race). Add before `go`.

## `errgroup` — WaitGroup + errors + cancellation

`golang.org/x/sync/errgroup` is the right default for concurrent work that can fail.

```go
import "golang.org/x/sync/errgroup"

g, ctx := errgroup.WithContext(ctx)
for _, url := range urls {
    url := url                    // shadow (pre-Go-1.22)
    g.Go(func() error {
        return fetch(ctx, url)
    })
}
if err := g.Wait(); err != nil {
    return err                     // first error; ctx is cancelled → others stop
}
```

Bounded concurrency:
```go
g.SetLimit(10)                     // max 10 in flight
```

## Channels — send, receive, close

```go
ch := make(chan int, 10)           // buffered

go func() {
    defer close(ch)                // signal "no more values"
    for i := 0; i < 5; i++ {
        select {
        case ch <- i:
        case <-ctx.Done():
            return                  // unblock on cancellation
        }
    }
}()

for v := range ch {                // exits when ch is closed
    use(v)
}
```

Rules:
- **The sender closes**, never the receiver.
- Closing a nil or already-closed channel panics.
- Receive on a closed channel returns the zero value immediately; use `v, ok := <-ch` to detect close.
- A `send` on an unbuffered channel blocks until a receiver is ready. That's the synchronization.

## `select` — wait on multiple channels

```go
select {
case v := <-ch:
    handle(v)
case <-ctx.Done():
    return ctx.Err()
case <-time.After(1 * time.Second):
    return fmt.Errorf("timeout")
}
```

`default:` makes `select` non-blocking:
```go
select {
case ch <- v:
default:
    // drop; receiver not ready
}
```

## Fan-out, fan-in

```go
func pipeline(ctx context.Context, in <-chan T) <-chan R {
    out := make(chan R)
    var wg sync.WaitGroup
    for i := 0; i < runtime.NumCPU(); i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for v := range in {
                select {
                case out <- process(v):
                case <-ctx.Done():
                    return
                }
            }
        }()
    }
    go func() { wg.Wait(); close(out) }()
    return out
}
```

Always ensure the downstream can drain — otherwise workers block on send forever after cancellation.

## Mutex vs. channels — pick the right tool

| Need | Use |
|---|---|
| Protect a shared map / counter / cache | `sync.Mutex` / `sync.RWMutex` |
| Protect a single value, read-heavy | `atomic.Value` / `sync/atomic` |
| Signal "done" / "stop" | close(chan) or `context` |
| Coordinate N workers on a job queue | channel as queue |
| One-time init | `sync.Once` |
| Pool of reusable objects (buffers) | `sync.Pool` |

Don't use channels for what a mutex does better (protect a map). Channels shine for flow and signalling.

## RWMutex

For read-heavy structures.

```go
type Cache struct {
    mu   sync.RWMutex
    data map[string]V
}
func (c *Cache) Get(k string) (V, bool) {
    c.mu.RLock(); defer c.mu.RUnlock()
    v, ok := c.data[k]
    return v, ok
}
func (c *Cache) Set(k string, v V) {
    c.mu.Lock(); defer c.mu.Unlock()
    c.data[k] = v
}
```

Don't use `RWMutex` if writes dominate; the overhead makes plain `Mutex` faster.

## `sync.Once`, `sync.Pool`

```go
var (
    once  sync.Once
    cfg   *Config
)
func getConfig() *Config {
    once.Do(func() { cfg = loadConfig() })
    return cfg
}

var bufPool = sync.Pool{ New: func() any { return new(bytes.Buffer) } }
func use() {
    b := bufPool.Get().(*bytes.Buffer)
    defer func() { b.Reset(); bufPool.Put(b) }()
    ...
}
```

`sync.Pool` for high-allocation-pressure paths. Don't pool everything — usually you're just adding complexity.

## Race detector

Run tests with `-race` in CI. It catches concurrent reads/writes that break invariants.

```
go test -race ./...
```

Cost: ~2-10× slowdown. Only for tests, not prod.

## Common patterns

### Timeout one operation

```go
ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
defer cancel()
result, err := slowOp(ctx)
```

### Heartbeat / leader lock renew

```go
t := time.NewTicker(15 * time.Second)
defer t.Stop()
for {
    select {
    case <-ctx.Done(): return
    case <-t.C:       renew()
    }
}
```

### Worker pool with backpressure

```go
jobs := make(chan Job, 100)
for i := 0; i < 10; i++ {
    go worker(ctx, jobs)
}
// producers send on jobs; buffer provides backpressure
```

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `go f()` with no way to stop | Take `ctx.Context`; return on `<-ctx.Done()` |
| Reading from a channel with no timeout / cancel | `select { case v := <-ch: case <-ctx.Done(): }` |
| Closing a channel from the receiver | Only the sender closes |
| Sharing a `sync.Mutex` by value | Copy breaks locking — always by pointer |
| `for { select { default: ... } }` busy loop | Add a timer / cancel; don't spin |
| Global mutable maps without a mutex | Wrap in a type with a lock |
| Ignoring `context.Canceled` from HTTP / DB | Return it; it's usually correct |
| `time.Sleep` in request handlers | Use `time.After` inside `select` with `ctx.Done()` |
| Mixing `errgroup` and your own waitgroup | Pick one |
