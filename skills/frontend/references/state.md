# State

Local, shared, server, derived. The taxonomy matters more than the library.

## Taxonomy

| Kind | Lives | Examples | Tool |
|---|---|---|---|
| **Local** | In one component | Input text, dropdown-open boolean | `useState` / `ref` / component state |
| **Shared** | Across siblings or deep tree | Theme, current user, feature flag | Context / provider / store |
| **Server** | Comes from an API | User list, order details, prices | Server-cache lib (TanStack Query, SWR, Apollo) |
| **URL** | In the address bar | Current page, filters, selected item | Router query / path params |
| **Derived** | Computed from other state | `totalCents = sum(items.map(i => i.cents))` | Memo / computed |

Knowing which bucket each piece belongs in saves 80% of state-management pain.

## Server state is special

Server state is not your state — it's a cache of someone else's state. Treat it that way.

```
// ❌ putting server data into a global store
dispatch({ type: 'users/loaded', users });

// ✅ using a server-cache library
const { data: users, isLoading } = useQuery(['users'], fetchUsers);
```

Server-cache libraries give you:
- Per-key caching + reuse across components.
- Stale-while-revalidate, auto-refetch on window focus / network.
- Optimistic updates with rollback.
- Request deduplication.

Don't reinvent these. They're not a minor convenience — they handle edge cases that take weeks to replicate.

## Derive, don't store

```
// ❌ stored
const [items, setItems] = useState([]);
const [total, setTotal] = useState(0);
// now every setItems must also update total — easy to forget

// ✅ derived
const [items, setItems] = useState([]);
const total = useMemo(() => items.reduce((s, i) => s + i.cents, 0), [items]);
```

Two pieces of state that must stay in sync = one piece of state.

## Single source of truth

When two components both "know" the same data, either:
- Lift the state to their common parent, OR
- Put it in a shared store.

Never duplicate.

## Local first, global last

Reach for global state only when you genuinely have cross-cutting concerns (auth user, theme, i18n). Otherwise, state that starts local can be lifted when needed. The opposite move (pull-back from global to local) is painful.

## Forms

Forms are half server state, half local. Libraries:

| Lib | Feel |
|---|---|
| React Hook Form | Uncontrolled-first, minimal re-renders |
| Formik | Controlled, rich ecosystem |
| TanStack Form | Typed, framework-agnostic, modern |
| Native `<form>` + validation | Underrated for simple cases |

For schema validation, reach for `zod` / `valibot` / `yup` and share the schema with the backend if possible.

Rules:
- Validate on submit (mandatory) + on blur (optional) + on change (for high-visibility fields like email uniqueness).
- Disable submit while submitting; prevent double-submit.
- Clear form fields only when the user expects it (e.g., after successful create; not after error).

## Optimistic UI

Show the expected result immediately. Reconcile on server response.

```
async function like(postId) {
  // Optimistic
  setPosts(posts => posts.map(p => p.id === postId ? { ...p, liked: true, likes: p.likes + 1 } : p));

  try {
    const updated = await api.like(postId);
    setPosts(posts => posts.map(p => p.id === postId ? updated : p));
  } catch (e) {
    // Rollback
    setPosts(posts => posts.map(p => p.id === postId ? { ...p, liked: false, likes: p.likes - 1 } : p));
    toast.error('Failed to like');
  }
}
```

Server-cache libraries make this pattern a one-liner. Use it for any user-initiated action where latency > ~50ms.

## Undo / stack

For multi-step flows or sensitive actions, keep a history:

```
const [history, setHistory] = useState([initial]);
const [index, setIndex] = useState(0);
const current = history[index];

function apply(action) {
  const next = reducer(current, action);
  setHistory(h => [...h.slice(0, index + 1), next]);
  setIndex(i => i + 1);
}
function undo() { setIndex(i => Math.max(0, i - 1)); }
function redo() { setIndex(i => Math.min(history.length - 1, i + 1)); }
```

## Stores — when you need one

Pick based on complexity:

| Library | Feel |
|---|---|
| Zustand | Minimal, hook-based, great for small-to-medium |
| Jotai | Atoms; fine-grained reactivity |
| Redux Toolkit | Large apps with strict flow; heavy ceremony |
| MobX | Observable objects; reactive by mutation |
| Svelte stores | Built-in; simple |
| Pinia | Vue default; ergonomic |

Rule of thumb: start without a store. Add one when you pass the same piece of state through 4+ component levels of drilling.

Keep store slices small and feature-aligned (`authStore`, `cartStore`). One giant store is the 2015 Redux antipattern.

## Context — use for slow-changing values

Context rerenders every consumer whenever the value changes. Fine for theme, i18n, auth user. Bad for frequently-changing values (cursor position, scroll position).

Mitigations:
- Split contexts: one per slow-changing value.
- Use `useSyncExternalStore` / subscribe pattern for frequently-changing data.

## URL state

Filters, selected tab, pagination — put in the URL.

```
?status=active&sort=-createdAt&page=3
```

Benefits:
- Bookmarkable, shareable, back/forward works.
- Reload restores state.
- Observable in analytics.

Frameworks provide query-param hooks (`useSearchParams`, `useRoute`). Treat the URL as part of your state system, not an afterthought.

## Persistence

Some state needs to survive reload: draft form content, selected theme, auth tokens.

| Where | For |
|---|---|
| `localStorage` | Preferences, form drafts (size limit ~5MB) |
| `sessionStorage` | Per-tab, cleared on close |
| `indexedDB` | Larger data, structured (offline caches) |
| Cookie | Auth session (HttpOnly, Secure; see `backend/security.md`) |

Rules:
- Never store tokens in `localStorage` (XSS-readable).
- Serialize deliberately — full store dumps change often and break older clients.
- Version the stored shape; migrate on read when structure evolves.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Global store holding fetched server data | Server-cache library |
| Deriving state in `useEffect` | Derive with `useMemo` / computed |
| Controlled forms with tons of re-renders | Uncontrolled + `react-hook-form` / equivalent |
| Multiple sources of truth for the same value | Pick one; others derive |
| Prop-drilling 5 levels deep | Context, composition, or store |
| Redux for 3-component apps | `useState` is enough |
| State updates inside render | Move to events / effects |
| Forgetting to reset state on "new" contexts (e.g., user logout) | Clear or keyed remount |
| Using `useEffect` to sync URL → state → URL | Derive from URL directly |
