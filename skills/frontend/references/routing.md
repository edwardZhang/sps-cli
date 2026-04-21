# Routing

Client-side routing, deep linking, guards, transitions.

## Route = URL + data + component

Every route declaration answers three questions:
1. What URL pattern matches?
2. What data does it need?
3. What renders?

```
{
  path: '/orders/:id',
  loader: ({ params }) => fetchOrder(params.id),
  element: <OrderDetail />,
}
```

Modern routers (React Router 6+, TanStack Router, Nuxt, SvelteKit, Remix) embed data loading. Prefer route-level loaders over fetching in components — it parallelizes data with rendering and enables streaming / Suspense.

## Nested routes

A nested route inherits layout from its parent.

```
/app
  /app/profile          <Settings tabs /> + ProfilePanel
  /app/billing          <Settings tabs /> + BillingPanel
```

Parent route stays mounted; only the outlet changes. Cheap tab switches, persistent side nav, zero re-fetch for shared data.

## Dynamic segments

```
/users/:userId/orders/:orderId
```

Treat params as strings; parse and validate at the boundary. Never trust the URL — a bad one shouldn't crash your app.

## Query params

For sort, filter, pagination, selected tab. Don't shoehorn into path params.

```
/users?role=admin&sort=-createdAt&page=2
```

Client routers give you typed access (`useSearchParams` / similar). Always treat query params as optional; have sensible defaults.

## Route guards

Auth, role, feature flag checks happen at the route boundary, not in the component.

```
{
  path: '/admin',
  loader: async () => {
    const user = await requireAuth();
    if (!user.roles.includes('admin')) throw redirect('/');
    return null;
  },
  element: <AdminShell />,
}
```

Return a redirect or throw; don't render and then unmount. Unauthorized users should never see the page flash.

## Navigation

Imperative vs. declarative:

```
// Declarative — preferred for actions triggered by markup
<Link to={`/orders/${id}`}>View</Link>

// Imperative — for after-effect navigation (post-submit, post-auth)
await submit();
navigate('/orders');
```

`<Link>` / `<NuxtLink>` / `<a>` with client-side handling gets you:
- Prefetching on hover / visible.
- Correct ctrl/cmd/middle-click behaviour.
- Accessibility (focus ring, screen-reader announcement).

Avoid `onClick={() => navigate(...)}` on a `<div>` — it breaks all of that.

## Prefetching

The right-click / hover preload is the cheapest perf optimization available.

- **Hover**: preload route data on mouse over (~100ms before click).
- **Viewport**: preload links that appear on screen.
- **Intent**: preload the next step in a known flow (after login → dashboard).

Most modern routers support all three declaratively. Enable them.

## Transitions

Two patterns:

### Block-until-ready

Show the old page until the new route's data is loaded. Good for same-shell navigations.

```
{navigation.state === 'loading' && <TopProgressBar />}
<Outlet />
```

### Render-and-stream

Render the new layout immediately with `<Suspense>` boundaries for not-yet-loaded data. Better for deep nested data.

Pick per-route. Don't universalize one policy.

## 404s and fallbacks

Route declarations should include:
- An explicit 404 route at the end.
- An error boundary per route level.

```
{ path: '*', element: <NotFound /> }
```

Otherwise a mistyped URL renders a blank screen.

## Redirects

Put redirects at the router level, not in an effect.

```
# ❌ effect-based
useEffect(() => { if (!user) navigate('/login'); }, [user]);
// flash of protected content before effect runs

# ✅ route-level
loader: async () => {
  const user = await getUser();
  if (!user) throw redirect('/login');
  return user;
}
```

## Route parameters vs. path

- Path: `/orders/:id` — `id` is essential to identify the resource.
- Query: `/orders?filter=...&sort=...` — UI controls, non-essential to URL identity.

Rule: if two people share the URL, path params are "what am I looking at", query params are "how do I want to see it".

## Scroll restoration

On back/forward, restore the previous scroll. On forward navigation, scroll to top (or anchor).

Most routers offer `<ScrollRestoration />` / built-in behaviour. Use it. Manual scroll logic becomes buggy fast.

## Loading / pending UI per route

Each route knows what "loading" looks like — a skeleton, a progress bar, or nothing (for fast enough loads).

```
{
  path: '/dashboard',
  loader: fetchDashboard,
  element: <Dashboard />,
  pendingElement: <DashboardSkeleton />,   // or via Suspense boundary
}
```

Don't use a global spinner that blocks the whole app on every navigation. It makes the UI feel slow.

## Deep linking

Every URL should be shareable / bookmarkable / refreshable:

- Modals that represent significant state → put in URL (`/inbox/message/42`).
- Selected tab → query param.
- Filter pills → query param.
- Ephemeral UI (tooltip open, hover state) → not in URL.

If users screenshot and paste your URL, the page should load exactly what they saw.

## SSR / SSG / hybrid

For SEO-sensitive or fast-first-paint pages, server-render the initial route:

- **SSR** (Next.js, Nuxt, SvelteKit, Remix) — render per-request on the server.
- **SSG** (static generation) — render at build time.
- **ISR** (on-demand revalidation) — SSG + background refresh.
- **CSR** (traditional SPA) — render entirely in the browser.

Choice is architectural; covered more in the framework docs. From a routing perspective: route-level data loaders work identically across all four, which is the whole point of these routers.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `useEffect(() => fetch(...), [params])` in a component | Route loader |
| Mutating URL via `window.history.pushState` | Use the router API |
| Non-semantic "links" (`onClick` on `<div>`) | Use `<Link>` / `<a>` |
| Redirect via `useEffect` + `navigate` for unauthenticated pages | Route guard / loader redirect |
| Passing current route info via Context | Read from router — `useLocation` / `useRoute` |
| Nesting routes too deeply for the layout to match | Flatten; layouts and routes are separate axes |
| Skipping `<NotFound />` | Always have a 404 route |
| Treating the query string as throwaway | It's user state; design it |
