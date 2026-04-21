# Clean Code

Function shape, DRY vs WET, comments, dead code, magic numbers. Language-neutral hygiene.

## Functions

### One thing

A function should do one thing, at one level of abstraction. If the function's name needs "and", split it.

```
# ❌
def validate_and_save_user(user): ...

# ✅
def validate(user): ...
def save(user): ...

def register_user(user):
    validate(user)
    save(user)
```

### Small

Rough targets, not dogma:
- Functions ≤ 20 lines most of the time.
- If a function has three indentation levels, consider extracting.
- A function you can't see in one screen is a warning sign.

Exceptions: a switch-like dispatch that's naturally long is fine. A 200-line function because you kept adding cases is not.

### Arguments — few

Zero is best. One is fine. Two is OK. Three is suspicious. Four is a refactor.

```
# ❌
create_user(name, email, age, role, active, parent_id, billing_addr, shipping_addr, ...)

# ✅ — group related args
create_user(identity, profile, permissions)
```

Boolean flags doubly so:

```
# ❌
render_page(user, is_admin, is_preview, skip_cache)

# ✅ — flags mean you're doing two things in one function
render_page_for_admin(user, options)
render_preview_page(user)
```

### Return one type

If a function can return a `User`, or `None`, or a string error code, pick one contract. Use `Optional` or a result type for "success or not found". Don't overload the return to mean three different things.

### Pure where possible

Pure = same input produces same output, no side effects. Pure code is trivial to test and reason about. Push side effects (I/O, state mutation, logging) to the edges.

```
# core: pure
def calculate_price(items, promo): ...

# edge: side effects
def checkout(items, promo):
    price = calculate_price(items, promo)
    payment = charge(price)
    db.save_order(items, price, payment.id)
    eventBus.publish(OrderPlaced(...))
```

## DRY vs WET — know the ratio

| Situation | Do |
|---|---|
| Two similar snippets | **Duplicate**. Too early to know the shape. |
| Three similar snippets | Consider abstracting — if the shape is clear. |
| Four+ similar snippets | Abstract; you've learned what varies. |

Bad abstractions cost more than duplication. A wrong shape locks every caller into a detour forever.

Rule: abstract when the shape is obvious, not when the count reaches a number.

## Comments

Default: don't write one. If you do, explain *why*, never *what*.

```
# ❌ noise
i += 1   # increment i

def save(user):
    # saves a user
    db.insert(user)

# ✅ non-obvious why
# Upstream API returns 503 for ~500ms during leader election;
# retry window tuned from their SRE post, not ours.
sleep(0.6)

# HACK: patch until [TICKET-481] lifts the 100-col DB constraint.
name = name[:100]
```

Delete comments that:
- Restate the code (`# loop over items`)
- Restate the function name (`# validates input`)
- Are out of date (the code changed; the comment didn't)
- Reference past states (`# was previously doing X`)

Git remembers history. Code is the present tense.

### Docstrings

For public functions/classes. Describe contract, not implementation.

```
# ✅
"""Return the canonical URL for this resource, or None if it isn't published."""

# ❌
"""This function takes a resource and returns its URL by looking up the slug in the DB."""
```

One sentence is often enough. Longer docstrings: inputs, outputs, errors, side effects.

## Dead code — delete it

If a function, class, or branch is unreachable, remove it. "Just in case" is not a reason to keep dead code.

- Unused imports → remove
- Commented-out code → remove (git has it)
- `if False:` branches → remove
- `TODO` from two years ago → remove or fix

Dead code rots. It confuses readers, breaks grep, and occasionally gets re-animated with stale assumptions.

## Magic numbers and strings

Named constants when the value has meaning. Literals are fine when they're self-explanatory.

```
# ✅ named — intent is clear
MAX_LOGIN_ATTEMPTS = 5
DEFAULT_PAGE_SIZE  = 20
HTTP_OK            = 200

# ✅ literal — self-explanatory in context
str[:10]
for i in range(3): ...
x * 2

# ❌ magic
if user.attempts > 5: ...
if status == "pa":       # what's "pa"?
```

## Early return over nested conditions

Flatter reads better than deeply nested `if`s.

```
# ❌ pyramid of doom
def process(user):
    if user is not None:
        if user.is_active:
            if user.has_permission():
                if user.payment_method_valid():
                    return do_thing(user)
    return None

# ✅ guard clauses, early returns
def process(user):
    if user is None: return None
    if not user.is_active: return None
    if not user.has_permission(): return None
    if not user.payment_method_valid(): return None
    return do_thing(user)
```

## Avoid mutable global state

Global mutables are action at a distance. A test sets a flag → unrelated tests fail.

```
# ❌
_CURRENT_USER = None

def set_user(u): global _CURRENT_USER; _CURRENT_USER = u
def current(): return _CURRENT_USER

# ✅ pass explicitly, or use a request-scoped context
def handler(req, user):
    current_user = resolve_user(req)
    ...
```

Request-scoped context objects are fine (HTTP request context, trace context). Globals for business data are not.

## Avoid clever one-liners

If a line needs 30 seconds to parse, it costs every future reader 30 seconds.

```
# ❌
return [next((v for v in xs if p(v, k)), default) for k in sorted({f(x) for x in data} - skip)]

# ✅
keys = {f(x) for x in data} - skip
out = []
for k in sorted(keys):
    match = next((v for v in xs if p(v, k)), default)
    out.append(match)
return out
```

Density ≠ clarity. A loop you can read in one pass beats a comprehension you have to puzzle out.

## Prefer immutability

Where the language supports it, prefer immutable values.

- Makes reasoning local (a value can't change out from under you)
- Safer in concurrent code
- Better cache keys, better log entries

Use mutation for internal data structures when performance matters. Don't propagate mutation to the public API.

## Feature flags — clean up

Flags are temporary. Long-lived flags become part of the product accidentally.

```
# a few weeks after launch
if feature_enabled("partial_shipments"):
    ...

# six months later: rollout is done. Inline. Delete the flag.
```

Track flag age. Delete dead flags. A flag that's been "on for everyone" for three months is technical debt.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| 200-line function | Extract; each piece named for intent |
| Mixing abstraction levels (business rule + DB call + HTTP call) | Layer: see backend/layering |
| Flag arguments (`do(x, is_special=True)`) | Split into two functions |
| "Utils" modules | Split by domain; utils becomes a dumping ground |
| Deep nesting | Guard clauses, early returns |
| Duplicated constants across files | Promote to a shared constants module |
| Commented-out code "in case we need it" | Delete; git has it |
| Over-abstracted single-use interface | Delete the interface; use the concrete type |
