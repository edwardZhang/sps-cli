# TypeScript — Types

Generics, unions, discriminated unions, utility types, brands.

## `unknown` over `any`

`any` disables type checking. `unknown` forces you to narrow before use.

```ts
// ❌ silent bugs
function parse(raw: any) {
  return raw.user.email.toLowerCase();   // crashes at runtime, no TS error
}

// ✅
function parse(raw: unknown) {
  if (typeof raw === 'object' && raw !== null && 'user' in raw) {
    // ... still need more narrowing
  }
}

// ✅✅ parse at boundary with a schema
import { z } from 'zod';
const Schema = z.object({ user: z.object({ email: z.string().email() }) });
function parse(raw: unknown) {
  const { user } = Schema.parse(raw);    // throws on bad shape
  return user.email.toLowerCase();
}
```

## Discriminated unions — the TS superpower

Model state with a tagged sum type. Narrowing happens automatically.

```ts
type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

function handle(r: Result<User, Error>) {
  if (r.ok) {
    // r is narrowed to { ok: true; value: User }
    console.log(r.value.name);
  } else {
    // r is narrowed to { ok: false; error: Error }
    console.error(r.error.message);
  }
}
```

Prefer over boolean flags + optional fields:

```ts
// ❌
type Loading = { isLoading: boolean; data?: User; error?: string };

// ✅
type Loading =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; data: User }
  | { status: 'error'; error: string };
```

The compiler stops you from accessing `data` on an `error` state.

## Exhaustiveness checks

When you switch over a union, make sure every case is handled.

```ts
function render(r: Loading) {
  switch (r.status) {
    case 'idle':    return <Idle />;
    case 'loading': return <Spinner />;
    case 'success': return <Show data={r.data} />;
    case 'error':   return <Err msg={r.error} />;
    default:        return assertNever(r);
  }
}

function assertNever(x: never): never {
  throw new Error(`Unreachable: ${JSON.stringify(x)}`);
}
```

Add a new variant → the compiler forces you to update every `switch`.

## Generics

Use when a function / class preserves a type relationship.

```ts
function first<T>(xs: readonly T[]): T | undefined {
  return xs[0];
}

// Bounded
function byId<T extends { id: string }>(xs: T[], id: string): T | undefined {
  return xs.find(x => x.id === id);
}

// Default
type Paginated<T, Cursor = string> = {
  data: T[];
  nextCursor: Cursor | null;
};
```

If a generic parameter appears only once in the signature, you probably don't need generics.

## Utility types — the greatest hits

| Type | Use |
|---|---|
| `Partial<T>` | All fields optional |
| `Required<T>` | All fields required |
| `Readonly<T>` | All fields readonly |
| `Pick<T, K>` | Subset of fields |
| `Omit<T, K>` | All fields except K |
| `Record<K, V>` | Map-like object |
| `Awaited<P>` | Unwrap Promise |
| `ReturnType<F>` | The return type of a function |
| `Parameters<F>` | Tuple of function params |
| `NonNullable<T>` | Exclude null / undefined |

```ts
type User = { id: string; email: string; password: string };
type PublicUser = Omit<User, 'password'>;
type UserUpdate = Partial<Pick<User, 'email' | 'password'>>;
```

## Branded types

Prevent string / number mix-ups at compile time.

```ts
type Brand<K, T> = K & { __brand: T };

type UserId = Brand<string, 'UserId'>;
type OrgId  = Brand<string, 'OrgId'>;

function userId(s: string): UserId { return s as UserId; }
function orgId(s: string): OrgId   { return s as OrgId; }

function findUser(id: UserId): User { ... }

findUser(userId('u_1'));        // ✅
findUser('u_1');                 // ❌ not a UserId
findUser(orgId('o_1'));          // ❌ wrong brand
```

The runtime cost is zero — it's just a compile-time distinction. Use it for domain ids, units, hashed vs raw strings.

## Type guards

Custom predicates that narrow.

```ts
function isUser(x: unknown): x is User {
  return typeof x === 'object' && x !== null && 'id' in x && typeof (x as any).id === 'string';
}

const raw: unknown = fetchSomething();
if (isUser(raw)) {
  raw.id.toLowerCase();          // raw is narrowed to User
}
```

For anything more than two fields, use a schema validator (`zod`, `valibot`). Hand-written guards drift from the shape.

## `as const` — literal-typed values

Widening turns `"hello"` into `string`. `as const` keeps it literal.

```ts
const ROLES = ['admin', 'user', 'guest'] as const;
type Role = typeof ROLES[number];    // 'admin' | 'user' | 'guest'

const CONFIG = { retries: 3, timeout: 5000 } as const;
// CONFIG.retries is 3, not number; CONFIG is readonly
```

## Conditional & mapped types — use sparingly

Powerful, but expensive on the reader. Reach for them when the alternative is copy-paste.

```ts
// Conditional
type NonNull<T> = T extends null | undefined ? never : T;

// Mapped
type Nullable<T> = { [K in keyof T]: T[K] | null };

// Both, with `infer`
type UnwrapArray<T> = T extends (infer U)[] ? U : T;

type X = UnwrapArray<User[]>;        // User
type Y = UnwrapArray<string>;        // string
```

If the type gets fancy enough that a teammate asks "what does this do?", add a comment with an example, or simplify.

## `never` — the bottom type

`never` appears when TS knows no value can reach here.

```ts
function throwErr(m: string): never { throw new Error(m); }

const x = cond ? 1 : throwErr('no');   // x is number

// Exhaustiveness (see above)
default: return assertNever(r);
```

`never` in a position where you expect a value is a bug signal: "you forgot a case".

## `satisfies` — typecheck without widening

Force a value to conform to a type, but keep its narrow inferred type.

```ts
const routes = {
  home: '/home',
  profile: '/profile/:id',
} satisfies Record<string, string>;

// routes.home is the literal "/home", not string
type RouteKey = keyof typeof routes;    // 'home' | 'profile'
```

Great for config objects. `as Record<string, string>` would erase the literals.

## Enums — avoid; prefer string unions

```ts
// ❌ enum (generates runtime code, not tree-shakeable, weird reverse mapping)
enum Role { Admin, User, Guest }

// ✅ string union (zero runtime, tree-shakeable, grepable)
type Role = 'admin' | 'user' | 'guest';

// ✅ object + `as const` if you need a value container
const Role = { Admin: 'admin', User: 'user', Guest: 'guest' } as const;
type Role = typeof Role[keyof typeof Role];
```

`const enum` exists but trips up bundlers and project-references. Not worth it.

## Class vs. type vs. interface

| Use | When |
|---|---|
| `type` | Unions, intersections, mapped / conditional, brands, non-extensible shapes |
| `interface` | Public object contract, open for extension by users (declaration merging) |
| `class` | Need a runtime object with methods and state |

Prefer `type` for data and `interface` for object behaviours. Don't mix conventions arbitrarily.
