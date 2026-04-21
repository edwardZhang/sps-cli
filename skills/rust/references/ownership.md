# Rust — Ownership

Borrowing, lifetimes, move vs. copy, smart pointers. The part the language is organized around.

## The rules

1. Each value has one owner.
2. When the owner goes out of scope, the value is dropped.
3. You can borrow immutably (any number of `&T`) OR mutably (exactly one `&mut T`), never both at once.

Everything else is consequences of these.

## Move vs. copy

```rust
let s = String::from("hi");
let t = s;              // move: s is no longer valid
// println!("{s}")       // ❌ error

let n = 5;
let m = n;              // copy: n is still valid (i32 is Copy)
println!("{n} {m}");    // ✅
```

`Copy` types (primitives, `&T`, arrays of `Copy`) are copied implicitly. Everything else is moved. Add `#[derive(Clone, Copy)]` to your own small value types.

## Borrowing

Prefer borrows over ownership in parameters. The caller chooses.

```rust
fn length(s: &str) -> usize { s.len() }

let owned = String::from("hi");
length(&owned);         // caller keeps the String
length("hello");        // works with a &'static str too
```

Rule: **accept `&str` / `&[T]` / `&T`, not `String` / `Vec<T>` / `T`**, unless you need ownership (e.g., storing it).

## The borrow checker — common errors and fixes

### "cannot borrow X as mutable because it is also borrowed as immutable"

```rust
// ❌
let mut v = vec![1, 2, 3];
let first = &v[0];      // immutable borrow
v.push(4);              // mutable borrow while &first alive
println!("{first}");    // error

// ✅ shorten the immutable borrow
let first = v[0];       // copy out (if Copy)
v.push(4);
println!("{first}");

// ✅ scope it
{
    let first = &v[0];
    println!("{first}");
}                        // borrow ends here
v.push(4);
```

### "use of moved value"

```rust
// ❌
let s = String::from("hi");
takes(s);
println!("{s}");         // already moved

// ✅ pass by reference
takes(&s);

// ✅ clone if you really need two owners
takes(s.clone());
```

## Lifetimes — usually inferred

Rust figures out most lifetimes. You only annotate when the compiler can't:

```rust
fn longest<'a>(x: &'a str, y: &'a str) -> &'a str {
    if x.len() > y.len() { x } else { y }
}
```

The `'a` says "the returned reference is valid for the shorter of x's and y's lifetimes".

In structs that hold references, you must annotate:

```rust
struct Parser<'src> {
    input: &'src str,
}
```

Rule of thumb: if you're fighting lifetimes, you might want owned data instead of references. Sometimes a `String` is fine.

## `'static` lifetime

`'static` means "lives for the whole program". Comes up with:
- String literals (`&'static str`)
- Bounded trait objects in async / threading (`Send + Sync + 'static`)
- Global `Mutex<T>` via `OnceLock` / `LazyLock`

A function bound `T: 'static` does NOT mean "must be owned forever" — it means "contains no non-static references". An owned `String` is `'static` because it borrows nothing.

## Smart pointers

| Type | Use |
|---|---|
| `Box<T>` | Heap allocate; needed for recursive types, trait objects |
| `Rc<T>` | Shared ownership, single-threaded; refcount |
| `Arc<T>` | Shared ownership, thread-safe |
| `RefCell<T>` | Interior mutability, single-threaded, checked at runtime |
| `Mutex<T>` / `RwLock<T>` | Interior mutability, thread-safe |
| `Cow<'a, T>` | Borrow OR own; copy-on-write |

Rule: **start with `&T` / `&mut T`. Reach for smart pointers only when simple borrowing can't model what you need.**

## Interior mutability

When a value is shared (`&T`) but a method needs to mutate it internally (caches, ref counts), use `RefCell` (single-threaded) or `Mutex` (threaded).

