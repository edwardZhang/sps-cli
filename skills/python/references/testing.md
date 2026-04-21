# Python Testing

pytest-specific patterns. For TDD cycle and general test-driven methodology, see the `coding-standards` skill (`references/tdd.md`).

## Coverage targets

| Layer | Target | Rationale |
|---|---|---|
| Unit (pure logic) | ≥ 90% | Fast, cheap, high signal |
| Integration | ≥ 70% | Covers real dependencies (DB, cache, HTTP) |
| E2E | Key flows only | Slow, brittle — don't overinvest |

Use `pytest-cov`:
```bash
pytest --cov=myapp --cov-report=term-missing --cov-fail-under=80
```

## pytest structure

File and function naming:
- Files: `test_*.py` or `*_test.py`
- Test functions: `test_*`
- Classes (optional grouping): `class TestFoo`

```python
# test_user_service.py
def test_create_user_returns_user_object():
    service = UserService(db=FakeDB())
    user = service.create(name="Alice", email="a@x.com")
    assert user.name == "Alice"
    assert user.id is not None

def test_create_user_rejects_empty_email():
    service = UserService(db=FakeDB())
    with pytest.raises(ValidationError, match="email"):
        service.create(name="Alice", email="")
```

## Assertions: prefer plain `assert`

pytest rewrites `assert` to show helpful diffs. Never use `self.assertEqual` (that's unittest).

```python
# Good
assert result == expected
assert user in users
assert "error" in str(caplog.records[0])
assert 0 < percent <= 100

# Bad
self.assertEqual(result, expected)   # unittest style — ugly, no advantage
assertTrue(result == expected)        # ditto
```

## Fixtures

Use fixtures for setup/teardown, not manual init in every test.

```python
import pytest

@pytest.fixture
def user_service():
    service = UserService(db=FakeDB())
    yield service
    service.cleanup()

def test_create_user(user_service):
    user = user_service.create(name="A", email="a@x.com")
    assert user.id
```

Scope levels (reuse across tests):
- `function` (default): new instance per test
- `class`: shared within a class
- `module`: shared within a file
- `session`: shared across entire run

```python
@pytest.fixture(scope="session")
def db_connection():
    conn = connect_to_test_db()
    yield conn
    conn.close()
```

**Shared fixtures**: put in `conftest.py` in the test directory.

## Parametrization

Same test logic, multiple inputs — one line per case.

```python
@pytest.mark.parametrize("a,b,expected", [
    (1, 2, 3),
    (0, 0, 0),
    (-1, 1, 0),
    (100, 200, 300),
])
def test_add(a, b, expected):
    assert add(a, b) == expected

# With IDs for readable output
@pytest.mark.parametrize("input,expected", [
    ("hello", 5),
    ("", 0),
    ("a b c", 5),
], ids=["simple", "empty", "with_spaces"])
def test_len(input, expected):
    assert len(input) == expected
```

## Mocking

Use `pytest-mock` (`mocker` fixture) or `unittest.mock`.

```python
def test_sends_email_on_signup(mocker):
    mock_send = mocker.patch('myapp.email.send')
    service.signup(email="a@x.com")
    mock_send.assert_called_once_with(to="a@x.com", template="welcome")

def test_handles_api_timeout(mocker):
    mocker.patch('myapp.http.get', side_effect=TimeoutError)
    result = service.fetch_data()
    assert result.error == "timeout"
```

### Mock rules

| Rule | Why |
|---|---|
| Patch where it's USED, not where it's DEFINED | `patch('myapp.service.http.get')` not `patch('requests.get')` |
| Use `autospec=True` for stricter signatures | Catches "mock called with wrong args" |
| Don't over-mock | If you mock 8 things to test 10 lines, something's wrong |
| Prefer fakes over mocks | A `FakeDB` that actually works is easier to maintain |

## Markers

Mark tests for selective running.

```python
@pytest.mark.slow
def test_full_import_pipeline():
    ...  # takes 30s

@pytest.mark.integration
def test_with_real_db():
    ...

# Run only fast tests:
# pytest -m "not slow"

# Run only integration:
# pytest -m integration
```

Register markers in `pyproject.toml` to avoid warnings:
```toml
[tool.pytest.ini_options]
markers = [
    "slow: tests taking more than 1 second",
    "integration: tests requiring external services",
]
```

## Testing async code

Use `pytest-asyncio`.

```python
import pytest

@pytest.mark.asyncio
async def test_fetch_url():
    result = await fetch("https://example.com")
    assert result.status == 200
```

For the async language-level patterns being tested, see `references/async.md`.

## Property-based testing with Hypothesis

When the input space is large (parsers, serializers, invariants), `hypothesis` generates inputs automatically and shrinks failing cases.

```python
from hypothesis import given, strategies as st

@given(st.lists(st.integers()))
def test_sort_is_idempotent(xs):
    assert sorted(sorted(xs)) == sorted(xs)

@given(st.text())
def test_roundtrip(s):
    assert decode(encode(s)) == s

# Composite strategy
user_strategy = st.builds(
    User,
    id=st.uuids().map(str),
    age=st.integers(min_value=0, max_value=150),
    email=st.emails(),
)

@given(user_strategy)
def test_user_serializes(u):
    assert User.from_json(u.to_json()) == u
```

Use it where example-based tests are weak: round-trips, invariants, mathematical properties, parsers.

## Testing exceptions

```python
def test_raises_on_invalid_input():
    with pytest.raises(ValidationError, match="email required"):
        validate_user({})

def test_exception_chain():
    with pytest.raises(ConfigError) as exc_info:
        load_config("/nonexistent")
    assert isinstance(exc_info.value.__cause__, FileNotFoundError)
```

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Shared mutable state across tests | Use fixtures with function scope |
| `if __name__ == "__main__": pytest.main()` in tests | Run via `pytest` CLI |
| Print statements for debugging | Use `caplog` fixture or `-s` flag |
| Testing private methods | Test via public API; if you can't, refactor |
| One big `test_everything()` | Split: one behavior per test |
| Skipping tests without comment | `@pytest.mark.skip("reason")` always with reason |

## Test organization

```
project/
├── src/myapp/
│   ├── services/
│   │   └── user_service.py
│   └── models/
│       └── user.py
└── tests/
    ├── conftest.py              # shared fixtures
    ├── unit/
    │   ├── test_user_service.py
    │   └── test_user_model.py
    ├── integration/
    │   └── test_user_api.py
    └── e2e/
        └── test_signup_flow.py
```

## CI setup

```toml
# pyproject.toml
[tool.pytest.ini_options]
addopts = [
    "--cov=myapp",
    "--cov-report=term-missing",
    "--cov-fail-under=80",
    "--strict-markers",
    "-ra",             # show summary for all non-pass outcomes
]
testpaths = ["tests"]
```
