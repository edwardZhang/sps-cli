# TypeScript — Testing

Vitest / Jest, mocking, fixtures. For TDD cycle and general philosophy, see `coding-standards/references/tdd.md`.

## Runner: Vitest > Jest (for new projects)

Vitest is faster, ESM-native, and shares config with Vite. Jest is still fine on existing code.

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    coverage: { provider: 'v8', reporter: ['text', 'html'], thresholds: { lines: 80 } },
    globals: false,            // import describe/it/expect explicitly
  },
});
```

## File layout

| Convention | Pattern |
|---|---|
| Colocated | `src/user.ts` + `src/user.test.ts` |
| Separated | `src/user.ts` + `tests/user.test.ts` |

Colocated is easier to maintain; separated is easier to exclude from production bundles (if your bundler doesn't already tree-shake tests). Pick one and be consistent.

## Structure

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { UserService } from './user-service';

describe('UserService', () => {
  let service: UserService;

  beforeEach(() => {
    service = new UserService(new InMemoryUserRepo());
  });

  it('creates a user with a generated id', async () => {
    const u = await service.create({ name: 'A', email: 'a@x.com' });
    expect(u.id).toBeTypeOf('string');
    expect(u.name).toBe('A');
  });

  it('rejects empty email', async () => {
    await expect(service.create({ name: 'A', email: '' }))
      .rejects.toThrow(ValidationError);
  });
});
```

Test names describe behaviour, not implementation. `creates a user with a generated id`, not `test_1`.

## Assertions

```ts
expect(value).toBe(expected);                  // strict equality (===)
expect(value).toEqual(expected);               // deep equality
expect(value).toStrictEqual(expected);         // deep + prototype + undefined

expect(fn).toThrow(TypeError);
expect(fn).toThrow(/invalid email/);
await expect(promise).rejects.toThrow();

expect(array).toContain(item);
expect(obj).toMatchObject({ name: 'A' });      // partial match

expect(value).toSatisfy(v => v > 0 && v < 10);
```

`toBe` on objects compares references, almost always wrong. Use `toEqual`.

## Mocking

Prefer fakes (real implementations with in-memory backing) over mocks. Mocks drift from the thing they imitate.

```ts
// ✅ fake — behaves like a repo, just in memory
class InMemoryUserRepo implements UserRepository {
  private users = new Map<string, User>();
  async findById(id: string) { return this.users.get(id) ?? null; }
  async save(u: User) { this.users.set(u.id, u); }
}

// ⚠️ mock — easy for one test, painful when the repo grows
const mockRepo = {
  findById: vi.fn().mockResolvedValue(null),
  save:     vi.fn(),
} as unknown as UserRepository;
```

When you do mock:

```ts
import { vi } from 'vitest';

const sendEmail = vi.fn();
vi.mock('./email', () => ({ sendEmail }));

it('sends welcome email', async () => {
  await service.signup('a@x.com');
  expect(sendEmail).toHaveBeenCalledWith({ to: 'a@x.com', template: 'welcome' });
});
```

`vi.mock` hoists — the import is replaced everywhere the module is used.

## Fixtures — inject what the test needs

```ts
function makeUser(overrides: Partial<User> = {}): User {
  return { id: 'u_1', email: 'a@x.com', active: true, ...overrides };
}

it('rejects inactive users', () => {
  const u = makeUser({ active: false });
  expect(() => assertActive(u)).toThrow();
});
```

Factories beat hard-coded objects. Default in place, override per test.

## Parameterized tests

```ts
describe.each([
  { a: 1, b: 2, sum: 3 },
  { a: 0, b: 0, sum: 0 },
  { a: -1, b: 1, sum: 0 },
])('add($a, $b)', ({ a, b, sum }) => {
  it(`returns ${sum}`, () => expect(add(a, b)).toBe(sum));
});
```

Use `it.each` for simpler cases.

## Async tests

```ts
it('fetches', async () => {
  const u = await findUser('u_1');
  expect(u).not.toBeNull();
});

// Rejections
await expect(findUser('bad')).rejects.toThrow(NotFoundError);

// Don't forget `await`; a missing `await` on a rejecting promise is a silent false pass
```

Fake timers for time-based code:

```ts
vi.useFakeTimers();
const p = sleep(1000).then(() => 'done');
vi.advanceTimersByTime(1000);
await expect(p).resolves.toBe('done');
vi.useRealTimers();
```

## Snapshot tests — use sparingly

```ts
expect(renderEmail(user)).toMatchSnapshot();
```

Good for large structural output. Bad as a lazy "assert-something" catch-all — a stale snapshot silently legitimizes bugs.

Review every snapshot change deliberately. If you're running `--update-snapshots` as a reflex, they've lost their value.

## Integration tests

Hit real dependencies (DB, Redis, HTTP) where feasible. Testcontainers makes this portable.

```ts
// tests/integration/user.test.ts
import { GenericContainer } from 'testcontainers';

let pg;
beforeAll(async () => {
  pg = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_PASSWORD: 'test' })
    .withExposedPorts(5432)
    .start();
  // set DB_URL from pg.getMappedPort(5432)
});
afterAll(() => pg.stop());
```

Integration tests give confidence that unit tests alone can't. Keep them separate from unit tests (`tests/integration/**`) so CI can run them in a different stage.

## Coverage — a floor, not a goal

See `coding-standards/references/tdd.md` for coverage targets. Chasing 100% coverage with meaningless assertions hurts more than it helps.

Enforce in CI:

```ts
// vitest.config.ts
test: {
  coverage: {
    thresholds: {
      lines: 80,
      functions: 80,
      branches: 70,
    },
  },
}
```

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Tests that sleep for real seconds | Fake timers |
| `it.only` committed to main | CI rule: reject `.only` in `test`/`it`/`describe` |
| Shared mutable state between tests | Reset in `beforeEach` |
| Testing by spying on console.log | Test observable behaviour, not debug output |
| `expect(x).toEqual(x)` | Tautology; no signal |
| Over-mocking: 10 mocks to test 20 lines | Refactor so the unit is easier to test |
| Network in unit tests | Use fakes; move to integration suite |
| Snapshot tests for volatile output (dates, uuids) | Redact or use deterministic fixtures |
