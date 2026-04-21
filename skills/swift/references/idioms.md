# Swift — Idioms

Value types, optionals, protocols, closures, `guard`, pattern matching.

## `let` / `var`

`let` (constant) by default. `var` only when mutating.

```swift
let name = "A"
var count = 0
```

## Value vs. reference types

- `struct`, `enum`, `tuple` — value types; copied on assignment.
- `class`, `actor` — reference types; shared.

Default to `struct`. Use `class` when you need inheritance (`UIView` subclasses, for framework integration) or shared identity with mutable state. Use `actor` for shared mutable state across concurrency.

```swift
struct User {                          // value type
    let id: String
    var email: String
}

var a = User(id: "u1", email: "a@x.com")
var b = a                              // copy
b.email = "b@x.com"                    // a unchanged
```

## Optionals

Optional = "value or nothing". Different from `null`.

```swift
var name: String? = nil
name.count                             // ❌ compile error

// Unwrap
if let n = name {
    print(n.count)
}
guard let n = name else { return }    // unwrap or exit scope
print(n.count)

name?.count                            // optional chaining → Int?
name ?? "unknown"                      // nil-coalescing
```

`!` is a compile-time assertion that the value is non-nil. Crash at runtime if wrong. Avoid in normal code.

## `guard`

Fail-fast at the top of a function; flat code after.

```swift
func process(user: User?) {
    guard let user = user, user.active else { return }
    // user is now non-optional and active
    work(user)
}
```

Prefer `guard` over nested `if let`s. It keeps the happy path at the outermost scope.

## Structs with behaviour

Structs can have methods, computed properties, and satisfy protocols.

```swift
struct Email {
    let raw: String
    var isValid: Bool { raw.contains("@") }
    func normalized() -> Email { Email(raw: raw.lowercased()) }
}
```

## Enums with associated values

Swift enums carry data. Discriminated unions, like Rust.

```swift
enum Result<T> {
    case success(T)
    case failure(Error)
}

switch result {
case .success(let value):
    use(value)
case .failure(let error):
    log(error)
}
```

Enums are exhaustive — the compiler forces every case. Add a case → every `switch` fails until updated.

## Protocols — small, composable

```swift
protocol Identifiable { var id: String { get } }
protocol Timestamped { var createdAt: Date { get } }

struct User: Identifiable, Timestamped {
    let id: String
    let createdAt: Date
}
```

### Protocol extensions — default implementations

```swift
protocol Named { var name: String { get } }

extension Named {
    func greet() -> String { "Hello \(name)" }
}

struct User: Named { let name: String }
User(name: "A").greet()                // "Hello A"
```

Default methods via extensions. Implementers can override.

### Existentials vs. generics

```swift
// Existential — heterogeneous collection
func renderAll(_ items: [any Renderable]) { ... }

// Generic — homogeneous; faster (static dispatch)
func renderAll<T: Renderable>(_ items: [T]) { ... }
```

Swift 5.6+ requires `any` keyword for existentials. Prefer generics unless you need heterogeneity.

## Closures

```swift
let double: (Int) -> Int = { $0 * 2 }

users.map { $0.email }
users.filter { $0.active }

users.sorted { $0.name < $1.name }
```

Trailing closure syntax is idiomatic. Name parameters when the closure is longer than one line:

```swift
users.sorted { a, b in
    a.name.compare(b.name, options: .caseInsensitive) == .orderedAscending
}
```

## `@escaping` closures

When a closure is stored or called after the function returns, it must be `@escaping`.

```swift
func load(onComplete: @escaping (Result<User, Error>) -> Void) { ... }
```

Inside an `@escaping` closure, `self` must be explicit — which is the language's way of nudging you to think about retain cycles.

```swift
load { [weak self] result in
    guard let self else { return }
    self.update(result)
}
```

For new code, prefer `async` over callbacks whenever possible.

## Extensions

Add methods to existing types without subclassing.

```swift
extension String {
    func toSlug() -> String {
        lowercased().replacingOccurrences(of: " ", with: "-")
    }
}

"Hello World".toSlug()                // "hello-world"
```

