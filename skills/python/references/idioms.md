# Python Idioms

Core Pythonic patterns. Language-focused (no architecture here).

## EAFP — Easier to Ask Forgiveness Than Permission

Python prefers exception handling over condition checking.

```python
# Good: EAFP
def get_value(d: dict, key: str, default=None):
    try:
        return d[key]
    except KeyError:
        return default

# Bad: LBYL (Look Before You Leap) — race condition risk, slower, less Pythonic
def get_value(d: dict, key: str, default=None):
    if key in d:
        return d[key]
    return default
```

When to use which: EAFP is Pythonic for dict / attr / file access. LBYL is fine for user-facing validation where the failure message matters.

## Comprehensions

Prefer comprehensions over `map`/`filter` + lambda. Readability wins.

```python
# List / set / dict comprehensions
active_names = [u.name for u in users if u.is_active]
unique_tags = {t.strip() for tag_group in raw for t in tag_group.split(',')}
user_ages = {u.id: u.age for u in users}

# Generator expression (lazy, memory-efficient)
total = sum(order.total for order in orders if order.paid)
```

**Rule**: If the comprehension doesn't fit on 2 lines, rewrite as a `for` loop. Nested comprehensions (`[x for x in y for z in w]`) are almost always unreadable.

## Generator Functions

Lazy iteration for large datasets. Use `yield` to avoid loading everything into memory.

```python
def read_large_file(path: str) -> Iterator[str]:
    with open(path) as f:
        for line in f:
            yield line.strip()

# Caller: streams one line at a time
for line in read_large_file('huge.log'):
    process(line)
```

Generator expressions (parentheses not brackets):
```python
squared = (x * x for x in range(10_000_000))  # 0 memory allocated
```

## Context Managers (`with`)

Use `with` for any resource (file, lock, DB conn, etc.). Never manual `open()` / `close()`.

```python
# File
with open('data.json') as f:
    data = json.load(f)

# Multiple resources
with open('in.txt') as src, open('out.txt', 'w') as dst:
    dst.write(src.read().upper())

# Custom context manager (contextlib)
from contextlib import contextmanager

@contextmanager
def temp_directory():
    d = tempfile.mkdtemp()
    try:
        yield d
    finally:
        shutil.rmtree(d)

with temp_directory() as d:
    # use d, auto-cleaned
    pass
```

## Decorators

Use for cross-cutting concerns (logging, caching, timing, auth). Don't nest more than 2 deep.

```python
# Simple decorator
from functools import wraps

def timed(func):
    @wraps(func)  # preserve name, docstring, signature
    def wrapper(*args, **kwargs):
        start = time.perf_counter()
        result = func(*args, **kwargs)
        duration = time.perf_counter() - start
        logger.info(f"{func.__name__} took {duration:.3f}s")
        return result
    return wrapper

@timed
def expensive_operation(x: int) -> int:
    time.sleep(1)
    return x * 2
```

Parameterized decorators (3 levels deep — use sparingly):
```python
def retry(max_attempts: int = 3):
    def decorator(func):
        @wraps(func)
        def wrapper(*args, **kwargs):
            for attempt in range(max_attempts):
                try:
                    return func(*args, **kwargs)
                except Exception:
                    if attempt == max_attempts - 1:
                        raise
        return wrapper
    return decorator

@retry(max_attempts=5)
def flaky_api_call(): ...
```

## Data Classes

Prefer `dataclass` over manual `__init__` for value objects. Use `frozen=True` for immutability.

```python
from dataclasses import dataclass, field
from typing import ClassVar

@dataclass(frozen=True, slots=True)
class User:
    id: str
    name: str
    email: str
    roles: list[str] = field(default_factory=list)  # never mutable default!
    created_at: datetime = field(default_factory=datetime.now)

    # Class-level constant
    MAX_ROLES: ClassVar[int] = 10
```

**Rules**:
- `slots=True` for performance (Python 3.10+)
- `frozen=True` if the object shouldn't change after creation
- Never use mutable default (`roles: list[str] = []`) — use `field(default_factory=list)`
- `ClassVar` for constants that shouldn't become instance attrs

