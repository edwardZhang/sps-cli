# Rust — Traits

Traits, generics, `impl Trait`, associated types, trait objects.

## What a trait is

A trait is a set of methods a type implements. Like interfaces in Go / Java, but:
- You can add a trait impl for a type you don't own (with orphan rule limits).
- Traits can have default methods.
- Generic bounds + associated types make them more expressive than Java interfaces.

```rust
pub trait Store {
    fn get(&self, k: &str) -> Option<String>;
    fn put(&mut self, k: &str, v: &str);
}

pub struct MemStore { data: HashMap<String, String> }

impl Store for MemStore {
    fn get(&self, k: &str) -> Option<String> { self.data.get(k).cloned() }
    fn put(&mut self, k: &str, v: &str) { self.data.insert(k.into(), v.into()); }
}
```

## Define traits at the call site

Same rule as Go. The consumer specifies what they need.

```rust
// ✅ in the caller's module
pub trait UserRepo {
    fn find(&self, id: &str) -> Option<User>;
}

pub struct Service<R: UserRepo> { repo: R }
```

Don't pre-emptively define traits in the implementer's module; you don't yet know what consumers will need.

## Generics (static dispatch)

```rust
fn first<T>(xs: &[T]) -> Option<&T> {
    xs.first()
}

// Bounded
fn sum<T: std::ops::Add<Output = T> + Copy + Default>(xs: &[T]) -> T {
    xs.iter().copied().fold(T::default(), |a, b| a + b)
}

// Where clause for readability
fn process<T, U>(xs: &[T]) -> Vec<U>
where
    T: Clone + Debug,
    U: From<T>,
{
    xs.iter().cloned().map(U::from).collect()
}
```

Each concrete instantiation produces specialized machine code — fast, but more compile time.

## Trait objects (dynamic dispatch)

```rust
fn render_all(items: &[Box<dyn Renderable>]) { ... }
```

Use when:
- A collection has mixed concrete types.
- You want to keep the trait out of callers' generic parameter lists.
- Compile time matters more than a vtable indirection.

A trait must be **object-safe** to be used as `dyn Trait`. Roughly: no generic methods, no `Self` in return type beyond `&Self` / `&mut Self`.

## `impl Trait`

Two meanings depending on where it appears.

### Return position

"I'm returning something that implements this trait, but don't pin me to a concrete type."

```rust
fn make_iter() -> impl Iterator<Item = u32> {
    (0..10).map(|x| x * 2)
}
```

Cheaper than `Box<dyn Iterator<Item = u32>>` — static dispatch, no allocation. But the caller sees only `impl Iterator<...>`, not the concrete type.

### Argument position

Syntactic sugar for a generic:

```rust
fn log_all(items: impl Iterator<Item = String>) { ... }
// same as
fn log_all<I: Iterator<Item = String>>(items: I) { ... }
```

## Associated types vs. generic parameters

```rust
// ✅ associated type — one impl per (type, associated output) pair
trait Iterator {
    type Item;
    fn next(&mut self) -> Option<Self::Item>;
}

// ❌ would be wrong here — you could have a type be Iterator<u32> AND Iterator<String>, weird
trait Iterator<T> {
    fn next(&mut self) -> Option<T>;
}
```

Use associated types when a trait has "the" output type for a given implementer. Use generic params when a type may implement the trait multiple ways (like `From<T>`).

## Default methods

```rust
trait Greet {
    fn name(&self) -> &str;
    fn greet(&self) { println!("Hello, {}", self.name()); }
}
```

Implementers get `greet()` free unless they override. Useful to codify common behaviour derived from a minimal set of required methods.

## Blanket impls

```rust
impl<T: Display> Loggable for T {
    fn log(&self) { println!("{self}"); }
}
```

Adds the trait to every type that satisfies the bound. Powerful; can cause conflicts if two blanket impls would overlap.

## Extension traits

Add methods to a foreign type by defining a local trait that the foreign type implements via a local impl.

```rust
pub trait VecExt<T> {
    fn into_sorted(self) -> Self;
}

impl<T: Ord> VecExt<T> for Vec<T> {
    fn into_sorted(mut self) -> Self { self.sort(); self }
}

let v = vec![3, 1, 2].into_sorted();
```

Common in `futures` / `iter` ecosystems (`StreamExt`, `IteratorExt`).

## Common standard traits — derive them

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct UserId(pub u64);
```

| Trait | Meaning |
|---|---|
| `Debug` | `{:?}` formatter — always for types that appear in errors / logs |
| `Clone` | Explicit deep copy |
| `Copy` | Implicit copy (tiny value types only) |
| `Default` | Zero value (`T::default()`) |
| `PartialEq` / `Eq` | Equality |
| `PartialOrd` / `Ord` | Ordering |
| `Hash` | Key in `HashMap` / `HashSet` |
| `Display` | `{}` formatter — implement by hand, not derive |
| `Serialize` / `Deserialize` | `serde` |

Don't implement `Display` reflexively — only for types that have a canonical string form.

## `From` / `Into` — conversions

```rust
pub struct Email(String);

impl From<String> for Email {
    fn from(s: String) -> Self { Self(s) }
}

// Get `Into` for free
let e: Email = "a@x.com".to_string().into();
```

Rule: implement `From`, get `Into` free. `TryFrom` / `TryInto` when the conversion may fail.

## `PhantomData`

Tell the compiler about a type parameter that isn't in any field.

```rust
use std::marker::PhantomData;

pub struct Request<State> {
    url: String,
    _state: PhantomData<State>,
}

pub struct Unsent;
pub struct Sent;

impl Request<Unsent> {
    fn send(self) -> Request<Sent> { ... }
}
```

Enables typestate patterns without runtime cost.

## `Sync` and `Send`

Auto-traits, derived automatically when all fields are.

- `Send` — safe to transfer to another thread
- `Sync` — safe to share (`&T`) between threads

`Rc<T>` is neither. `Arc<T>` is both (if inner is `Send + Sync`). `Cell<T>` / `RefCell<T>` are `Send` but not `Sync`.

If your code needs `T: Send + Sync + 'static`, you're probably building a concurrent abstraction. Don't add these bounds reflexively.

## Orphan rule

You can implement `Trait` for `Type` only if at least one of `Trait` / `Type` is defined in your crate. Prevents conflicting impls across crates.

Workaround: wrap the foreign type in a newtype of your own:

```rust
struct MyVec<T>(Vec<T>);
impl<T> SomeForeignTrait for MyVec<T> { ... }
```

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `Box<dyn Trait>` reflex where static dispatch is fine | Use generics unless you need heterogeneity |
| Trait with 20 methods | Split into smaller traits; compose via super-traits |
| Trait defined before there's a second implementer | Wait until you have real use; write concrete first |
| `where T: Sized + Clone + Send + Sync + 'static + Debug` reflex | Only add bounds the code actually uses |
| `impl<T> MyTrait for T` blanket that conflicts with stdlib | Narrow the bound |
| Using `Box<dyn Fn>` when `impl Fn` works | Pay the allocation only when storing closures of different shapes together |
| `#[derive(Clone)]` on every struct | Consider whether callers should clone; they probably shouldn't for big things |
