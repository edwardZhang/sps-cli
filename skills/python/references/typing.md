# Python Type Hints

Modern typing for public APIs. Python 3.9+ syntax preferred.

## Baseline: type all public APIs

Every public function, method, class attribute gets a type hint. Private helpers can skip if the type is obvious from context.

```python
def process_user(
    user_id: str,
    data: dict[str, Any],
    active: bool = True,
) -> User | None:
    """Update a user. Returns the updated User or None if inactive."""
    if not active:
        return None
    return User(user_id, data)
```

## Modern syntax (Python 3.9+)

Use built-in generics, drop `typing.List` / `typing.Dict` imports.

```python
# Python 3.9+  ✅
def process(items: list[str]) -> dict[str, int]:
    return {item: len(item) for item in items}

# Python 3.8 and earlier — legacy only
from typing import List, Dict
def process(items: List[str]) -> Dict[str, int]: ...
```

## Optional / Union

Python 3.10+: use `|` instead of `Union` / `Optional`.

```python
# Python 3.10+  ✅
def find(id: str) -> User | None: ...
def parse(raw: str | bytes) -> dict: ...

# Python 3.9 and earlier
from typing import Optional, Union
def find(id: str) -> Optional[User]: ...
def parse(raw: Union[str, bytes]) -> dict: ...
```

## Type aliases

Name complex types. Makes signatures self-documenting.

```python
from typing import TypeAlias

JSON: TypeAlias = dict[str, Any] | list[Any] | str | int | float | bool | None
UserId: TypeAlias = str
RequestHeaders: TypeAlias = dict[str, str]

def fetch(user_id: UserId, headers: RequestHeaders) -> JSON: ...
```

## Generics

For functions that work over any type while preserving relationships.

### Python 3.12+: PEP 695 type parameter syntax

Inline declaration, no `TypeVar` import needed.

```python
# Generic function
def first[T](items: list[T]) -> T | None:
    return items[0] if items else None

# Bounded type parameter
def clamp[N: (int, float)](value: N, lo: N, hi: N) -> N:
    return max(lo, min(value, hi))

# Generic class
class Stack[T]:
    def __init__(self) -> None:
        self._items: list[T] = []
    def push(self, item: T) -> None: self._items.append(item)
    def pop(self) -> T: return self._items.pop()

# Type alias (PEP 695)
type JSON = dict[str, "JSON"] | list["JSON"] | str | int | float | bool | None
type UserId = str
```

### Python 3.11 and earlier: `TypeVar`

```python
from typing import TypeVar

T = TypeVar('T')

def first(items: list[T]) -> T | None:
    return items[0] if items else None

N = TypeVar('N', bound=int | float)

def clamp(value: N, lo: N, hi: N) -> N:
    return max(lo, min(value, hi))
```

## `Self` type (Python 3.11+)

Reference the enclosing class without string forward references.

```python
from typing import Self

class QueryBuilder:
    def where(self, **kwargs) -> Self:
        self._filters.update(kwargs)
        return self
    def limit(self, n: int) -> Self:
        self._limit = n
        return self

# Subclass chaining preserves the subclass type
class UserQuery(QueryBuilder):
    def active(self) -> Self:
        return self.where(active=True)

UserQuery().active().limit(10)  # still typed as UserQuery, not QueryBuilder
```

## `@override` decorator (Python 3.12+)

Catch accidental method-name drift when the parent renames.

```python
from typing import override

class Base:
    def process(self) -> None: ...

class Derived(Base):
    @override
    def process(self) -> None: ...   # type-checked: errors if Base.process is renamed or gone

    @override
    def procces(self) -> None: ...   # ❌ mypy/pyright error: not overriding anything
```

## `ParamSpec` — typed decorators

Preserve the signature of the wrapped function.

```python
from typing import ParamSpec, TypeVar, Callable
from functools import wraps

P = ParamSpec('P')
R = TypeVar('R')

def timed(func: Callable[P, R]) -> Callable[P, R]:
    @wraps(func)
    def wrapper(*args: P.args, **kwargs: P.kwargs) -> R:
        return func(*args, **kwargs)
    return wrapper

# Python 3.12+ syntax
def timed[**P, R](func: Callable[P, R]) -> Callable[P, R]:
    ...
```

## Protocols — structural typing

Interface without inheritance. Works like Go interfaces or TypeScript interfaces.

```python
from typing import Protocol

class Renderable(Protocol):
    def render(self) -> str: ...

# Any class with a matching .render() method satisfies Renderable —
# no need to inherit from it.
class Card:
    def render(self) -> str:
        return f"Card: {self.title}"

def render_all(items: list[Renderable]) -> str:
    return "\n".join(item.render() for item in items)

# Works without any declaration:
render_all([Card("A"), Card("B")])
```

## Literal types

Constrain values to a fixed set.

```python
from typing import Literal

LogLevel = Literal['debug', 'info', 'warning', 'error', 'critical']

def log(msg: str, level: LogLevel = 'info') -> None: ...

log("x", "info")       # ✅
log("x", "verbose")    # ❌ type error
```

## TypedDict — structured dicts

When you're stuck with dict but want type safety.

```python
from typing import TypedDict

class UserDict(TypedDict):
    id: str
    name: str
    email: str
    active: bool

def process(user: UserDict) -> None:
    print(user['name'])  # type-checked as str
```

## Class attributes: `ClassVar` vs `Final`

```python
from typing import ClassVar, Final
from dataclasses import dataclass

@dataclass
class Config:
    url: str                              # instance attr
    timeout: int = 30                      # instance attr with default
    VERSION: ClassVar[str] = '1.0'         # class-level constant
    MAX_RETRIES: Final[int] = 3            # cannot be reassigned
```

## Callable types

Types for function parameters.

```python
from typing import Callable

# Callable[[arg_types...], return_type]
def apply(func: Callable[[int, int], int], a: int, b: int) -> int:
    return func(a, b)

apply(lambda x, y: x + y, 2, 3)  # 5
```

## When to skip types

Private one-liners where the type is obvious:
```python
# Fine — _hash is clearly int from hashlib
def _hash(s): return hashlib.sha256(s.encode()).hexdigest()
```

Test functions: types are usually redundant if the test body makes them obvious.

## Runtime type checking

Most type hints are **not** enforced at runtime. Use `mypy` or `pyright` in CI.

```bash
# mypy.ini
[mypy]
strict = true
python_version = 3.11
warn_return_any = true
warn_unused_ignores = true
```

For runtime validation at API boundaries, use `pydantic` or `attrs` — not type hints.

## Type ignore comments

Use sparingly. Narrow the suppression to the exact issue.

```python
# ignore one specific line
result = legacy_api()  # type: ignore[no-untyped-call]

# for whole file (top of file, last resort)
# type: ignore
```

Never bare `# type: ignore` with no specific code. Reviewers can't tell what was suppressed.
