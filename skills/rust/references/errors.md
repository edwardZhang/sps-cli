# Rust — Errors

`Result`, `?`, `thiserror`, `anyhow`. For general strategy, see `coding-standards/references/error-strategy.md`.

## `Result<T, E>` is the contract

Expected failure → `Result`. Bugs / invariant violations → `panic!`.

```rust
fn parse_port(s: &str) -> Result<u16, ParseIntError> {
    s.parse()
}
```

`Result` is `#[must_use]`. The compiler warns if you ignore one. Treat warnings as errors.

## The `?` operator

Propagate errors with one character.

```rust
fn load() -> Result<Config, ConfigError> {
    let raw = std::fs::read_to_string("config.yaml")?;    // io::Error -> ConfigError (via From)
    let cfg: Config = serde_yaml::from_str(&raw)?;        // serde error -> ConfigError
    Ok(cfg)
}
```

`?` uses the `From` trait to convert the inner error to the function's error type. Implement `From<SubErr> for TopErr` to get conversion for free (or use `thiserror`).

## Error enums with `thiserror`

For library code where callers need to match on variants.

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("read config file: {0}")]
    Io(#[from] std::io::Error),

    #[error("parse yaml: {0}")]
    Parse(#[from] serde_yaml::Error),

    #[error("missing field {field}")]
    MissingField { field: String },

    #[error("invalid value for {field}: {reason}")]
    InvalidValue { field: String, reason: String },
}
```

`#[from]` auto-generates `From<io::Error> for ConfigError`, so `?` just works.

## `anyhow` for applications

For `main`, CLI tools, glue code — anywhere callers only need "it failed, here's why".

```rust
use anyhow::{Context, Result};

fn main() -> Result<()> {
    let cfg = load_config("config.yaml")
        .context("loading application config")?;
    run(cfg).context("running application")?;
    Ok(())
}
```

`anyhow::Error` is a type-erased error with a chain. `.context()` adds breadcrumbs. The final message reads like:

```
Error: running application

Caused by:
    0: loading application config
    1: parse yaml
    2: missing field: database.url
```

**Rule**: libraries → `thiserror`; binaries → `anyhow`. Mixing both is fine — libraries use their typed errors; `anyhow::Error` wraps them at the edge.

## Error sources & chaining

Every error has a chain. Walk it when logging:

```rust
fn log_error(err: &dyn std::error::Error) {
    eprintln!("error: {err}");
    let mut source = err.source();
    while let Some(s) = source {
        eprintln!("  caused by: {s}");
        source = s.source();
    }
}
```

`anyhow` formats the chain for you. With `thiserror`, implement `Display` to include context, and let callers walk `.source()`.

## Avoid `Box<dyn Error>` in libraries

`Box<dyn Error>` erases your error type. Callers lose the ability to match variants. Fine inside `main` or in examples; avoid in public API.

```rust
// ❌ in a library
pub fn load() -> Result<Config, Box<dyn Error>> { ... }

// ✅
pub fn load() -> Result<Config, ConfigError> { ... }
```

## `unwrap()` / `expect()` — when OK

- **Tests** — panic on unexpected failure is fine.
- **`main`** — as long as the panic message is actionable.
- **"Statically known impossible"** — document with `.expect("invariant: X")`.

```rust
// ✅ truly impossible
let re = Regex::new(r"^\d+$").expect("hardcoded regex is valid");

// ❌ lazy
let line = input.lines().next().unwrap();    // what if input is empty?
```

`.expect("msg")` is better than `.unwrap()` — the message tells the next reader why this was assumed safe.

## `match` vs. `if let` vs. `?`

```rust
// ✅ handle both cases
match parse(s) {
    Ok(v) => use_v(v),
    Err(e) => log::warn!("parse failed: {e}"),
}

// ✅ one case matters
if let Ok(v) = parse(s) {
    use_v(v);
}

// ✅ propagate
let v = parse(s)?;
```

## Combining errors with `?` across types

If two error types coexist in the function, implement `From` or let `anyhow` absorb both.

```rust
// Typed approach
impl From<ReqError> for MyError { ... }
impl From<ParseError> for MyError { ... }

// Anyhow approach
fn load() -> anyhow::Result<Config> {
    let body = reqwest::blocking::get(url)?.text()?;
    let cfg = serde_yaml::from_str(&body)?;
    Ok(cfg)
}
```

## Retries

Retry only idempotent operations. No runtime hides bad idempotency.

```rust
fn with_retry<F, T, E>(mut f: F) -> Result<T, E>
where F: FnMut() -> Result<T, E>, E: std::fmt::Debug
{
    let mut wait = 100;
    for attempt in 0..3 {
        match f() {
            Ok(v) => return Ok(v),
            Err(e) if attempt < 2 => {
                log::warn!("attempt {attempt} failed: {e:?}");
                std::thread::sleep(Duration::from_millis(wait));
                wait *= 2;
            }
            Err(e) => return Err(e),
        }
    }
    unreachable!()
}
```

For real use, bring a crate (`backoff`, `tokio-retry`). See `backend/references/resilience.md` for when.

## Domain-specific error granularity

Keep error enums focused. One giant `AppError` with 40 variants is worse than five module-level error types.

```rust
// Module a/error.rs
pub enum Error { /* a-specific */ }

// Module b/error.rs
pub enum Error { /* b-specific */ }

// crate top-level (for public API or for anyhow consumers)
pub enum Error {
    #[error(transparent)] A(#[from] a::Error),
    #[error(transparent)] B(#[from] b::Error),
}
```

`#[error(transparent)]` + `#[from]` makes the outer enum forward the inner's message cleanly.

## Panic → catch at the edge

Panics in spawned threads or tasks need to be caught or your server silently degrades.

```rust
// Axum / tower middleware example — pseudo
tokio::task::spawn(async move {
    match tokio::task::spawn(async { handle(req).await }).await {
        Ok(Ok(resp)) => resp,
        Ok(Err(e))   => to_http_response(e),
        Err(join_err) if join_err.is_panic() => {
            log::error!("handler panicked");
            http_500()
        }
        Err(_) => http_500(),
    }
});
```

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `unwrap()` in library code | Return `Result`, let the caller decide |
| `panic!("bad input")` on user input | Return a validation error |
| Stringly-typed errors (`Err("failed".to_string())`) | Typed enum |
| One `Error::Other(String)` variant used for everything | Split by actual failure mode |
| Catching every error with `?` and ignoring the chain in logs | Walk `.source()` or use `anyhow` formatting |
| `Box<dyn Error>` in public lib API | `thiserror`-generated enum |
| Using `anyhow` inside library code that users might match on | Define a typed error |
| Silent `.ok()` / `.unwrap_or_default()` that swallows meaningful failures | Handle or propagate |
