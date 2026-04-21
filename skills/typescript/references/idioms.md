# TypeScript — Idioms

Destructuring, optional chaining, nullish coalescing, modules.

## `const` / `let` / `var`

`const` by default. `let` only when reassigning. Never `var` — it has function scope and hoisting surprises.

```ts
const MAX = 10;
let count = 0;
for (const x of xs) count += x;
```

## Destructuring

```ts
// Object
const { id, email, name = 'unknown' } = user;

// Array
const [first, second, ...rest] = xs;

// Rename + default
const { id: userId, role = 'user' } = req;

// Nested
const { user: { id, email } } = response;
```

Avoid deep destructuring across many levels — it becomes hard to read. Two levels max.

## Optional chaining (`?.`) and nullish coalescing (`??`)

```ts
const city = user?.address?.city;                 // undefined if any part is null/undef
const port = config.port ?? 3000;                 // only falls back on null/undef
const items = maybeResponse?.items ?? [];
```

Don't confuse `??` with `||`:

```ts
const port = config.port || 3000;   // also falls back on 0, '', false
const port = config.port ?? 3000;   // only on null/undef
```

Use `||` when any falsy value should fall back; `??` when only "nothing" should.

## Spread & rest

```ts
// Spread — copy + override
const updated = { ...user, email: newEmail };
const concat = [...xs, ...ys];

// Rest in params
function log(first: string, ...rest: unknown[]) { ... }

// Rest in destructuring
const { password, ...publicUser } = user;
```

Rest destructuring is a cheap way to drop a field (`publicUser` above).

## Arrow vs. `function`

- Arrow for callbacks, one-liners, closures that need lexical `this`.
- `function` for top-level named functions that might be hoisted or recursive.

```ts
const double = (x: number) => x * 2;

function fibonacci(n: number): number {
  return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}
```

## Immutable updates

```ts
// ❌ mutation
user.email = newEmail;
xs.push(item);

// ✅ new value
const updated = { ...user, email: newEmail };
const next = [...xs, item];
```

Mutation is cheap but makes change hard to trace. In frontends (React, Vue) and any concurrent code, immutable updates are usually required, not optional.

Use `structuredClone(x)` (global, Node 17+, browsers) for deep clones. Avoid `JSON.parse(JSON.stringify(x))` — loses dates, maps, undefined.

## Modules — ESM, named exports

Use ESM (`import` / `export`) everywhere. No `require` in new code (TS emits `require` if the target is CommonJS; that's a toolchain choice, not a source style).

```ts
// ✅ named exports — grep-friendly, IDEs auto-import
export function parse(raw: string): Config { ... }
export const DEFAULT_TIMEOUT = 5000;

// ❌ default export + anonymous
export default function (raw: string): Config { ... }
```

Default exports make renames invisible (`import Foo from './x'`) and break auto-import. Use named exports and let the import name match the export name.

Allow `default` only when the language / framework demands it (React lazy routes, JSX component files by convention — team choice).

## `for...of` over `.forEach`

```ts
// ✅ — supports `await`, `break`, `continue`, `return`
for (const x of xs) {
  await process(x);
  if (done) break;
}

// ⚠️ .forEach ignores `return` and can't be awaited
xs.forEach(async x => await process(x));   // fires in parallel; next line doesn't wait
```

`forEach` is fine for pure synchronous side effects on small arrays. For anything else, `for...of`.

## Map / Set over object / array when keys aren't known strings

```ts
// ❌ object-as-map
const counts: Record<string, number> = {};
counts[key] = (counts[key] ?? 0) + 1;
// keys stringified; `constructor`, `__proto__` are footguns

// ✅ Map
const counts = new Map<string, number>();
counts.set(key, (counts.get(key) ?? 0) + 1);
```

Use `Map` when keys are dynamic, need iteration in insertion order, or aren't strings. Use `Set` for unique values.

## JSON at boundaries

Parse with a schema; never trust `JSON.parse(raw) as Config`.

```ts
// ❌
const config: Config = JSON.parse(raw);    // wrong at runtime; TS can't stop it

// ✅
const config = ConfigSchema.parse(JSON.parse(raw));   // zod throws on bad data
```

## String templates

Backticks for interpolation and multi-line.

```ts
const msg = `Hello ${name}, you have ${count} messages`;

const html = `
  <div>
    ${items.map(i => `<li>${i.name}</li>`).join('')}
  </div>
`;
```

For anything user-controlled rendered into HTML/SQL/shell, you need escaping, not templates. Templates are for formatting, not safety.

## Narrowing with `in`

```ts
function area(s: Circle | Square) {
  if ('radius' in s) return Math.PI * s.radius ** 2;
  return s.side ** 2;
}
```

`in` narrows to the variant that has the property. Works well with discriminated unions too, but `.kind` / `.type` discriminators are clearer.

## Short-circuit guards

Prefer guards at the top to deep nesting.

```ts
function process(user: User | null) {
  if (!user) return null;
  if (!user.active) return null;
  return doWork(user);
}
```

## Assertion functions

Marks a path as unreachable without narrowing.

```ts
function assert(c: unknown, msg: string): asserts c {
  if (!c) throw new Error(msg);
}

const x: string | null = maybe();
assert(x !== null, 'x must be set by now');
x.toLowerCase();           // narrowed to string
```

## `bigint`, `Date`, and friends

- `Date` has sharp edges (month 0-indexed, mutation). Prefer a lib (`date-fns`, `luxon`, native `Temporal` when widely available).
- `bigint` for integers > 2^53. Mixing `bigint` and `number` is a type error — good.
- `Symbol` — useful for unique keys and well-known protocols. Rarely needed in application code.

## `void` vs `undefined` in return types

- `void` for "I don't care what you return" (callbacks whose return is ignored).
- `undefined` when the function explicitly returns nothing.

```ts
function subscribe(cb: () => void) { ... }
// subscriber may return something; we ignore it.

function log(msg: string): undefined {
  console.log(msg);
  return;
}
```

Trivia, but CR-worthy in library code.

## `this` — lexical or bound, never `function` inside callbacks

```ts
// ❌ `this` is whatever called the callback
btn.addEventListener('click', function() { this.count++ });

// ✅ lexical `this` via arrow
btn.addEventListener('click', () => { this.count++ });
```

In classes, use `.bind(this)` at construction time, or use arrow-method field syntax:

```ts
class X {
  handle = () => { /* `this` is X, always */ };
}
```
