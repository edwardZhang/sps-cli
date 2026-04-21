---
name: python
description: Python language skill — idioms, type hints, error handling, testing, async, packaging. Language-focused. Combine with end skills (`backend`, `frontend`, `mobile`) for architecture, and with persona skills (`backend-architect`, `code-reviewer`) for mindset.
origin: ecc-fork (https://github.com/affaan-m/everything-claude-code, MIT)
---

# Python

Pythonic idioms, typing, error handling, async, testing, packaging. **Language-focused only**. Architecture decisions belong to end skills (`backend`, `frontend`, `mobile`); general principles (TDD cycle, "specific exceptions only", "tests before code") live in `coding-standards`.

## When to load

- Task is a Python project (primary language)
- Reviewing Python code
- Setting up Python project structure, packaging, or tests
- Writing Python-specific logic (generators, decorators, context managers, type hints, async)

## Core principles (The Zen of Python, abridged)

1. **Readability counts** — clear > clever
2. **Explicit over implicit** — no hidden side effects
3. **EAFP** (Easier to Ask Forgiveness Than Permission) — prefer `try/except` over pre-checks
4. **Type hints on public APIs** — modern 3.9+ syntax (`list[str]` not `List[str]`); 3.12+ PEP 695 where available
5. **Immutable defaults** — never `def f(x=[])`; use `None` + `x or []` or `frozenset` / `tuple`
6. **Pathlib over os.path** — modern filesystem access
7. **f-strings** over `.format()` / `%` formatting
8. **`pyproject.toml` only** — no `setup.py`, no `requirements.txt` for libraries

## How to use references

Load detailed references on demand based on the task:

| Reference | When to load |
|---|---|
| [`references/idioms.md`](references/idioms.md) | Core language idioms: EAFP, comprehensions, generators, decorators, context managers, match/case, walrus |
| [`references/typing.md`](references/typing.md) | Type hints, generics (PEP 695), protocols, type aliases, `Self`, `@override`, `ParamSpec` |
| [`references/error-handling.md`](references/error-handling.md) | Exception hierarchy, chaining, custom exceptions, exception groups / `except*` |
| [`references/async.md`](references/async.md) | `asyncio`, `TaskGroup`, timeouts, cancellation, offloading blocking code |
| [`references/testing.md`](references/testing.md) | pytest, fixtures, parametrization, mocking, coverage, `hypothesis` |
| [`references/packaging.md`](references/packaging.md) | `pyproject.toml`, `uv`, `venv`, project layout, publishing |

## Forbidden patterns (auto-reject)

- Mutable default arguments (`def f(x=[])`) — use `None` sentinel
- `except:` without exception type — always name it
- `import *` — explicit imports only
- `time.sleep()` / blocking calls inside `async def` — use `await asyncio.sleep()` or `asyncio.to_thread`
- Swallowing `asyncio.CancelledError` without re-raising
- `setup.py` in new projects — use `pyproject.toml`
- Committing `.venv/` or mixing envs with system Python
- Dynamic typing in public APIs without type hints