Organize by feature. Common pattern:

```swift
// File: User+Formatting.swift
extension User { func displayName() -> String { ... } }
```

Don't add methods with generic names (`.isValid`) that collide across extensions.

## Pattern matching

Beyond `switch` on enum cases:

```swift
let pair = (1, 2)
switch pair {
case (0, 0): print("origin")
case (_, 0): print("x-axis")
case (0, _): print("y-axis")
case (x, y) where x == y: print("diagonal")
case let (x, y): print("(\(x), \(y))")
}

// if case / for case
if case .success(let v) = result { use(v) }
for case .success(let v) in results { use(v) }
```

Use `where` clauses inside `switch` for guards.

## Error handling — throwing functions

```swift
enum ValidationError: Error {
    case emptyEmail
    case invalidAge(Int)
}

func validate(user: User) throws {
    guard !user.email.isEmpty else { throw ValidationError.emptyEmail }
    guard user.age >= 0 else { throw ValidationError.invalidAge(user.age) }
}

do {
    try validate(user: u)
} catch ValidationError.emptyEmail {
    show("email required")
} catch let e as ValidationError {
    show("invalid: \(e)")
} catch {
    log.error("unexpected: \(error)")
}
```

`try?` → `Optional`, `try!` → crash on error (tests only).

## `Result` type

For async callbacks and stored outcomes.

```swift
func fetch(_ url: URL) async -> Result<Data, URLError> { ... }

switch await fetch(url) {
case .success(let data): use(data)
case .failure(let e):    log(e)
}
```

With `async throws`, you usually don't need `Result` — throws flows naturally.

## Access control

| Level | Reach |
|---|---|
| `private` | Declaring scope only |
| `fileprivate` | Whole file |
| `internal` (default) | Module |
| `public` | Cross-module, not subclassable |
| `open` | Cross-module, subclassable |

Default to most-restrictive. Libraries: prefer `public` for API surface; `open` only when subclassing is a designed extension point.

## Property wrappers

Encapsulate storage with behaviour: `@Published`, `@State`, `@AppStorage`, `@UserDefault`.

```swift
@propertyWrapper
struct Clamped<V: Comparable> {
    var wrappedValue: V {
        didSet { wrappedValue = min(max(wrappedValue, range.lowerBound), range.upperBound) }
    }
    let range: ClosedRange<V>
    init(wrappedValue: V, _ range: ClosedRange<V>) {
        self.range = range
        self.wrappedValue = min(max(wrappedValue, range.lowerBound), range.upperBound)
    }
}

struct Config { @Clamped(1...10) var threads: Int = 4 }
```

Used heavily in SwiftUI; write your own sparingly.

## Strings

- `String` — Unicode-correct by default. Subscripting requires `Index`, not `Int`.
- `Character` — a grapheme cluster (may be multiple code points).
- Use `.count` for grapheme count (slow-ish); `.unicodeScalars.count` for code points.

```swift
let s = "héllo"
s.count                                // 5
s[s.startIndex]                        // "h"

// Index arithmetic
let i = s.index(s.startIndex, offsetBy: 2)
s[i]                                    // "l"
```

Avoid `.utf8.count` unless you're measuring bytes for serialization.

## Collections — lazy vs. eager

```swift
users.map { $0.email }                  // eager, allocates
users.lazy.map { $0.email }.filter { $0.contains("@x") }.first(where: ...)
```

Use `.lazy` for chained operations on large collections where you only need a subset.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `!` force-unwrap | Use `if let` / `guard let` / `??` |
| `try!` outside tests | `try` + error handling |
| Force-casting `as!` | Use `as?` and handle `nil`; test types you trust |
| `[String: Any]` in public API | Model a type |
| Class for a pure data type | Use `struct` |
| Storing closures without `[weak self]` | Retain cycle; always think capture semantics |
| `print()` for logging | `Logger` (`os.Logger`) in new code |
| `NSString` / `NSArray` in Swift code | Use native types; bridge at Objective-C boundary |
| `Error` protocol conformance without `LocalizedError` for user-facing errors | Implement `errorDescription` if you surface it in UI |
