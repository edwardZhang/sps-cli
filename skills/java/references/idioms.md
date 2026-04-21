# Java — Idioms

Records, sealed types, streams, `Optional`, modern collections.

## Records — data classes done right

```java
public record User(String id, String email, boolean active) {}

var u = new User("u1", "a@x.com", true);
u.email();                 // accessor
new User("u1", "a@x.com", false).equals(u);   // false — structural equality
```

Records give you `equals`, `hashCode`, `toString`, and component accessors for free.

Compact canonical constructor for validation:

```java
public record Email(String value) {
    public Email {
        if (!value.contains("@")) throw new IllegalArgumentException("bad email");
    }
}
```

Don't use records when you need mutation, inheritance, or behaviour beyond data + validation.

## Sealed types + pattern switch

Model sum types exhaustively.

```java
public sealed interface Result<T>
    permits Result.Ok, Result.Err {
    record Ok<T>(T value)      implements Result<T> {}
    record Err<T>(String error) implements Result<T> {}
}

String handle(Result<User> r) {
    return switch (r) {
        case Result.Ok(var u)      -> "got " + u.email();
        case Result.Err(var msg)   -> "fail " + msg;
    };                   // no default — compiler enforces exhaustiveness
}
```

`permits` limits implementers to the named classes. Add a new variant → every `switch` breaks until updated.

## `var` — locals only

```java
var users = userRepo.findAll();           // List<User>
var map   = new HashMap<String, List<Order>>();
```

Don't use `var` in method signatures, field declarations, or where the inferred type would surprise a reader.

```java
// ❌ — what is x?
var x = svc.doThing();

// ✅ keep the type when not obvious
List<User> users = svc.loadUsers();
```

## `Optional<T>`

For **return values** that might legitimately be absent.

```java
Optional<User> findById(String id) { ... }

findById(id)
    .map(User::email)
    .orElseThrow(() -> new NotFoundException("no user " + id));
```

Never:
- `Optional` as a field type (serialization headache, mutable wrapper)
- `Optional` as a method parameter (overloads are clearer)
- `Optional.get()` without `isPresent()` (same bug as `unwrap`)

## Collections

```java
List<String> immutable = List.of("a", "b", "c");
Map<String, Integer> m = Map.of("a", 1, "b", 2);
Set<String> s         = Set.of("x", "y");

var mutable = new ArrayList<String>();
mutable.add("a");

var copy = List.copyOf(mutable);           // defensive copy, unmodifiable
```

Prefer `List.of` / `Map.of` for small known data. Prefer `ArrayList` / `HashMap` for mutable.

## Streams

Concise collection transformations.

```java
var emails = users.stream()
    .filter(User::active)
    .map(User::email)
    .toList();

var byRole = users.stream()
    .collect(Collectors.groupingBy(User::role));

var count = users.stream().filter(User::active).count();
```

Rules:
- `toList()` (Java 16+) over `collect(Collectors.toList())`.
- Don't use streams for simple for-loops with side effects — the loop is clearer.
- Don't mix stream and `forEach` for state mutation; prefer `collect` / `reduce`.

Stream of a single op doesn't improve readability:

```java
// ❌
list.stream().filter(p).findFirst().orElse(null);

// ✅
list.stream().filter(p).findFirst().orElseThrow();
// or use a library method if it exists
```

## `switch` expressions

```java
String label = switch (status) {
    case ACTIVE   -> "active";
    case PENDING  -> "pending";
    case BANNED   -> "banned";
};

// Pattern matching (preview/stable depending on JDK)
var description = switch (shape) {
    case Circle c    -> "circle r=" + c.radius();
    case Square s    -> "square s=" + s.side();
    case null, default -> "unknown";
};
```

Arrow `->` form has no fall-through. Traditional `case X:` has fall-through — avoid.

## Exceptions

- **Checked** (`extends Exception`) — recoverable, documented in signature.
- **Unchecked** (`extends RuntimeException`) — programmer errors, boundary validation.