```rust
use std::cell::RefCell;

struct Cache {
    map: RefCell<HashMap<String, String>>,
}

impl Cache {
    fn get(&self, k: &str) -> Option<String> {
        self.map.borrow().get(k).cloned()
    }
    fn put(&self, k: String, v: String) {
        self.map.borrow_mut().insert(k, v);
    }
}
```

`.borrow_mut()` while another `.borrow()` is live panics at runtime. It trades compile-time for runtime checks — a last resort.

## `Rc<RefCell<T>>` — the single-threaded shared-mutable

Legal, common in tree / graph data structures, single-threaded only.

```rust
use std::{cell::RefCell, rc::Rc};

type Node = Rc<RefCell<NodeData>>;
```

If two threads may touch it → `Arc<Mutex<T>>`. If you find yourself writing `Rc<RefCell<...>>` often, reconsider — sometimes ownership flows would be cleaner with a different data layout (`Vec<Node>` + indexes).

## `Cow` — borrow or own, at runtime

```rust
use std::borrow::Cow;

fn normalize(s: &str) -> Cow<'_, str> {
    if s.chars().any(|c| c.is_uppercase()) {
        Cow::Owned(s.to_lowercase())
    } else {
        Cow::Borrowed(s)
    }
}
```

Great for "usually don't need to clone, sometimes do" paths. Callers get a `&str` from `.as_ref()`.

## `Drop` — RAII

Values implement `Drop` to release resources (file handles, mutex guards, DB connections).

```rust
impl Drop for TempFile {
    fn drop(&mut self) {
        std::fs::remove_file(&self.path).ok();
    }
}
```

Runs when the value goes out of scope. Don't `mem::forget` something with a `Drop` unless you really know.

Guards (`MutexGuard`, `RefMut`) are `Drop`-based — they release the lock when dropped. Keep them scoped tightly:

```rust
{
    let mut g = mu.lock().unwrap();
    g.push(x);
}               // lock released HERE
call_may_block();   // no lock held
```

## `unsafe` — the escape hatch

Only where the borrow checker can't prove safety (FFI, raw pointers, some `Send`/`Sync` work). Every `unsafe` block needs a `// SAFETY:` comment stating the invariants you've manually verified.

```rust
// SAFETY: `ptr` is not null (checked above) and `len` is within the allocation.
let slice = unsafe { std::slice::from_raw_parts(ptr, len) };
```

If you can do it safely, do it safely. `unsafe` is not a performance knob.

## Common patterns

### Newtype for domain meaning

```rust
pub struct UserId(pub String);
pub struct Email(pub String);

fn find_user(id: UserId) -> Option<User> { ... }

// fn call takes UserId, not String → hard to mix with other string IDs
```

### Builder

```rust
let req = Request::builder()
    .url("https://x.com")
    .timeout(Duration::from_secs(5))
    .build()?;
```

For types with many optional fields or construction invariants.

### Typestate — encode state in the type

```rust
struct Draft;
struct Published;

struct Post<State> { body: String, _s: PhantomData<State> }

impl Post<Draft> {
    fn publish(self) -> Post<Published> { ... }
}

impl Post<Published> {
    fn url(&self) -> String { ... }
    // no publish() here — you can't double-publish
}
```

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `.clone()` reflex to silence the borrow checker | Understand what ownership you need; clones should be deliberate |
| `Rc<RefCell<T>>` everywhere | Revisit data layout; many problems want a `Vec<T>` with indexes |
| Accepting `String` / `Vec<T>` when `&str` / `&[T]` works | Over-constrains callers |
| Returning references from local functions ("dangling reference") | Return owned data, or rework the lifetime story |
| `mut` everywhere | Minimize mutation; Rust rewards immutable-by-default |
| Implementing `Clone` by default | Only for types callers will reasonably clone |
| Allocating in a hot loop (`format!`, `vec![...]`) | Preallocate; `write!` into a reused buffer |
| Leaking a `MutexGuard` into an async `.await` | Guard is not `Send`; use `tokio::sync::Mutex` or drop the guard before awaiting |
