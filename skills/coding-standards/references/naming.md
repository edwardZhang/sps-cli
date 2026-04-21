# Naming

Names are the cheapest form of documentation and the most-read part of a codebase.

## The test

If you can name something clearly, you understand it. If every name you try is bad, the concept is bad.

## Principles

1. **Intention over implementation.** `active_users`, not `filtered_list`. `is_expired`, not `flag`.
2. **Domain over mechanics.** `price_in_cents` over `value_int`. Names should read like the business, not the code.
3. **Consistent vocabulary.** Pick one word per concept. `fetch / retrieve / load / get` → choose one, stick to it. Same for `user / account / customer` — they are different things; don't conflate.
4. **Searchable.** A two-letter name is unsearchable. `i` in a three-line loop is fine; `i` as a module-level variable is not.
5. **No encodings.** `strName`, `iCount`, `bFlag` (Hungarian notation) adds noise without signal — languages have types.
6. **Avoid disinformation.** `user_list` that isn't actually a list is a trap. `account_map` that's a list of pairs is a trap.

## Functions — verbs

Describe what they do, not how.

```
# ✅
calculate_total(order)
send_welcome_email(user)
mark_as_read(notification)

# ❌
process(x)                   # process what?
handle_thing(data)           # what thing? what handling?
do_work()                    # cool
```

## Booleans — predicates

`is_`, `has_`, `can_`, `should_` prefixes read naturally in conditionals.

```
if is_active and has_permission(READ) and not is_expired: ...
```

Avoid double negatives: `is_not_disabled` is a trap. Flip to `is_enabled`.

## Collections — plural nouns

```
users        : list of User
user         : single User
users_by_id  : map from id to User
```

Don't name the container in the name: `user_list` is redundant when the type is `list[User]`. Reserve `_list` / `_map` suffixes for when you have multiple collections of the same thing and need to disambiguate.

## Numbers — include units

Units in the name prevent entire categories of bugs.

```
# ✅
timeout_seconds    = 30
price_cents        = 2599
file_size_bytes    = 1024
latency_ms         = 87

# ❌
timeout = 30            # seconds? ms?
price = 25.99           # USD? EUR?
size = 1024             # bytes? KB? items?
```

Mixed-unit bugs (feet vs meters) have crashed spacecraft. They crash billing systems too.

## Variables — scope dictates length

Short scope → short name. Long scope → longer, more descriptive name.

```
# OK in a three-line loop
for i, x in enumerate(items):
    xs[i] = f(x)

# Not OK at module scope
x = load_all_records()          # x? x of what?
```

## Functions returning booleans

Read as a predicate in an `if`.

```
# ✅
if user.can_edit(document): ...

# ❌
if user.edit_permission(document): ...     # reads weird
```

## Async / concurrent

Mark functions that do I/O or schedule work.

```
async def fetch_user(id): ...
def fetch_user_async(id): ...          # in langs without `async` marker
```

Callers need to know they're awaiting something.

## Types — nouns, in the singular

```
class User: ...               # a user
class UserRepository: ...     # manages users
class UserNotFoundError: ...  # specific, actionable
```

## Avoiding "magic"

Replace literal numbers and strings with named constants when the meaning is non-obvious.

```
# ❌
if user.age >= 18: ...
sleep(86400)

# ✅
LEGAL_ADULT_AGE = 18
ONE_DAY_SECONDS = 86400

if user.age >= LEGAL_ADULT_AGE: ...
sleep(ONE_DAY_SECONDS)
```

Exception: one-off small numbers that read naturally — `x * 2`, `str[0:10]` — don't need constants.

## Events / notifications — past tense, subject-first

```
OrderPlaced, OrderShipped, UserRegistered, PaymentFailed
```

Not `PlaceOrder` (that's a command), not `OrderIsShipped` (noise). Events describe things that happened; commands describe things requested.

## Files, modules, packages

- **Lowercase, hyphen- or underscore-separated**, depending on the language.
- Name by what's inside, not by mechanics. `user_service.py` > `helpers.py`.
- Avoid kitchen-sink files: `utils`, `common`, `misc`, `helpers` — they become dumping grounds.

## Endpoints, routes

- Plural resource nouns: `/users`, `/orders/{id}/items`.
- Kebab-case, not snake_case or camelCase in paths: `/user-sessions`, not `/userSessions`.
- No verbs when CRUD fits: `POST /orders`, not `POST /createOrder`.

## Feature flags

Describe the capability, not the date, not the ticket.

```
# ✅
checkout_v2_enabled
redis_session_store_enabled

# ❌
temp_flag_jan_2026
jira_1234_rollout
```

Flags outlive the ticket and the engineer who wrote it. Name for what the flag *does*.

## Renaming is cheap; bad names compound

IDEs rename safely across projects. If a name is wrong, fix it now. Six months of new code built on top of a confused name will be six months of confusion.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `data`, `info`, `item`, `manager`, `handler` | Say what it actually represents |
| `foo_list` when it's a set | Use `foo_set` or just `foo` + typed container |
| Ambiguous pairs: `user` / `account` / `customer` interchangeably | Define the distinction; use the right one |
| Mixed naming conventions in one file | Follow the language's convention; don't invent your own |
| Abbreviations that aren't standard | `usr`, `mngr`, `proc` — spell them out |
| Numbered copies: `process1`, `process2`, `processFinal`, `processFinalV2` | Delete the old ones; one canonical name |
