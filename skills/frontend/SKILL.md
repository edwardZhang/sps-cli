---
name: frontend
description: Frontend end skill — components, state, routing, performance, accessibility, testing. Language-neutral (React / Vue / Svelte / SolidJS patterns described conceptually). Pair with a language skill and `coding-standards`.
origin: ecc-fork + original (https://github.com/affaan-m/everything-claude-code, MIT)
---

# Frontend

Client-side architecture. **Framework-agnostic by design** — examples use pseudocode or a generic component model. Pair with a language skill (`typescript`) and a framework choice.

## When to load

- Building or reviewing UI in the browser (web / PWA / Electron)
- State management: local, server, global
- Routing, navigation, deep linking
- Rendering performance, bundle size
- Accessibility, i18n, SEO
- Frontend testing (component, E2E)

## Core principles

1. **State is the hard part. Components are easy.** Get state shape right and most code writes itself.
2. **Server state ≠ client state.** Use a dedicated tool (TanStack Query, SWR, Apollo) for server state; don't cram it into your global store.
3. **Derive, don't duplicate.** If two pieces of state must stay in sync, at least one is derived.
4. **Optimistic UI for responsiveness, reconciliation for correctness.** Show the expected result immediately; update on server response.
5. **Measure before optimizing.** Bundle analyzer, Lighthouse, React Profiler / equivalent.
6. **Accessibility is not optional.** Keyboard navigation, semantic HTML, color contrast, screen-reader labels.
7. **Keep components dumb.** Props in, events out. Move side effects to hooks / composables / stores.

## How to use references

| Reference | When to load |
|---|---|
| [`references/components.md`](references/components.md) | Component shape, props, composition, slots / children, separation of concerns |
| [`references/state.md`](references/state.md) | Local vs. shared, server state, derived, stores, forms |
| [`references/routing.md`](references/routing.md) | Client routing, navigation, deep linking, query params, guards |
| [`references/performance.md`](references/performance.md) | Rendering cost, code-splitting, virtualization, images, fonts |
| [`references/accessibility.md`](references/accessibility.md) | Semantic HTML, keyboard, ARIA, focus management, contrast |
| [`references/testing.md`](references/testing.md) | Component tests, snapshot tests, E2E (Playwright), visual regression |

## Forbidden patterns (auto-reject)

- Business logic inside presentational components
- Global mutable state for server data (keep server data in a cache, not in Redux/Zustand directly)
- Fetching in a loop of unrelated components (N+1 on the client)
- Mutating props
- `any` / untyped props (in typed frontends)
- Accessibility via `role="button"` on a `<div>` when `<button>` works
- Inline styles driven by state when a class + CSS toggle would do
- `dangerouslySetInnerHTML` / `v-html` without a sanitizer
- `useEffect` / `watchEffect` for derivations — use computed values
- Animation / loading state toggled by timeouts instead of by actual completion events
