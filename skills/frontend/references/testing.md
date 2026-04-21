# Frontend Testing

Component tests, E2E (Playwright), visual regression. For TDD, see `coding-standards/references/tdd.md`.

## The pyramid, frontend version

```
         ▲
         │   Visual / E2E (5%)       ← real browser, real flows
         │   Integration (20%)        ← component + key deps; real rendering
         │   Unit (75%)               ← functions, hooks, reducers; no DOM
         ▼
```

Invert this and tests become slow, flaky, and your fast feedback loop dies.

## Unit tests — pure logic

For reducers, selectors, utility functions, validation. Same rules as any language.

```
describe('priceWithTax', () => {
  it('adds tax by rate', () => {
    expect(priceWithTax(100, 0.2)).toBe(120);
  });
});
```

## Component tests — Testing Library philosophy

Test the component through the accessibility tree, not through implementation internals.

```
import { render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

test('submit is disabled until email is valid', async () => {
  render(<SignupForm />);
  const email = screen.getByLabelText(/email/i);
  const submit = screen.getByRole('button', { name: /sign up/i });

  expect(submit).toBeDisabled();
  await userEvent.type(email, 'a@x.com');
  expect(submit).toBeEnabled();
});
```

Key conventions:
- **Query by role** (`getByRole('button', { name: 'Save' })`) — that's what a screen reader sees.
- **Query by label / text** for inputs and visible content.
- **Never by className / test-id unless nothing else works.**
- **Never assert on implementation details** (internal state, prop changes, class names).

## Mock at the network boundary

Don't mock internal hooks. Mock the fetch / WS. Tests stay honest.

```
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

const server = setupServer(
  http.get('/api/users/:id', ({ params }) =>
    HttpResponse.json({ id: params.id, email: 'a@x.com' })
  ),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

test('loads and renders user', async () => {
  render(<UserCard id="u1" />);
  expect(await screen.findByText('a@x.com')).toBeInTheDocument();
});
```

MSW (Mock Service Worker) works for unit/integration tests and in the browser. Same mocks everywhere.

## Async: `findBy` over `waitFor` + `getBy`

```
# ✅ waits implicitly; throws if not found in time
expect(await screen.findByText('Welcome')).toBeInTheDocument();

# ❌ verbose
await waitFor(() => expect(screen.getByText('Welcome')).toBeInTheDocument());
```

## Don't sleep in tests

If `setTimeout(..., 500)` is the only way to make it pass, fake the timer:

```
vi.useFakeTimers();
// interact
vi.advanceTimersByTime(500);
// assert
vi.useRealTimers();
```

Real sleeps make tests slow and flaky.

## Hook / composable tests

```
import { renderHook, act } from '@testing-library/react';

test('useCounter increments', () => {
  const { result } = renderHook(() => useCounter());
  act(() => result.current.increment());
  expect(result.current.count).toBe(1);
});
```

Vue's equivalent uses `mount` with a minimal wrapper.

## Store / reducer tests

Pure functions — test without a DOM.

```
test('cartReducer adds item', () => {
  const state = cartReducer(initial, { type: 'add', item });
  expect(state.items).toHaveLength(1);
});
```

If you need the store under Redux-Toolkit or similar, create a test-only store instance. Don't export globals shared across tests.

## E2E — Playwright (or Cypress)

Playwright has clear advantages:
- First-class TypeScript, no CLI glue.
- Multi-browser (Chromium, Firefox, WebKit).
- Parallel by default.
- Network interception built in.

```
import { test, expect } from '@playwright/test';

test('signup flow', async ({ page }) => {
  await page.goto('/signup');
  await page.getByLabel('Email').fill('a@x.com');
  await page.getByLabel('Password').fill('correct horse battery staple');
  await page.getByRole('button', { name: 'Create account' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();
});
```

Rules:
- **Write by role / label**, not CSS selectors.
- **Wait for state, not for time.** Playwright's `expect().toBeVisible()` auto-retries.
- **Own your data.** Seed the DB (API or fixture) before each test; tests shouldn't depend on state from other tests.
- **Keep E2E to happy-path + critical flows.** Unit / integration cover the combinatorics.

## Visual regression

Tools: Playwright built-in screenshot diff, Chromatic (Storybook), Percy, Applitools.

```
await expect(page).toHaveScreenshot('home.png');
```

Traps:
- Flaky anti-alias / font rendering across OSes → run on Linux in CI only, accept minor diff tolerance.
- Time / random IDs in the screenshot → stub or mask.
- Snapshot explosion (one per page × browser × theme) → be selective.

Great for design systems and key pages. Less valuable for the long tail.

## Storybook

Isolate components. One story per variant.

```
export default { title: 'Button' };

export const Primary = () => <Button variant="primary">Save</Button>;
export const Disabled = () => <Button disabled>Save</Button>;
export const Long = () => <Button>Save my very long message</Button>;
```

- Run component tests against stories (`play` function).
- Run a11y checks against stories (`@storybook/addon-a11y`).
- Use as visual regression fixture.

Kills the "how did the component look in that one state again?" question.

## CI configuration

Typical split:

| Stage | Runs | On |
|---|---|---|
| Unit | Every commit | All PRs, fast fail |
| Integration / component | Every commit | All PRs |
| E2E happy path | Every commit | PRs, on staging |
| Visual regression | Daily + on design-touching PRs | Scheduled |
| Full E2E matrix | On main / pre-release | Nightly |

Run the cheap ones on every commit; save the expensive ones for what they uniquely catch.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Testing internal state / prop of a component | Test behaviour the user experiences |
| Snapshot tests for entire pages | Brittle; use for specific outputs |
| `data-testid` everywhere | Rely on roles / labels first |
| Mocking React / Vue internals | You're testing the framework, not your code |
| Shared global state between E2E tests | Seed per-test; reset between |
| 50 E2E tests, 5 unit tests | Flip the pyramid |
| Waiting for `await page.waitForTimeout(1000)` | Wait for a condition / state |
| Testing against prod or shared staging | Test against ephemeral / dedicated env |
| CSS-class-based assertions (`toHaveClass('active')`) | Assert on observable effect (visible text, role, aria) |
