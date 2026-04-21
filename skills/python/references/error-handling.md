# Python Error Handling

Exception design and handling patterns.

## Specific exceptions only

Never `except:` (bare). Never `except Exception:` except at the top of a daemon/server loop.

```python
# Good: specific exceptions, each with its own response
def load_config(path: str) -> Config:
    try:
        with open(path) as f:
            return Config.from_json(f.read())
    except FileNotFoundError as e:
        raise ConfigError(f"Config not found: {path}") from e
    except json.JSONDecodeError as e:
        raise ConfigError(f"Invalid JSON in {path}: {e}") from e
    except PermissionError as e:
        raise ConfigError(f"No read permission: {path}") from e

# Bad: silent catch-all
def load_config(path: str) -> Config:
    try:
        with open(path) as f:
            return Config.from_json(f.read())
    except:
        return None  # caller has no idea what went wrong
```

## Exception chaining (`from`)

Always preserve the original traceback when re-raising.

```python
def process(data: str) -> Result:
    try:
        parsed = json.loads(data)
    except json.JSONDecodeError as e:
        # `from e` attaches the original exception
        raise ValueError(f"Bad data: {data!r}") from e

# Output traceback shows both:
#   ValueError: Bad data: '...'
#   The above exception was the direct cause of the following:
#   json.JSONDecodeError: ...
```

Use `raise ... from None` to **hide** the chain (rare — only when the chain is noise).

## Custom exception hierarchy

One base class per module/service. Subclasses for specific failures.

```python
# errors.py
class AppError(Exception):
    """Base exception for this application."""

class ValidationError(AppError):
    """Input validation failed."""

class NotFoundError(AppError):
    """Resource not found."""

class AuthError(AppError):
    """Authentication or authorization failed."""

class ExternalServiceError(AppError):
    """Upstream dependency failed."""

# Usage
def get_user(user_id: str) -> User:
    user = db.find_user(user_id)
    if not user:
        raise NotFoundError(f"User {user_id}")
    return user

# Callers catch at the right level
try:
    user = get_user(uid)
except NotFoundError:
    return 404
except AppError:
    return 500  # any other app error
except Exception:
    logger.exception("unexpected")
    return 500
```

## Rules

| Rule | Why |
|---|---|
| Catch only exceptions you can handle | If you can't recover, let it propagate |
| Never catch `BaseException` | That includes `KeyboardInterrupt` and `SystemExit` |
| Log before re-raising | Otherwise the log line says "unexpected" when you actually expected it |
| Specific exception types | Callers can pattern-match; `Exception` forces logs to be the only debugging aid |
| Use `try/except/else` for 2-phase operations | `else` runs only if no exception — clearer than nesting |

## `try/except/else/finally`

```python
def fetch(url: str) -> Response:
    try:
        response = http.get(url)
    except TimeoutError:
        return fallback_response()
    except HTTPError as e:
        logger.error("http error: %s", e)
        raise
    else:
        # runs only on success — cleaner than putting this in try
        cache.set(url, response)
        return response
    finally:
        # always runs
        release_connection()
```

## Context manager for error handling

For repeated try/except patterns, wrap in a context manager.

```python
from contextlib import contextmanager

@contextmanager
def as_domain_error(target_type: type[Exception], msg: str):
    """Re-raise any exception as target_type(msg)."""
    try:
        yield
    except Exception as e:
        raise target_type(msg) from e

# Usage
with as_domain_error(ConfigError, "Failed to load config"):
    with open('config.json') as f:
        return json.load(f)
```

## Validation vs exceptions

For user-input validation, prefer returning a result object over raising.

```python
from dataclasses import dataclass

@dataclass
class ValidationResult:
    valid: bool
    errors: list[str]

def validate_user(data: dict) -> ValidationResult:
    errors = []
    if not data.get('email'):
        errors.append('email required')
    if 'age' in data and not 0 <= data['age'] <= 150:
        errors.append('age must be 0-150')
    return ValidationResult(valid=not errors, errors=errors)

# Caller
result = validate_user(input)
if not result.valid:
    return {"errors": result.errors}, 400
```

Raise exceptions for **exceptional** conditions. Validation failure is **expected**.

## Exception groups (Python 3.11+)

For reporting multiple failures at once — concurrent tasks, batch operations, validation aggregates. Use `ExceptionGroup` and `except*`.

```python
def import_batch(records: list[dict]) -> None:
    errors = []
    for r in records:
        try:
            import_one(r)
        except (ValidationError, DBError) as e:
            errors.append(e)
    if errors:
        raise ExceptionGroup("batch import failed", errors)

# Caller: except* matches by type across the group
try:
    import_batch(data)
except* ValidationError as eg:
    for e in eg.exceptions:
        log.warning("invalid: %s", e)
except* DBError as eg:
    for e in eg.exceptions:
        log.error("db failure: %s", e)
```

`asyncio.TaskGroup` (3.11+) raises `ExceptionGroup` natively when multiple child tasks fail.

## Logging exceptions

Use `logger.exception()` inside an except block — it auto-includes the traceback.

```python
import logging
logger = logging.getLogger(__name__)

try:
    risky_operation()
except ExternalServiceError:
    # logger.exception is equivalent to logger.error(exc_info=True)
    logger.exception("External service failed")
    # Re-raise or handle
    raise
```

**Never** use `print(e)` in production — print goes to stdout, not your log pipeline, and loses the traceback.

## Common mistakes

```python
# ❌ Mutating `except` clause without `from`
try: ...
except ValueError:
    raise TypeError("wrong type")   # original traceback lost

# ✅
try: ...
except ValueError as e:
    raise TypeError("wrong type") from e


# ❌ Catching to "convert to None"
try:
    return lookup(key)
except KeyError:
    return None  # if this is your pattern, use dict.get(key) — simpler

# ✅
return mapping.get(key)


# ❌ Overcatching hides bugs
try:
    data = get_user(uid)
    data.name = new_name       # if this raises, you misclassify it as "user not found"
except Exception:
    return 404

# ✅
try:
    data = get_user(uid)
except NotFoundError:
    return 404
data.name = new_name     # let real bugs propagate
```
