# TypeScript — Tooling

`tsconfig`, linting, formatting, bundlers, monorepos.

## `tsconfig.json` — the baseline

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,

    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,

    "resolveJsonModule": true,
    "isolatedModules": true,

    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,

    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"],
  "exclude": ["**/*.test.ts", "dist"]
}
```

Key switches:

| Option | Why |
|---|---|
| `strict: true` | Turns on all strict flags. Required. |
| `noUncheckedIndexedAccess` | `arr[0]` returns `T \| undefined`. Prevents off-by-one bugs. |
| `exactOptionalPropertyTypes` | `{ x?: number }` vs `{ x: number \| undefined }` are actually different. |
| `isolatedModules` | Required for swc/esbuild/bun. Catches things the single-file compilers can't handle. |
| `skipLibCheck: true` | Faster; trust your deps. |

## Node vs. bundler resolution

`moduleResolution: "Bundler"` for Vite, esbuild, webpack, Vite, Bun. `"NodeNext"` for plain Node.js. Pick based on the runtime.

## Path aliases

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  }
}
```

Mirror this in the bundler and test runner, or imports resolve in TS but not at runtime.

## Linting — ESLint (flat config)

```js
// eslint.config.js
import tseslint from 'typescript-eslint';
export default tseslint.config(
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: { parserOptions: { project: true } },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
```

High-signal rules:
- `no-floating-promises` — forgotten `await` is a frequent bug
- `switch-exhaustiveness-check` — forgotten case in a union switch
- `no-misused-promises` — `async` callback passed where sync is expected
- `consistent-type-imports` — `import type { X }` keeps runtime lean

## Formatting — Prettier (or project-specific)

Let the formatter run in CI and on save. Don't argue style in PRs.

```json
// .prettierrc
{
  "semi": true,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "arrowParens": "always"
}
```

Team preference is fine — the choice matters less than the consistency.

## `tsc` vs. the bundlers

| Tool | Role |
|---|---|
| `tsc` | Type checking + `.d.ts` emit |
| `esbuild` / `swc` | Fast transpile (strip types, downlevel syntax) |
| `tsup` / `rollup` | Libraries with exports maps |
| `vite` / `rsbuild` / `rspack` | App bundling (frontend / dev server) |

Typical modern setup: `vitest` for tests, `vite` for the dev server, `tsc --noEmit` in CI for type checking. Transpile is handled by the bundler — `tsc` is not on the hot path.

## Package managers

`pnpm` is the default recommendation:
- Content-addressable store → disk savings, fast installs
- Strict by default → catches phantom dependencies
- Excellent monorepo support via workspaces

`npm` works. `yarn classic` (v1) is deprecated; `yarn berry` (v3+) is fine but niche. `bun` is fastest but still rough around the edges for some toolchains.

Commit the lockfile.

## Monorepo

For 3+ packages that share code, use workspaces.

```json
// package.json (root)
{
  "private": true,
  "workspaces": ["packages/*", "apps/*"]
}
```

Prefer workspace tools over hand-rolled symlinks:
- `pnpm` workspaces (native)
- `turborepo` / `nx` for task orchestration + caching
- `changesets` for versioning + release notes

Keep the dependency graph explicit — `apps/web` depends on `packages/ui`, not the reverse.

## `package.json` essentials

```json
{
  "name": "@org/pkg",
  "version": "1.2.0",
  "type": "module",
  "exports": {
    ".":         { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./utils":   { "types": "./dist/utils.d.ts", "import": "./dist/utils.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build":     "tsup src/index.ts --format esm --dts",
    "test":      "vitest run",
    "lint":      "eslint .",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=20" }
}
```

- `type: "module"` — ESM by default. New projects should be ESM.
- `exports` — explicit public API, not "everything in the dist directory".
- `engines` — fail loudly when users install on an unsupported Node.

## Dev vs. prod dependencies

- `dependencies`: anything the shipped app actually runs
- `devDependencies`: build tools, test frameworks, types
- `peerDependencies`: libraries (only) — "I need X, user provides it"

A library that ships `react` in `dependencies` causes duplicate-React bugs. Put it in `peerDependencies` with a loose range.

## CI checklist

```yaml
# GitHub Actions sketch
- run: pnpm install --frozen-lockfile
- run: pnpm typecheck
- run: pnpm lint
- run: pnpm test --coverage
- run: pnpm build
```

Order matters: typecheck before tests (cheap fail); lint before tests (cheap fail); build last.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `strict: false` | Turn it on; fix errors incrementally with `// @ts-expect-error` |
| `tsc` on every file save in a large repo | Use `--incremental` or IDE's language server |
| Leaving `skipLibCheck: false` | Fine for a tiny project; wastes CI on any larger one |
| Committing `dist/` | Publish it, don't commit it |
| `type: "commonjs"` in new projects | Go ESM |
| Mixing formatters across directories | One config at the repo root |
| `ts-node` in production | Pre-compile; don't transpile at boot |
