# Go — Errors

`error` interface, wrapping, `errors.Is/As`, sentinel vs. typed errors. For general strategy, see `coding-standards/references/error-strategy.md`.

## The `error` interface

```go
type error interface {
    Error() string
}
```

That's it. Any type with an `Error() string` method is an error.

## Return errors; don't panic

Go signals failure by returning an error as the last value. Callers must handle it.

```go
f, err := os.Open(path)
if err != nil {
    return fmt.Errorf("open %s: %w", path, err)
}
defer f.Close()
```

Panic only for:
- Programmer errors (nil deref on a value you just constructed)
- Unrecoverable state (corrupted global, failed init on a must-have resource)
- `init()` failures

Never panic across a library boundary. Recover at the edge if you must, and log.

## Wrap with `%w`, not `%v` or `%s`

`fmt.Errorf` with `%w` preserves the underlying error for `errors.Is` / `errors.As`.

```go
// ✅
return fmt.Errorf("load config %q: %w", path, err)

// ❌ loses the original
return fmt.Errorf("load config %q: %v", path, err)
```

Wrap at each layer you cross. The final error has a breadcrumb trail.

```
load config "/etc/app.yaml": parse yaml: invalid syntax at line 12
```

## `errors.Is` — sentinel comparison

For "fixed" errors that the caller wants to match.

```go
var ErrNotFound = errors.New("not found")

func Find(id string) (*User, error) {
    if ... { return nil, ErrNotFound }
    ...
}

// Caller
u, err := Find(id)
if errors.Is(err, ErrNotFound) {
    return http.StatusNotFound, nil
}
```

`errors.Is` walks the wrap chain. Direct `==` comparison does not — use `errors.Is`.

## `errors.As` — typed errors with fields

When the caller needs data from the error (status code, field name), use a type with `errors.As`.

```go
type ValidationError struct {
    Field   string
    Message string
}

func (e *ValidationError) Error() string {
    return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

// Caller
var ve *ValidationError
if errors.As(err, &ve) {
    return fmt.Sprintf("field %s invalid", ve.Field)
}
```

`errors.As` walks the chain and binds to the first matching type.

## Sentinel vs. typed — when to use which

| Use a sentinel (`var ErrX = errors.New(...)`) | Use a typed error |
|---|---|
| Caller only needs to know "is it X?" | Caller needs details (field, code, retry-after) |
| Common across packages: `io.EOF`, `sql.ErrNoRows` | Validation failures, HTTP errors, domain errors |
| One concept, one value | Data varies per occurrence |

Prefer typed errors for anything the caller acts on with specific logic.

## Where to define errors

- **Sentinels**: in the package that can produce them. `package user`: `var ErrUserNotFound = errors.New("user not found")`.
- **Types**: same rule. Domain errors live in the domain package.

Don't put all errors in a shared `errors` package — it couples everything.

## Don't discard context

```go
// ❌ loses the cause
if err != nil {
    return errors.New("something failed")
}

// ❌ loses the cause and the stack
if err != nil {
    log.Println("error:", err)
    return nil
}

// ✅
if err != nil {
    return fmt.Errorf("load user %s: %w", id, err)
}
```

A wrapped error is dozens of times cheaper to debug than an unwrapped one.

## Check errors once, at the right place

```go
// ❌ stutter — log + rewrap + return
if err != nil {
    log.Printf("load failed: %v", err)
    return fmt.Errorf("load: %w", err)
}

// ✅ let the caller decide
if err != nil {
    return fmt.Errorf("load %s: %w", id, err)
}
```

Log where the error is **handled** (not re-thrown). Every rethrow-then-log doubles log volume.

## Edge: translate errors to HTTP status

```go
func writeError(w http.ResponseWriter, err error) {
    var ve *ValidationError
    switch {
    case errors.As(err, &ve):
        http.Error(w, ve.Error(), http.StatusUnprocessableEntity)
    case errors.Is(err, ErrNotFound):
        http.Error(w, "not found", http.StatusNotFound)
    case errors.Is(err, ErrUnauthorized):
        http.Error(w, "unauthorized", http.StatusUnauthorized)
    default:
        log.Printf("internal: %v", err)
        http.Error(w, "internal error", http.StatusInternalServerError)
    }
}
```

One translator, at the edge. Handlers just return errors.

## `errors.Join` — multiple errors at once

Go 1.20+: collect errors from a batch.

```go
var errs []error
for _, x := range xs {
    if err := process(x); err != nil {
        errs = append(errs, err)
    }
}
if err := errors.Join(errs...); err != nil {
    return err
}
```

`errors.Is` / `errors.As` work across joined errors.

## `defer` + named returns for cleanup errors

When `Close` can fail and you want to surface it:

```go
func write(path string, data []byte) (err error) {
    f, err := os.Create(path)
    if err != nil { return err }
    defer func() {
        if cerr := f.Close(); cerr != nil && err == nil {
            err = cerr
        }
    }()
    _, err = f.Write(data)
    return err
}
```

Named return `err` is read by the deferred func. Use sparingly — only when the cleanup error matters.

## `panic` / `recover` — edge cases only

```go
// One legitimate use: HTTP middleware recovering a goroutine panic
func recoverMW(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        defer func() {
            if rv := recover(); rv != nil {
                log.Printf("panic: %v\n%s", rv, debug.Stack())
                http.Error(w, "internal error", http.StatusInternalServerError)
            }
        }()
        next.ServeHTTP(w, r)
    })
}
```

Everywhere else: return `error`. `recover` is a safety net, not a control-flow tool.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `if err != nil { return err }` with no context | Wrap: `fmt.Errorf("op: %w", err)` |
| `errors.New("failed")` at every layer — no detail | Include the inputs and the operation |
| Returning `nil` error but also `nil` result | Decide the contract; don't force callers to guess |
| `recover` to "keep the server running" through bugs | Fix the bug; panics are bugs |
| String comparison on error messages | `errors.Is` / `errors.As` |
| Single huge `Error` struct with a `.Code` field | Use typed errors + `errors.As` |
| `log.Fatal` / `os.Exit` from deep inside libraries | Return; let `main` decide |
| `_ = someErrorReturningCall()` without a comment | Either handle or document the reason |
