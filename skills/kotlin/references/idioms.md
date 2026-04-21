# Kotlin — Idioms

Null safety, data classes, sealed classes, scope functions, extension functions.

## `val` / `var` / `const val`

```kotlin
val name = "A"              // immutable reference
var count = 0               // mutable
const val MAX = 10          // compile-time constant (top-level or in `object`)
```

`val` by default. Reach for `var` only when you reassign.

## Nullable types

```kotlin
var name: String? = null
name.length                 // ❌ compile error
name?.length                // Int? — null if name is null
name!!.length               // throws NPE if null — avoid
name ?: "unknown"           // Elvis: use default if null

if (name != null) {
    name.length             // smart-cast to String
}
```

`!!` is a code smell. Every `!!` should have a comment saying why the value is guaranteed non-null there (and, ideally, a test that checks it).

## Type inference

```kotlin
val n = 10                          // Int
val s = "hi"                        // String
val users: List<User> = fetch()     // annotate when intent is ambiguous
```

Annotate public API return types for clarity; let locals infer.

## Data classes

```kotlin
data class User(val id: String, val email: String, val active: Boolean)

val u = User("u1", "a@x.com", true)
val updated = u.copy(email = "b@x.com")
u == User("u1", "a@x.com", true)     // true — structural equality
```

Data classes give you `equals`, `hashCode`, `toString`, `copy`, destructuring for free.

Don't use data classes for types with behaviour or invariants. If you need a factory or a validation step, make it a regular class with a private constructor + `companion object` factory.

## Sealed classes — the Kotlin discriminated union

```kotlin
sealed class Result<out T> {
    data class Ok<T>(val value: T) : Result<T>()
    data class Err(val error: String) : Result<Nothing>()
}

fun handle(r: Result<User>) = when (r) {
    is Result.Ok  -> use(r.value)
    is Result.Err -> log(r.error)
    // `when` is exhaustive — no else needed
}
```

`sealed` limits subclasses to the same file (Kotlin < 1.5) or same module (1.5+).

## `when` — the superior switch

```kotlin
val label = when (status) {
    Status.Active   -> "active"
    Status.Pending  -> "pending"
    Status.Banned   -> "banned"
}

// Smart patterns
val x = when {
    n < 0       -> "neg"
    n == 0      -> "zero"
    n in 1..10  -> "small"
    else        -> "big"
}

// With is + smart-cast
when (v) {
    is String -> v.length      // v: String
    is Int    -> v + 1          // v: Int
}
```

Exhaustive `when` over `sealed` / `enum` → no `else` required; the compiler forces you to update every branch when you add a case.

## Scope functions — `let` / `run` / `apply` / `also` / `with`

```kotlin
user?.let { send(it) }                          // null-safe "do something with it"
val formatted = user.run { "$name <$email>" }   // use members inside
val req = Request().apply { url = x; timeout = 5 } // configure, return self
list.also { log("about to sort: $it") }.sort()   // side effect, return self
```

| | Receiver | Returns |
|---|---|---|
| `let` | `it` | lambda result |
| `run` | `this` | lambda result |
| `apply` | `this` | receiver |
| `also` | `it` | receiver |
| `with(x)` | `this` | lambda result |

Quick guide:
- **Side effect, keep value** → `also`
- **Configure a builder** → `apply`
- **Null-safe transformation** → `let`
- **Computation using members** → `run`

Don't chain three+ scope functions — it gets confusing fast.

## Extension functions

Add methods to existing types without inheriting.

```kotlin
fun String.toSlug(): String = lowercase().replace(" ", "-")

"Hello World".toSlug()      // "hello-world"
```

Rules:
- Can't access private members; no reflection shortcuts.
- Dispatch is static (by declared type, not runtime type) — don't use to "override" methods.
- Place in a file named for the extended type (`StringExt.kt`) or feature (`Slug.kt`).

## Destructuring

```kotlin
val (id, email) = user                   // positional, for data classes
val (key, value) = map.entries.first()

for ((i, x) in list.withIndex()) { ... }
```

Don't destructure too-far-apart fields; order becomes a secret convention.

## Default & named arguments

```kotlin
fun send(to: String, subject: String, body: String = "", priority: Int = 0) { ... }

send(to = "a@x.com", subject = "hi")
send("a@x.com", "hi", priority = 1)
```

Prefer named args at call sites with 3+ params. Defaults obviate overload explosions.

## Single-expression functions

```kotlin
fun double(x: Int) = x * 2
fun greet(name: String): String = "hi $name"
```

Keep for functions that really fit on one line. Force explicit return type on public API.

## Collection API

```kotlin
// Read-only vs mutable
val immutable: List<Int> = listOf(1, 2, 3)
val mutable: MutableList<Int> = mutableListOf(1, 2, 3)

// Transformations
users.filter { it.active }.map { it.email }
users.groupBy { it.role }
users.associateBy { it.id }          // Map<id, user>
users.sortedBy { it.name }
users.partition { it.active }        // Pair<active, inactive>

// Aggregations
users.count { it.active }
users.sumOf { it.balance }
users.maxByOrNull { it.age }
```

Chain 2–3 ops. Beyond that, break into named intermediate values or pull into a function.

`asSequence()` for lazy evaluation over large collections:
```kotlin
users.asSequence().filter { ... }.map { ... }.take(10).toList()
```

## Ranges

```kotlin
1..10          // IntRange (inclusive)
1 until 10     // IntRange 1..9 (exclusive upper)
10 downTo 1    // reversed
1..10 step 2   // 1, 3, 5, 7, 9
```

Prefer ranges over manual `for (i = ...; i < ...; i++)` — clearer intent.

## String templates

```kotlin
val msg = "Hello $name, you have ${messages.size} messages"
val raw = """
    Multi-line
    ${expression}
    """.trimIndent()
```

No need for format strings in most cases.

## Object expressions & declarations

```kotlin
// Singleton
object Config {
    val url = "https://api.example.com"
}
Config.url

// Anonymous object
val listener = object : Listener {
    override fun onEvent(e: Event) { ... }
}
```

Use `object` for singletons and one-off anonymous impls. Avoid `object` for mutable state — it's a global and hard to test.

## `companion object`

```kotlin
class User private constructor(val id: String) {
    companion object {
        fun create(email: String): User = User(generateId(email))
    }
}

User.create("a@x.com")
```

Factory methods, constants, static-like helpers live here.

## Java interop essentials

- `@JvmStatic` on `companion object` members to expose them as static methods to Java
- `@JvmField` to expose a `val` / `var` as a Java field
- `@JvmOverloads` to generate overloads for default params
- Platform types (`String!`) — values from Java with unknown nullability; treat as non-null by convention OR check.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `!!` used as "I promise this isn't null" | Restructure so the type proves it; or check and handle |
| `lateinit` in application code | Use `by lazy { ... }` or pass via constructor |
| `Unit`-returning function ending with `return Unit` | Implicit; remove |
| `if-else` chain where `when` is clearer | Use `when` |
| `var x: List<T> = mutableListOf()` — type vs reality mismatch | Pick one: `val x: MutableList<T>` or use `+` for new lists |
| Data class used for behaviour-heavy type | Regular class; keep data classes for values |
| Extension functions that hide bugs (subtle override attempts) | Extension dispatch is static; don't rely on polymorphism |
| `companion object` holding request-scoped state | Request scope belongs on a request-scoped object |
