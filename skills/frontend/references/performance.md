# Performance

Rendering cost, bundle size, code-splitting, images, fonts.

## Measure first

No optimization without a number. Three cheap measures:

- **Lighthouse / PageSpeed Insights** — first-load & Core Web Vitals.
- **Browser DevTools Performance tab** — where time goes during interaction.
- **Framework-specific profiler** — React DevTools Profiler, Vue DevTools, Svelte's built-in.

Target Core Web Vitals (real-user, 75th percentile):
- **LCP** (Largest Contentful Paint) < 2.5 s
- **INP** (Interaction to Next Paint) < 200 ms
- **CLS** (Cumulative Layout Shift) < 0.1

If one is green, stop. Optimizing green metrics is churn.

## Initial load

### Bundle size

Use the bundler's analyzer (`rollup-plugin-visualizer`, `webpack-bundle-analyzer`, Next's built-in). Look for:

- **Duplicate libraries** — two copies of React / lodash usually mean a version mismatch.
- **Locales / polyfills** — `moment` ships every locale by default; `date-fns-tz` / `luxon` are leaner.
- **Barrel re-exports** defeating tree-shaking — named imports work only if the dependency's `package.json` says `"sideEffects": false`.

### Code splitting

Load only what the current route needs.

```
const Settings = lazy(() => import('./features/settings/Settings'));

<Suspense fallback={<Skeleton />}>
  <Settings />
</Suspense>
```

Route-level splitting is free with modern routers. Component-level splitting is worth it for:
- Heavy third-party libs (rich text editor, chart lib, map lib) loaded only when the feature opens.
- Large modals / drawers.

### Preloading

Tell the browser what's coming:

```
<link rel="preload" as="font" href="/fonts/inter.woff2" crossorigin>
<link rel="preconnect" href="https://api.example.com">
<link rel="dns-prefetch" href="https://cdn.example.com">
```

Or via framework API (`next/link` prefetch, `<Link>` prefetch). Pair with hover / viewport prefetching (see `routing.md`).

## Render cost

### Keep updates local

One component updating should not re-render the whole tree. Signals (Solid, Vue refs, Svelte reactivity) are fine-grained by default. React re-renders by reference — containment is on you:

- Split components so state lives near where it changes.
- Memoize the boundary with `React.memo`.
- Stable callback / object references (`useCallback`, `useMemo`).

Don't spray memoization everywhere. Measure; memoize where it matters.

### Expensive children

```
function List({ items }) {
  return items.map(i => <Row key={i.id} item={i} />);
}
```

If `Row` is expensive and `List` gets a new `items` array reference (but same data), every row re-renders. Either:
- Use the cache lib to return stable references from queries.
- Memoize `Row` with equality on `item.id` + `item.version`.

### Lists — virtualize if big

Rendering 10 000 DOM nodes is slow at any framework. Use `react-window`, `@tanstack/virtual`, or `IntersectionObserver`-based lazy rendering.

Rule of thumb: virtualize any list that might show more than a couple hundred items.

### Avoid layout thrashing

Writing to the DOM (style, class) then reading (offsetHeight, getBoundingClientRect) in the same frame forces re-layout. Batch reads, then writes.

```
# ❌
for (const el of items) {
  el.style.height = 'auto';
  const h = el.offsetHeight;         // forces layout
  el.dataset.h = h;
}

# ✅
const heights = items.map(el => el.offsetHeight);   // read
items.forEach((el, i) => el.dataset.h = heights[i]); // write
```

Use `IntersectionObserver`, `ResizeObserver` instead of `getBoundingClientRect` in scroll / resize handlers.

## Images

Biggest easy win. Order of effect:

1. **Right size.** Don't serve a 2000 × 2000 JPEG into a 400 × 400 avatar slot.
2. **Right format.** AVIF > WebP > JPEG for photos; PNG / SVG for flat.
3. **Responsive `srcset` / `<picture>`** so mobile doesn't fetch desktop-size images.
4. **Lazy-load below-the-fold** with `loading="lazy"` or `IntersectionObserver`.
5. **Modern image component** (`next/image`, `nuxt/image`) auto-serves the right size/format with `priority` hints for the LCP image.

```
<img src="hero-400.avif"
     srcset="hero-400.avif 1x, hero-800.avif 2x"
     sizes="(max-width: 600px) 400px, 800px"
     loading="lazy"
     width="400" height="300"
     alt="...">
```

Always set `width` and `height` (or aspect-ratio). Reserves layout space; kills CLS.

## Fonts

Web fonts are costly — big, render-blocking without hints.

```
<link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin>
```

```css
@font-face {
  font-family: 'Inter';
  src: url('/fonts/inter.woff2') format('woff2');
  font-display: swap;       /* show fallback text while loading; swap in when ready */
}
```

- **Subset** to characters you use (`glyphhanger`, `pyftsubset`).
- **`font-display: swap`** avoids invisible text during load (FOIT).
- **System font stacks** are free and fast if your brand allows.

## JavaScript execution

Third-party scripts (analytics, chat widgets, A/B tools) are the leading cause of poor INP.

- Load non-critical scripts with `async` / `defer`.
- Consider `requestIdleCallback` for non-urgent work.
- Audit what's on the critical path; "one more tag" slows every user.

## Caching

Set `Cache-Control` headers generously on static assets. Combine with content-hashed filenames (`main.f3a7c.js`) so long TTLs don't prevent deploys.

```
Cache-Control: public, max-age=31536000, immutable       # hashed assets
Cache-Control: no-cache                                   # HTML
```

Service workers (PWA) add offline caching; use a tested recipe (Workbox) rather than hand-rolling.

## Reducing main-thread work

Identify long tasks in DevTools (purple blocks). Common offenders:

- JSON parsing large payloads — use streaming (NDJSON), smaller pages.
- Expensive computations during render — move to a Web Worker.
- Hydration in SSR apps — use selective / streaming hydration (React Server Components, Qwik's resumability, Astro Islands).

## Web Workers — for CPU-bound work

For image processing, parsing, crypto, heavy transforms.

```
const worker = new Worker(new URL('./heavy.worker.js', import.meta.url), { type: 'module' });
worker.postMessage({ data });
worker.onmessage = (e) => setResult(e.data);
```

Libraries: `comlink` makes postMessage feel like async function calls. `workerize-loader` auto-splits.

## Avoid Layout Shift (CLS)

- Reserve space for images (`width` / `height` or `aspect-ratio`).
- Avoid late-loaded content above existing content (banners, cookies) — overlay or reserve.
- Use CSS `font-size-adjust` and fallback metrics to minimize FOUT jumps.

## Performance budgets

Set numbers in CI:

```
# lighthouse-ci or equivalent
"assertions": {
  "categories:performance": ["error", {"minScore": 0.9}],
  "largest-contentful-paint": ["warn", {"maxNumericValue": 2500}]
}
```

Budget violations block merge. Without numbers, perf erodes silently.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Importing a huge lib for one function | Tree-shake (`lodash-es`), or copy the function |
| Sending 5 MB JS to render 50 KB of content | Code-split; audit bundles |
| No lazy-loading for below-the-fold images | `loading="lazy"` / image component |
| Missing width/height on `<img>` | Causes CLS |
| `@import` in CSS | Blocks; bundle with build tool |
| 20 third-party scripts on the critical path | Load deferred; remove what doesn't earn its weight |
| Shipping unminified dev builds | Build step + server compression |
| SSR hydrating the entire page on mount | Selective / islands / RSC |
| Animation with `top`/`left` / `width`/`height` (triggers layout) | Use `transform` / `opacity` |
