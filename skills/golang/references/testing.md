# Go — Testing

`testing` package, table-driven tests, subtests, benchmarks, fuzzing. For general TDD, see `coding-standards/references/tdd.md`.

## Conventions

- File: `*_test.go` next to the code it tests.
- Package: same as the code (`package user`) for white-box; `package user_test` for black-box (public API only).
- Test function: `func TestXxx(t *testing.T)`.
- Run: `go test ./...`

```go
// user_test.go
package user

import "testing"

func TestNormalizeEmail(t *testing.T) {
    got := Normalize("  A@X.COM ")
    want := "a@x.com"
    if got != want {
        t.Errorf("Normalize: got %q, want %q", got, want)
    }
}
```

`t.Errorf` logs and continues. `t.Fatalf` stops the test.

## Table-driven tests

The idiomatic way.

```go
func TestAdd(t *testing.T) {
    tests := []struct {
        name    string
        a, b    int
        want    int
    }{
        {"two positives", 2, 3, 5},
        {"zero", 0, 0, 0},
        {"negative", -1, 1, 0},
    }
    for _, tt := range tests {
        tt := tt                          // shadow for Go < 1.22
        t.Run(tt.name, func(t *testing.T) {
            if got := Add(tt.a, tt.b); got != tt.want {
                t.Errorf("got %d, want %d", got, tt.want)
            }
        })
    }
}
```

Benefits: `t.Run` gives each case its own name for `-run` filtering and parallel runs.

## `t.Parallel()`

Mark tests that can run in parallel.

```go
func TestX(t *testing.T) {
    t.Parallel()
    ...
}
```

Rules:
- Don't mutate package globals or filesystem fixtures.
- Subtests inherit parallelism; put `t.Parallel()` in each `t.Run`.
- If a test is slow or has setup cost, parallel compounds: N tests × 10× speedup = big wins.

## Test helpers — mark with `t.Helper()`

```go
func requireUser(t *testing.T, got, want *User) {
    t.Helper()                         // errors report the caller's line
    if got.ID != want.ID { t.Errorf("id: got %s want %s", got.ID, want.ID) }
}
```

Without `t.Helper()`, error line points inside the helper instead of the test body.

## `testify` — when assertions get verbose

The standard lib is fine for most cases. `testify/require` helps when you have many assertions.

```go
import "github.com/stretchr/testify/require"

func TestUser(t *testing.T) {
    u, err := Get(id)
    require.NoError(t, err)
    require.NotNil(t, u)
    require.Equal(t, "A", u.Name)
}
```

Use `require` (stops on fail) vs `assert` (continues). `require` avoids nil-deref panics in the next line after a failure.

Don't reach for `testify/mock` by default — prefer real fakes for repos, test HTTP servers, etc.

## Fakes over mocks

```go
// ✅ fake repo — behaves like the real one, in memory
type fakeUserRepo struct { users map[string]*User }
func newFakeUserRepo() *fakeUserRepo { return &fakeUserRepo{users: map[string]*User{}} }
func (r *fakeUserRepo) Find(_ context.Context, id string) (*User, error) { return r.users[id], nil }
func (r *fakeUserRepo) Save(_ context.Context, u *User) error { r.users[u.ID] = u; return nil }
```

For HTTP dependencies, `httptest.NewServer` gives you a real server at a real port.

```go
srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    fmt.Fprint(w, `{"id":"u_1"}`)
}))
defer srv.Close()

client := NewClient(srv.URL)
u, _ := client.Get(ctx, "u_1")
```

## Golden files — for large expected output

```go
var update = flag.Bool("update", false, "update golden files")

func TestRender(t *testing.T) {
    got := Render(input)
    golden := filepath.Join("testdata", "render.golden")
    if *update {
        os.WriteFile(golden, got, 0644)
    }
    want, _ := os.ReadFile(golden)
    if !bytes.Equal(got, want) {
        t.Errorf("render diff; run with -update to regenerate")
    }
}
```

Run `go test -update` to regenerate after deliberate changes. Review the diff like any other.

## Benchmarks

```go
func BenchmarkAdd(b *testing.B) {
    for i := 0; i < b.N; i++ {
        Add(2, 3)
    }
}
```

Run: `go test -bench=. -benchmem ./...`.

Use `b.ReportAllocs()` or `-benchmem` to track allocations; ns/op matters, allocs/op often matters more.

Always benchmark the thing you want to measure. Pre-compute inputs outside the timed loop:

```go
func BenchmarkHash(b *testing.B) {
    data := make([]byte, 1024)
    rand.Read(data)
    b.ResetTimer()                     // reset after setup
    for i := 0; i < b.N; i++ {
        _ = sha256.Sum256(data)
    }
}
```

## Fuzzing (Go 1.18+)

For parsers, validators, anything with a big input space.

```go
func FuzzParseURL(f *testing.F) {
    f.Add("http://x.com")
    f.Fuzz(func(t *testing.T, s string) {
        u, err := Parse(s)
        if err == nil && u.String() != s {
            t.Errorf("roundtrip failed: %q != %q", u.String(), s)
        }
    })
}
```

Run: `go test -fuzz=FuzzParseURL -fuzztime=30s`. Failing inputs are saved to `testdata/fuzz/<name>/` — commit them to prevent regressions.

## Integration tests

Build tag or separate directory to keep them out of the default run.

```go
//go:build integration
package integration_test

func TestDBReal(t *testing.T) { ... }
```

Run: `go test -tags=integration ./...`.

Or: separate package under `internal/integration/` and a Makefile target.

## Race detector in CI

Always. Always. Always.

```
go test -race ./...
```

## Coverage

```
go test -cover ./...
go test -coverprofile=c.out ./... && go tool cover -html=c.out
```

Set a floor in CI:

```
go test -coverprofile=c.out ./...
go tool cover -func=c.out | grep total: | awk '{if ($3+0 < 80.0) exit 1}'
```

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| One `Test*` per file instead of one `TestMain` | Table-driven tests fold the variants |
| `fmt.Println` in tests for debugging | `t.Logf` — only shows on failure |
| `time.Sleep` to wait for async | Use channels, `WaitGroup`, or deterministic test clock |
| Shared package-level state between tests | Reset in each test, or don't use globals |
| `testify/mock` boilerplate for everything | Hand-write a fake; less code, clearer intent |
| Snapshot tests for time / UUID output | Inject a clock / uuid generator; test against deterministic output |
| Benchmarks that don't `ResetTimer` after setup | You're benchmarking setup, not the function |
| Disabling a failing test to unblock CI | Fix or delete |
