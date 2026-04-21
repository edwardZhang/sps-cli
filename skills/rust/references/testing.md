# Rust — Testing

`#[test]`, integration tests, property testing, snapshots. For general TDD, see `coding-standards/references/tdd.md`.

## Unit tests — alongside the code

```rust
// src/math.rs
pub fn add(a: i32, b: i32) -> i32 { a + b }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_positives() {
        assert_eq!(add(2, 3), 5);
    }

    #[test]
    #[should_panic(expected = "overflow")]
    fn panics_on_overflow() {
        add(i32::MAX, 1);
    }
}
```

Run with `cargo test`. The `#[cfg(test)]` block is compiled only for tests — the test code doesn't ship in release builds.

## Integration tests — `tests/` directory

```
mycrate/
├── src/
│   └── lib.rs
└── tests/
    └── api.rs          # one file = one crate, black-box tests
```

```rust
// tests/api.rs
use mycrate::load;

#[test]
fn loads_from_file() {
    let cfg = load("tests/fixtures/sample.yaml").unwrap();
    assert_eq!(cfg.name, "sample");
}
```

Integration tests use only the public API. If you need internal access, that's a unit test.

## Assertions

```rust
assert!(cond);
assert_eq!(a, b);
assert_ne!(a, b);

// With custom message
assert_eq!(got, want, "parsed value mismatch for input {input:?}");
```

Failures show a nice diff. Stick with `assert_eq!` over manual `if got != want { panic! }`.

## Parameterized tests — table style

```rust
#[test]
fn add_cases() {
    for (a, b, want) in [(1, 2, 3), (0, 0, 0), (-1, 1, 0)] {
        assert_eq!(add(a, b), want, "add({a}, {b})");
    }
}
```

Or use `rstest` for per-case test names:

```rust
use rstest::rstest;

#[rstest]
#[case(1, 2, 3)]
#[case(0, 0, 0)]
#[case(-1, 1, 0)]
fn add(#[case] a: i32, #[case] b: i32, #[case] want: i32) {
    assert_eq!(crate::add(a, b), want);
}
```

`cargo test add::case_1` runs one case.

## Async tests

With tokio:

```rust
#[tokio::test]
async fn fetches() {
    let body = fetch("http://...").await.unwrap();
    assert!(body.contains("hi"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn multi_thread() { ... }
```

Other runtimes have their own macros (`#[async_std::test]`).

## Property tests — `proptest` / `quickcheck`

Generates random inputs; shrinks failing cases to a minimal counter-example.

```rust
use proptest::prelude::*;

proptest! {
    #[test]
    fn sort_is_idempotent(v in any::<Vec<i32>>()) {
        let mut s = v.clone();
        s.sort();
        let mut s2 = s.clone();
        s2.sort();
        prop_assert_eq!(s, s2);
    }

    #[test]
    fn roundtrip(s in "\\PC*") {   // arbitrary printable UTF-8
        let encoded = encode(&s);
        prop_assert_eq!(decode(&encoded), s);
    }
}
```

Use for: parsers, serializers, invariant checks, anything with a large input space.

## Snapshot tests — `insta`

```rust
#[test]
fn render() {
    insta::assert_snapshot!(render(&input));
    insta::assert_yaml_snapshot!(serialize(&input));
}
```

Run `cargo insta review` to approve / reject. Commit the snapshots under `src/snapshots/`. Review every diff deliberately.

Great for CLI output, parser ASTs, generated config. Weak for flaky fields (timestamps, UUIDs) — redact or inject deterministic values.

## Test doubles

Fakes > mocks in Rust too.

```rust
// Production
pub trait UserRepo {
    fn find(&self, id: &str) -> Option<User>;
}

// In tests
struct FakeRepo { users: HashMap<String, User> }

impl UserRepo for FakeRepo {
    fn find(&self, id: &str) -> Option<User> {
        self.users.get(id).cloned()
    }
}
```

For mocks, `mockall`:

```rust
use mockall::automock;

#[automock]
trait UserRepo {
    fn find(&self, id: &str) -> Option<User>;
}

let mut mock = MockUserRepo::new();
mock.expect_find()
    .with(eq("u1"))
    .returning(|_| Some(User::sample()));
```

Reach for `mockall` when the trait has complex call expectations. Otherwise, fakes are clearer.

## Test filtering

```bash
cargo test                          # all tests
cargo test math                     # name contains 'math'
cargo test --lib                    # unit tests only
cargo test --test api               # one integration file
cargo test -- --nocapture           # show println! output
cargo test -- --test-threads=1      # serial execution (rare)
```

Add `--quiet` for cleaner CI output.

## Golden files — `testdata/` + `env var`

```rust
const UPDATE: bool = option_env!("UPDATE_GOLDEN").is_some();

#[test]
fn render_matches_golden() {
    let got = render(sample());
    let path = "testdata/rendered.txt";
    if UPDATE {
        std::fs::write(path, &got).unwrap();
    }
    let want = std::fs::read_to_string(path).unwrap();
    assert_eq!(got, want);
}
```

Run `UPDATE_GOLDEN=1 cargo test` to regenerate. `insta` does this better in most cases.

## Doc tests — executable examples in docs

```rust
/// Adds two numbers.
///
/// ```
/// use mycrate::add;
/// assert_eq!(add(2, 3), 5);
/// ```
pub fn add(a: i32, b: i32) -> i32 { a + b }
```

Run with `cargo test --doc`. Keeps public examples honest — if you change the API, the doc test breaks.

## Benchmarks

Stable Rust: `cargo bench` with `criterion`.

```rust
// benches/my_bench.rs
use criterion::{criterion_group, criterion_main, Criterion};

fn bench_parse(c: &mut Criterion) {
    let input = "...";
    c.bench_function("parse", |b| b.iter(|| parse(input)));
}

criterion_group!(benches, bench_parse);
criterion_main!(benches);
```

Criterion runs statistical comparisons against previous runs, flags regressions.

## `cargo test` + `cargo llvm-cov` for coverage

```
cargo install cargo-llvm-cov
cargo llvm-cov --html
```

See `coding-standards/references/tdd.md` for target numbers.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `unwrap()` in non-test code copied into tests | Use `?` in `fn test() -> Result<(), Err>` if you want |
| `std::thread::sleep` in async tests | `tokio::time::sleep` (or pause time for determinism) |
| Tests that depend on execution order | Each test is independent; don't share globals |
| Hitting real external services in unit tests | Use fakes / `wiremock` / `httpmock` |
| Comparing `Debug` strings for equality | Use `assert_eq!` on typed values |
| Snapshot of time-dependent output without redaction | Inject a clock |
| Ignoring `#[should_panic]` without `expected = "..."` | Any panic passes; you want the specific one |
| Test file names that don't match the module under test | `foo.rs` → `foo/tests.rs` or `tests/foo.rs` |
