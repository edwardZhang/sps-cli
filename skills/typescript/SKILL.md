---
name: typescript
description: TypeScript language skill — types, idioms, async, tooling. Pair with end skills (`backend`, `frontend`, `mobile`) for architecture and with `coding-standards` for cross-language principles.
origin: ecc-fork + original (https://github.com/affaan-m/everything-claude-code, MIT)
---

# TypeScript

Type system, idioms, async, tooling. **Language-focused**. Architecture belongs to end skills; general principles (TDD, naming, error strategy) live in `coding-standards`.

## When to load

- Project primary language is TypeScript (Node.js / Deno / Bun / browser)
- Reviewing TS code
- Designing types, generics, discriminated unions
- Setting up `tsconfig.json`, build, test tooling

## Core principles

1. **`strict: true`, always.** Non-negotiable. The rest of TS is barely worth using without it.
2. **No `any`.** Use `unknown` + narrowing if you don't know the shape. Every `any` in review gets a blocker.
3. **Types describe intent.** Prefer `UserId` branded type over bare `string`; use discriminated unions over boolean flags.
4. **Inference first.** Let TS infer; add annotations on public signatures and where inference is wrong or opaque.
5. **`const` by default, `let` only when reassigning.** Never `var`.
6. **Immutability where practical.** `readonly` on fields, `ReadonlyArray<T>` for inputs.
7. **`===` only.** `==` has JS quirks; there is no legitimate reason to use it in new code.
8. **Explicit error types at boundaries** (HTTP, queue, FFI). Inside, throw freely.

## How to use references

| Reference | When to load |
|---|---|
| [`references/types.md`](references/types.md) | Generics, unions, discriminated unions, conditional types, utility types, brands |
| [`references/idioms.md`](references/idioms.md) | Destructuring, optional chaining, nullish coalescing, modules, enums vs. union |
| [`references/async.md`](references/async.md) | Promises, async/await, error propagation, cancellation (AbortController), concurrency |
| [`references/errors.md`](references/errors.md) | Error classes, `Result` / `neverthrow`, `try/catch`, re-throw semantics |
| [`references/testing.md`](references/testing.md) | Vitest / Jest, mocking, fixtures, integration tests |
| [`references/tooling.md`](references/tooling.md) | `tsconfig`, ESLint, formatter, bundlers, monorepo layout |

## Forbidden patterns (auto-reject)

- `any` without a comment explaining why
- `as X` casts without runtime validation (use a schema validator at boundaries)
- `==` / `!=`
- `var`
- Unhandled promise (`.then()` without `.catch()`, or an `await` without containing `try`)
- `Function` / `Object` as a type
- Default-exporting everything in new code (named exports — one public name per import)
- Enums for string constants (use literal string unions instead — smaller, tree-shakeable)
- Mutating function parameters
- `console.log` left in committed code
