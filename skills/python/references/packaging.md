# Python Packaging & Environments

Modern Python packaging. Defaults: `pyproject.toml` + `uv` (or `pip` + `venv`). No `setup.py`, no `requirements.txt` pinning in libraries.

## Tool landscape (2024–2026)

| Need | Tool | Notes |
|---|---|---|
| Env + lockfile + installer | **`uv`** | Fastest; Rust-based; drop-in for pip/venv/pip-tools/poetry |
| Traditional installer | `pip` | Still the universal fallback |
| Env isolation only | `venv` (stdlib) | Zero-dependency; fine for simple cases |
| Project manager (alt) | `poetry`, `hatch`, `pdm` | Mature; pick one per project, don't mix |
| Build backend | `hatchling`, `setuptools`, `flit-core`, `poetry-core` | Declared in `pyproject.toml` |

Default recommendation: `uv` for new work. Its `pyproject.toml` is standard so projects stay portable.

## `pyproject.toml` — the one config file

```toml
[project]
name = "myapp"
version = "0.1.0"
description = "Short one-liner"
readme = "README.md"
requires-python = ">=3.11"
license = { text = "MIT" }
authors = [{ name = "Coral", email = "coral@example.com" }]
dependencies = [
    "httpx>=0.27",
    "pydantic>=2.5",
]

[project.optional-dependencies]
dev = [
    "pytest>=8.0",
    "pytest-cov",
    "mypy",
    "ruff",
]

[project.scripts]
myapp = "myapp.cli:main"     # creates a `myapp` executable on install

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build.targets.wheel]
packages = ["src/myapp"]

[tool.ruff]
line-length = 100
target-version = "py311"

[tool.mypy]
strict = true
python_version = "3.11"
```

## Project layout — `src/` over flat

Keep source under `src/` so `import myapp` during tests uses the installed package, not the working directory. Catches "works locally, broken when installed" bugs early.

```
myapp/
├── pyproject.toml
├── README.md
├── src/
│   └── myapp/
│       ├── __init__.py
│       ├── cli.py
│       └── services/
│           └── user.py
└── tests/
    ├── conftest.py
    └── test_user.py
```

Avoid: top-level `myapp/` mixed with `tests/` — `sys.path` tricks mask import bugs.

## `uv` — day-to-day commands

```bash
# Create project
uv init myapp --package

# Add / remove dependencies (updates pyproject.toml + uv.lock)
uv add httpx pydantic
uv add --dev pytest pytest-cov mypy ruff
uv remove requests

# Install everything (reproducible from lockfile)
uv sync

# Run anything inside the env
uv run pytest
uv run python -m myapp
uv run ruff check src/

# Pin Python version
uv python pin 3.12

# Build a wheel / sdist
uv build

# Upgrade dependencies
uv lock --upgrade
uv lock --upgrade-package httpx
```

Commit `uv.lock` for **applications**. For **libraries**, don't commit it — let downstreams resolve against their own constraints.

## `pip` + `venv` — classic workflow

```bash
python -m venv .venv
source .venv/bin/activate     # Windows: .venv\Scripts\activate

pip install -e '.[dev]'       # editable install with dev extras
pip install --upgrade pip

# Freeze what's installed (for apps, not libs)
pip freeze > requirements.lock.txt
pip install -r requirements.lock.txt
```

Never `pip install` into the system Python. Use a venv per project.

## Dependency specification

```toml
[project]
dependencies = [
    "httpx>=0.27,<1.0",             # library: allow a compatible range
    "pydantic~=2.5",                # ~= means >=2.5,<3.0
    "requests; python_version<'3.11'",   # conditional
    "rich[jupyter]>=13.0",          # with extras
]
```

| Specifier | Meaning | Use for |
|---|---|---|
| `pkg>=X.Y` | at least this version | libraries |
| `pkg~=X.Y` | compatible release (=X.*, <X+1) | common default |
| `pkg==X.Y.Z` | exact pin | applications with lockfile |
| `pkg>=A,<B` | explicit range | upper bound on known-breaking releases |

**Libraries**: loose constraints (`>=X`). **Applications**: tight lockfile (`uv.lock` or `requirements.lock.txt`).

## Version management

Single source of truth for the version. Don't duplicate in `__init__.py`.

```toml
# pyproject.toml
[project]
dynamic = ["version"]

[tool.hatch.version]
path = "src/myapp/__about__.py"
```

```python
# src/myapp/__about__.py
__version__ = "0.1.0"

# src/myapp/__init__.py
from myapp.__about__ import __version__
__all__ = ["__version__"]
```

## Python version management

`pyenv` for installing Python versions; `uv python` integrates this. Project-level pin:

```bash
uv python pin 3.12      # writes .python-version
```

CI: install the exact version from `.python-version` so prod and dev match.

## Publishing to PyPI

```bash
uv build
uv publish                  # uses PyPI API token from UV_PUBLISH_TOKEN

# Or with twine
python -m build
twine upload dist/*
```

Pre-flight checks:
- `README.md` renders on PyPI (test with `twine check dist/*`)
- Version bumped
- `CHANGELOG.md` updated
- Tag release in git: `git tag v0.1.0 && git push --tags`

## Private packages

```toml
[tool.uv.sources]
mycompany-lib = { git = "ssh://git@github.com/mycompany/lib.git", tag = "v1.2.0" }
internal = { path = "../internal", editable = true }
```

Or via `--extra-index-url` for private PyPI indexes.

## `__init__.py` — keep it minimal

```python
# src/myapp/__init__.py
"""Public API for myapp."""
from myapp.services import UserService
from myapp.models import User

__all__ = ["UserService", "User"]
```

Don't run heavy init logic at import time — it slows down `import myapp` for every caller.

## Common mistakes

| Mistake | Fix |
|---|---|
| `setup.py` in a new project | Use `pyproject.toml` only |
| Committing `venv/` or `.venv/` | Add to `.gitignore` |
| `pip install` without a venv | Always use `uv` or `venv` |
| `requirements.txt` in a library | Declare in `pyproject.toml`; let consumers pin |
| Version duplicated in 3 files | Use `dynamic = ["version"]` |
| `from myapp import *` in `__init__.py` | Explicit exports via `__all__` |
| Flat layout causing import surprises | Use `src/` layout |
| Running tests with local `myapp/` shadowing the installed one | `pip install -e '.[dev]'`, then `pytest` |
