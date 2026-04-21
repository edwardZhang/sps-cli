# Go — Idioms

Package layout, naming, zero values, struct embedding, slices.

## Package layout

```
myapp/
├── go.mod
├── cmd/
│   └── myapp/
│       └── main.go          # only package main; minimal
├── internal/                # not importable from outside
│   ├── user/
│   │   ├── user.go
│   │   ├── service.go
│   │   └── service_test.go
│   └── http/
│       └── handler.go
├── pkg/                     # public, importable (rare for apps)
└── api/                     # protobufs, openapi
```

Rules:
- **`internal/`** forbids import from other modules — use it generously.
- **`pkg/`** is for libraries you intend to publish. Most apps don't need it.
- **No `util/`, `common/`, `helpers/`.** Name packages by what they provide: `auth`, `billing`, `httpx`.

## Package names

Lowercase, short, singular, no underscores, no mixed case.

```
✅ auth, billing, httpx, db, user
❌ auth_package, userService, UTILS, libCommon
```

Import name = package name. If the directory name differs, aliasing breaks grep. Keep them aligned.

## Exported vs. unexported

Capital letter = exported. Lowercase = package-private.

```go
type User struct {          // exported
    ID    string             // exported field
    email string             // unexported
}

func (u *User) Email() string { return u.email }
```

Don't expose fields if an accessor keeps an invariant. Don't add accessors for pure data types.

## Zero values are usable

Design types so the zero value is safe and meaningful.

```go
var m sync.Mutex        // ready to use
var b bytes.Buffer      // ready to use

type Counter struct {   // design for zero-value usability
    n int
}
func (c *Counter) Inc() { c.n++ }
```

Avoid "must call New()" types. If construction requires validation, make `New` return an error and keep the exported type private if needed.

## Struct literals — use field names

```go
// ❌
u := User{"u1", "a@x.com", true}

// ✅
u := User{
    ID:    "u1",
    Email: "a@x.com",
    Active: true,
}
```

Positional literals break silently on field reorders or additions.

## Composition over inheritance — embedding

```go
type Logger struct { /* ... */ }
func (l *Logger) Log(msg string) { /* ... */ }

type Service struct {
    *Logger                         // embedded; Service.Log is promoted
    db *sql.DB
}
```

Good for "is-a" composition and interface satisfaction. Don't use embedding to shortcut field access across unrelated types — that's confusion dressed as reuse.

## Interfaces — small, at the call site

```go
// ✅ in the caller's package
package service

type userRepo interface {
    Find(ctx context.Context, id string) (*User, error)
}

type Service struct {
    repo userRepo
}
```

The *io.Reader* lesson: one-method interfaces are the norm. `Stringer`, `io.Reader`, `io.Closer`, `error` — all one method.

## Accept interfaces, return structs

```go
// ✅
func NewService(r Reader) *Service { ... }     // accepts an interface
func (s *Service) Get() (*User, error) { ... } // returns a concrete type

// ❌
func NewService(r *os.File) ...               // over-constrained
func (s *Service) Get() (fmt.Stringer, error) // under-specified return
```

The caller decides what abstraction they want; you shouldn't force one on them.

## Slices — the common traps

### Share backing array

```go
a := []int{1, 2, 3, 4}
b := a[:2]           // [1 2]; shares backing with a
b = append(b, 99)    // may overwrite a[2]
```

When you need independent slices, copy:

```go
b := append([]int(nil), a[:2]...)     // new backing array
```

### Preallocate capacity

```go
// ✅
out := make([]T, 0, len(xs))
for _, x := range xs { out = append(out, f(x)) }

// ❌ grows repeatedly, each growth may realloc + copy
var out []T
for _, x := range xs { out = append(out, f(x)) }
```

### Nil slice vs. empty slice

Both have length 0. Both work with `range`, `len`, `append`. The difference shows up in JSON (`null` vs `[]`) and reflection-based equality. For public APIs, return `[]T{}` (empty) unless nil is semantically meaningful.

## Maps — iteration order is randomized

Never rely on map iteration order. Sort keys first when order matters.

```go
keys := make([]string, 0, len(m))
for k := range m { keys = append(keys, k) }
sort.Strings(keys)
for _, k := range keys { fmt.Println(k, m[k]) }
```

## `for range` pitfalls

Until Go 1.22, the loop variable was shared — a common source of goroutine bugs:

```go
// Go < 1.22 — BUG
for _, x := range xs {
    go func() { use(x) }()          // all goroutines see the last x
}

// Go < 1.22 — FIX
for _, x := range xs {
    x := x                           // shadow into a new variable
    go func() { use(x) }()
}

// Go 1.22+ — per-iteration scope; works correctly without shadowing
```

Check your `go.mod`'s `go` version.

## `defer` — cleanup, not logic

```go
f, err := os.Open(path)
if err != nil { return err }
defer f.Close()             // ✅ cleanup
```

Rules:
- `defer` runs in reverse order.
- `defer` captures args at the `defer` site, not at call time.
- Don't defer in a hot loop — each `defer` costs an allocation; move cleanup into a helper.
- Check the error of deferred `Close` on writes (`defer f.Close()` hides the last flush error).

```go
defer func() {
    if cerr := f.Close(); cerr != nil && err == nil {
        err = cerr
    }
}()
```

## Constants & iota

```go
const (
    StatusPending = "pending"
    StatusActive  = "active"
)

type Day int
const (
    Sun Day = iota
    Mon
    Tue
)
```

Prefer typed constants (`type Day int`) for enums so compile catches wrong-type assignment.

## Strings and bytes

`string` is immutable bytes. `[]byte` is mutable. Convert deliberately — conversions copy.

```go
b := []byte(s)           // allocates
s := string(b)           // allocates

// hot path: avoid repeated conversions; keep the type you need
```

`strings.Builder` for concatenation in a loop — `+` reallocates every time.

## Formatting — `gofmt` / `goimports` is the law

No team style debates. `goimports` groups and sorts imports:

```go
import (
    "context"
    "fmt"

    "github.com/example/mod"

    "myapp/internal/user"
)
```

Standard lib → third-party → internal, separated by blank lines.

## Receiver types — pointer vs. value

Rules of thumb:
- If the method modifies the receiver → pointer.
- If the struct contains a `sync.Mutex` or similar → pointer (never copy a lock).
- Large struct (say > 64 bytes) → pointer (avoid copy).
- Otherwise, either works. Be consistent across a type's methods — don't mix.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Getters/setters for plain data | Exported fields; only add methods when behaviour is needed |
| `init()` doing work | Do it explicitly in `main` |
| Variable shadowing across scopes | `go vet` catches the bad cases; pay attention |
| Using `interface{}` / `any` everywhere | Reach for concrete types first |
| Long files (>500 lines) | Split by responsibility, not by arbitrary size |
| `len(s) > 0` to check non-empty | `s != ""` is the idiom |
| Custom `String()` with side effects | `fmt` calls it at any time; must be pure |
| "Manager", "Util", "Helper" names | Name by what the type actually is |
