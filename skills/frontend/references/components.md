# Components

Shape, composition, props, children / slots.

## One responsibility per component

A component that renders a user profile should not fetch the user. A component that fetches the user shouldn't render it.

```
<UserProfile data={user} onEdit={handleEdit} />       # presentational
<UserProfileContainer userId={id} />                   # loads + renders
```

This split (presentational / container, or dumb / smart) keeps each piece testable in isolation. The container deals with data; the presentational piece with pixels.

## Props in, events out

Data flows down through props. Changes flow up through callbacks / emitted events.

```
<Button
  label="Save"
  disabled={!form.valid}
  onClick={() => submit()}
/>
```

Avoid:
- Parents reaching into children via refs for non-imperative purposes.
- Children calling setters on state that belongs to the parent.
- Two-way binding magic that hides data flow.

## Composition over configuration

Accept children / slots, don't try to anticipate every variant with boolean props.

```
# ❌ exploding configuration
<Card
  hasHeader
  hasFooter
  headerText="Hi"
  footerAction="Dismiss"
  iconLeft
  iconRight
/>

# ✅ composition
<Card>
  <CardHeader>Hi</CardHeader>
  <CardBody>...</CardBody>
  <CardFooter>
    <Button onClick={dismiss}>Dismiss</Button>
  </CardFooter>
</Card>
```

Fewer props, more flexibility. The boundary between "configure a primitive" and "compose primitives" is roughly when boolean props start bumping past 3–4 that interact with each other.

## Slots / children

Every modern framework has a way to inject arbitrary content into a component:

| Framework | Name |
|---|---|
| React | `children` (and render props) |
| Vue | `<slot>` (named + scoped) |
| Svelte | `<slot>` + named slots |
| Solid | `children` |
| Web Components | `<slot>` |

Prefer these over passing JSX / VNodes through props. Slots / children are the idiomatic "here's your content".

## Smart vs. dumb — the rough divide

| Smart (container, hook, composable) | Dumb (presentational) |
|---|---|
| Fetches data | Renders what it's given |
| Owns mutable state | Stateless (or local UI state only) |
| Wires up events to side effects | Emits events, doesn't handle them |
| Tests: usually via integration | Tests: snapshot / visual |

The boundary is not rigid. Don't create a container for a `<Button>`. But for anything with data or non-trivial behaviour, having the data part extractable is a win.

## Prop typing (typed frameworks)

```ts
type UserCardProps = {
  user: User;
  variant?: 'compact' | 'full';
  onEdit?: (user: User) => void;
};

function UserCard({ user, variant = 'full', onEdit }: UserCardProps) { ... }
```

Rules:
- Default values inline at destructure.
- Optional callbacks are fine; treat them as optional behaviour.
- Don't type `user: any` — if the shape is unclear, define the type.

## Render props vs. hooks / composables

Modern frameworks prefer hooks / composables for reusing logic. Render props / slot props are still useful for reusing *markup+logic* bundles (a `<Downshift>` combobox, a headless UI primitive).

```
# Hook — reuse logic
function useDebouncedSearch(value, ms) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const t = setTimeout(() => setDebounced(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return debounced;
}

# Render prop / slot — reuse logic + markup hooks
<Combobox items={items}>
  {({ input, menu, option }) => (
    <div>
      <input {...input} />
      <ul {...menu}>{items.map(i => <li {...option(i)}>{i.label}</li>)}</ul>
    </div>
  )}
</Combobox>
```

## Controlled vs. uncontrolled inputs

| Controlled | State in the parent; parent dictates the value |
| Uncontrolled | State in the DOM; parent reads via ref on submit |

Use controlled for forms with validation, dynamic enablement, real-time feedback. Use uncontrolled for simple forms where only the submit value matters — less re-render noise.

## Forwarded refs — the escape hatch

Let a parent attach a ref through a wrapping component to reach an underlying DOM node (focus a text input, scroll into view). Use sparingly — most needs are better solved with props.

## Error boundaries

Every app root should have a boundary that catches render errors and shows a graceful fallback. Otherwise one bad prop crashes the whole tree to white.

```
<ErrorBoundary fallback={<Error500 />}>
  <App />
</ErrorBoundary>
```

Don't wrap every component in its own boundary — a handful of strategic ones (app shell, each route, expensive widgets) is plenty.

## Suspense / loading states

Where the framework supports it, declarative loading UX beats imperative flags.

```
# Declarative
<Suspense fallback={<Skeleton />}>
  <UserCard id={id} />
</Suspense>

# Imperative — works too, more verbose
{loading ? <Skeleton /> : <UserCard user={user} />}
```

## Folder structure — organize by feature

```
src/
├── features/
│   ├── user/
│   │   ├── UserCard.tsx
│   │   ├── UserCard.test.tsx
│   │   ├── useUser.ts
│   │   └── api.ts
│   └── billing/
│       └── ...
├── shared/
│   ├── components/          # truly shared primitives (Button, Input)
│   ├── hooks/
│   └── utils/
└── app/
    ├── routes.tsx
    └── root.tsx
```

Organize by feature first, by type (components, hooks, utils) second. Kitchen-sink `components/` folders become dumping grounds.

## Styling — pick one, consistent

- **CSS modules / scoped styles** — simple, portable.
- **Utility-first (Tailwind)** — fast to write, mature ecosystem, needs team buy-in.
- **CSS-in-JS** — component-local; runtime cost varies.
- **Design tokens** — common layer regardless of above choice (`--color-primary`, `var(...)`).

Mixing strategies across the codebase is the antipattern, not the choice itself.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Huge props object passed through many layers | Composition / context / slots |
| `useEffect` / `watchEffect` to "sync two states" | Derive one from the other |
| Logic in JSX (`{users.filter(...).map(...).length > 0 && ...}`) | Extract to a named variable or helper |
| Deep prop drilling | Context / store, or restructure component tree |
| Rendering a component for each row of thousands | Virtualize (see `performance.md`) |
| Side effects during render | Side effects belong in effects / handlers |
| Mutating props or items inside `.map` | Make new objects / arrays |
| Callback prop recreated on every render causing child re-renders | Memoize or lift |
| Inline objects / arrays in deps arrays | Memoize or use stable refs |