## `pathlib` over `os.path`

```python
from pathlib import Path

# Good
config = Path.home() / '.myapp' / 'config.json'
if config.exists():
    data = json.loads(config.read_text())
for log in Path('logs').glob('*.log'):
    process(log)

# Bad
import os
config = os.path.join(os.path.expanduser('~'), '.myapp', 'config.json')
if os.path.exists(config):
    with open(config) as f:
        data = json.load(f)
```

## `match`/`case` — structural pattern matching (Python 3.10+)

Use for dispatch on shape, not just value. For simple value checks, `if/elif` is still cleaner.

```python
def describe(point):
    match point:
        case (0, 0):
            return "origin"
        case (0, y):
            return f"y-axis at {y}"
        case (x, 0):
            return f"x-axis at {x}"
        case (x, y) if x == y:
            return f"diagonal at {x}"
        case (x, y):
            return f"point ({x}, {y})"
        case _:
            return "not a point"

# Class patterns — great for ADTs / sum types
match event:
    case Click(x=x, y=y):
        handle_click(x, y)
    case KeyPress(key="q"):
        quit()
    case KeyPress(key=k):
        handle_key(k)
```

**When NOT to use**: straightforward value checks (`if x == 1: ... elif x == 2: ...`). Pattern matching shines for destructuring nested shapes.

## Walrus operator `:=` (Python 3.8+)

Assignment expression — assign and use in the same statement. Use sparingly.

```python
# Good: avoid double-reading / double-computing
while chunk := f.read(8192):
    process(chunk)

if (n := len(data)) > 10:
    print(f"Too many items ({n})")

# Good in comprehensions: avoid recomputing
results = [y for x in items if (y := expensive(x)) is not None]

# Bad: over-use where a regular assignment is clearer
if (user := db.find(uid)) and user.active and (perms := user.get_perms()) and "admin" in perms:
    ...
# Prefer:
user = db.find(uid)
if user and user.active:
    perms = user.get_perms()
    if "admin" in perms: ...
```

## f-strings (Python 3.6+)

Only use `.format()` or `%` for legacy code.

```python
# Good
msg = f"User {user.name} (id={user.id}) logged in at {when:%Y-%m-%d %H:%M}"

# Also good: f-string expressions
msg = f"Total: ${sum(o.amount for o in orders):,.2f}"

# Python 3.8+: self-documenting expressions with =
msg = f"{x=}, {y=}"   # => "x=5, y=10"

# Python 3.12+: f-strings accept any quotes, backslashes, and multiline
msg = f"path: {Path('a') / 'b'}, lines:\n{"\n".join(items)}"

# Bad
msg = "User {} (id={}) logged in at {}".format(user.name, user.id, when)
msg = "User %s (id=%d) logged in at %s" % (user.name, user.id, when)
```

## Forbidden patterns (auto-reject in code review)

| Anti-pattern | Why bad | Fix |
|---|---|---|
| `def f(x=[])` | Mutable default shared across calls | `def f(x=None): x = x or []` |
| `except:` (bare) | Catches SystemExit, KeyboardInterrupt | `except SomeError:` |
| `from m import *` | Pollutes namespace, hides origin | explicit imports |
| `global x` in functions | Hidden state | pass explicitly or use a class |
| `type(x) == Foo` | Doesn't handle subclasses | `isinstance(x, Foo)` |
| `if x == None` | Identity check, not equality | `if x is None` |

## Naming conventions (PEP 8)

| Kind | Style | Example |
|---|---|---|
| Variables, functions | `snake_case` | `user_count`, `get_user()` |
| Constants | `UPPER_SNAKE` | `MAX_RETRIES`, `DEFAULT_TIMEOUT` |
| Classes | `PascalCase` | `UserService`, `HTTPClient` |
| Private (intent) | `_leading_underscore` | `_internal_cache` |
| Name mangling | `__double_leading` | `__private_attr` (use sparingly) |
| Module, package | `snake_case` | `user_service.py`, `payment_gateway/` |