```java
public class ValidationException extends RuntimeException {
    private final String field;
    public ValidationException(String field, String msg) {
        super(msg);
        this.field = field;
    }
    public String field() { return field; }
}
```

Chain the cause:

```java
try { ... }
catch (IOException e) {
    throw new ConfigException("loading " + path, e);    // ← pass e as cause
}
```

Never catch `Throwable` / `Exception` and swallow. Catch specifics, log, handle or rethrow.

## `final` — for invariants

- On class: no subclasses.
- On method: can't override.
- On field: immutable reference.
- On local / param: can't reassign (noisy; `var` encourages it implicitly).

Records' components are implicitly final.

Don't sprinkle `final` on every local — IDEs and modern reviewers treat it as clutter unless the team convention says otherwise.

## Nullability

Java doesn't have built-in non-null types. Options:

- **`@Nullable` / `@NonNull`** from JSR-305, JetBrains, or Checker Framework.
- **Records + `@NotNull` in canonical constructor validation.**
- **Kotlin interop** — declare nullability to help Kotlin callers.

Pick one annotation set; configure your IDE + CI to enforce it.

## `java.time.*` — not `Date`

```java
var now     = Instant.now();
var today   = LocalDate.now();
var inZone  = ZonedDateTime.now(ZoneId.of("Asia/Tokyo"));
var later   = now.plus(Duration.ofMinutes(30));

Instant.parse("2026-04-21T10:00:00Z");
DateTimeFormatter.ofPattern("yyyy-MM-dd").format(today);
```

`java.util.Date` and `Calendar` are deprecated in spirit; every use is a code smell in new code.

## Equality

- `equals()` for value equality; `==` for reference equality.
- `record` gets `equals` automatically.
- For classes, use IDE / Lombok / `EqualsBuilder` — never hand-write `equals` without `hashCode` to match.

```java
Objects.equals(a, b);                  // null-safe
Objects.hash(field1, field2);
```

## String

```java
String s = "hi";
String formatted = "user %s (%d)".formatted(name, count);     // Java 15+
String multiline = """
    Hello
    %s
    """.formatted(name);                                        // text blocks (15+)

var sb = new StringBuilder();          // for building in loops
```

`String.format` for static strings is fine. `"...".formatted(...)` reads better.

`String.repeat(n)`, `String.strip()` (vs `trim()` which is ASCII-only) are modern.

## Lambdas vs. method references

```java
users.stream().map(u -> u.email());         // lambda
users.stream().map(User::email);             // method ref — preferred when trivial

users.stream().filter(u -> u.active());
users.stream().filter(User::active);

// Constructor reference
users.stream().map(name -> new User(name)).toList();
users.stream().map(User::new).toList();
```

Method references when the operation is a direct member access. Lambdas when there's any extra logic.

## Builder pattern

For types with many optional fields, use a builder. Lombok provides `@Builder`; libraries like Immutables generate it.

```java
var req = HttpRequest.builder()
    .url("https://x.com")
    .timeout(Duration.ofSeconds(5))
    .header("X-Auth", token)
    .build();
```

For records, a static factory + named params via builder is common.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `public` mutable fields | Getters or records |
| `if (x == null) throw new NullPointerException(...)` everywhere | Non-null annotations + validate at boundary |
| `instanceof x + cast` chains | Pattern switch / sealed types |
| Anonymous inner class for a SAM | Lambda |
| `Collections.unmodifiableList(new ArrayList<>(...))` | `List.copyOf(...)` |
| Hand-rolled `equals` / `hashCode` on data classes | Record or generated code |
| Catching `Exception e` to "simplify" | Catch specific; let unknown propagate |
| `System.out.println` in production | Use SLF4J / `java.util.logging` |
| `Thread.currentThread().sleep(...)` | `Thread.sleep(...)` — static method; use as such |
| `new Integer(x)` / `new String(x)` | Use valueOf / literal |
