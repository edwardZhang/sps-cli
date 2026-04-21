# Containers

Dockerfile, multi-stage, size, rootless, base images.

## The goals

1. **Small** — ship less bytes, fewer CVEs, faster pulls.
2. **Reproducible** — same Dockerfile + same lockfile → same image.
3. **Secure** — no root, no shell if possible, minimal deps, signed.
4. **Fast to build** — layer caching aligned with change frequency.

## Base image selection

```
Prefer:  distroless > alpine > slim > full distro
```

| Base | Size | Trade-off |
|---|---|---|
| `gcr.io/distroless/static` | ~2 MB | No shell, no package manager. Static binaries only. |
| `gcr.io/distroless/base` | ~15 MB | libc, openssl, etc. Good for most compiled langs. |
| `alpine:3.20` | ~5 MB | musl libc (incompat with some packages); apk package manager |
| `debian:12-slim` | ~75 MB | glibc; widest compatibility; still small |
| `debian:12` / `ubuntu:24.04` | 120–200 MB | Full distro; use only when you need dev tools at runtime |

Choose the smallest one that runs your workload. Distroless is ideal for production runtime.

## Multi-stage builds

Separate build env from runtime env.

```dockerfile
# syntax=docker/dockerfile:1

# --- Build stage
FROM node:20-alpine AS build
WORKDIR /app

# Cache deps separately from source
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# Prune dev deps after build
RUN npm prune --omit=dev

# --- Runtime stage
FROM gcr.io/distroless/nodejs20-debian12
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
USER nonroot
EXPOSE 3000
CMD ["dist/server.js"]
```

Benefits:
- Build tools don't ship to prod.
- Different base OS for build vs runtime (Alpine to build, distroless to run).
- Smaller image, smaller attack surface.

## Layer order matters for caching

Stable layers first, volatile last.

```dockerfile
# ✅
COPY package.json package-lock.json ./     # stable; rarely changes
RUN npm ci                                    # cached unless lockfile changed
COPY . .                                       # volatile; changes every commit
RUN npm run build

# ❌ re-runs npm ci on every code change
COPY . .
RUN npm ci
RUN npm run build
```

## Pin versions

```dockerfile
FROM node:20.11.1-alpine3.19        # not node:20, not node:latest
# or pin by digest for strictest reproducibility:
FROM node@sha256:5b57a...
```

Tags are mutable; SHAs aren't. For prod, pin by SHA; for dev, tag is usually fine.

## Don't run as root

```dockerfile
# Debian-based
RUN groupadd --system app && useradd --system --gid app app
USER app

# Alpine
RUN addgroup -S app && adduser -S -G app app
USER app

# Distroless already provides a `nonroot` user
USER nonroot
```

Root inside a container is not isolation. Principle of least privilege applies here too.

## Don't bake secrets

```dockerfile
# ❌
ARG API_KEY
ENV API_KEY=$API_KEY         # baked into the image layer

# ✅ pass at runtime
docker run -e API_KEY=... myapp
# or mount from secret manager
```

Secrets that land in a layer are visible to anyone with the image. Rotating is painful.

## Build secrets (BuildKit)

For secrets needed **during build** only (e.g., private npm registry token):

```dockerfile
# syntax=docker/dockerfile:1.4
RUN --mount=type=secret,id=npm_token \
    NPM_TOKEN=$(cat /run/secrets/npm_token) npm ci
```

The secret doesn't persist in the final image.

## `.dockerignore`

Exclude the junk. Every extra file bloats the build context.

```
.git
node_modules
**/__pycache__
**/*.log
.DS_Store
.idea/
.vscode/
.env
tests/
.venv
target/
coverage/
dist/
```

A 2 GB build context on a 200 MB repo is a signal you need a `.dockerignore`.

## HEALTHCHECK

Declare how to know the container is alive.

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD curl -fsS http://localhost:3000/health || exit 1
```

Kubernetes uses its own liveness / readiness probes — set them in the manifest, not the Dockerfile. Docker Swarm / standalone Docker uses `HEALTHCHECK`.

## Signal handling

```dockerfile
# ✅ node handles SIGTERM directly (no shell in between)
CMD ["node", "server.js"]

# ❌ shell form — shell gets SIGTERM, may not forward to node
CMD node server.js
```

Exec form (array) runs the binary directly. Shell form runs `/bin/sh -c` and can swallow signals. Use exec form for main process.

For apps that don't handle signals, use `tini` as init:

```dockerfile
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["./my-binary"]
```

## Logging

Write to stdout / stderr. The container runtime collects these.

```dockerfile
# ❌ logs go into the container filesystem; lost on restart
CMD ["my-binary", "--log-file", "/var/log/app.log"]

# ✅ stdout
CMD ["my-binary"]       # app logs to stdout by default
```

## Image scanning

Run a scanner in CI (Trivy, Grype, Snyk).

```
trivy image myapp:sha-abc123
# fail build on HIGH/CRITICAL unfixed CVEs
```

Scan at build, again on a schedule (CVEs are disclosed after you build).

## Image signing (supply chain)

Sign images so the cluster can verify.

```
cosign sign --key cosign.key myregistry/myapp:sha-abc123
```

At deploy, policy (Kyverno, Gatekeeper, ECR policy, Sigstore policy-controller) verifies the signature before admission.

## Don't install what you don't need

Every package installed is:
- Bytes on the wire
- Disk on the node
- A CVE waiting to be reported

```dockerfile
# ❌
RUN apt-get update && apt-get install -y \
    curl vim git build-essential python3 netcat ...

# ✅
RUN apt-get update && apt-get install --no-install-recommends -y \
    ca-certificates && rm -rf /var/lib/apt/lists/*
```

Clean apt lists, yum caches, pip caches in the same layer that installed them.

## Distroless specifics

No shell. No `ls`, no `cat`, no `curl`. This is a feature.

- Healthcheck: use the binary itself (`myapp healthcheck`) or a Kubernetes probe over HTTP.
- Debugging: `kubectl exec` won't give you a shell. Use ephemeral debug containers (`kubectl debug`) or log more.

Downsides: ops is harder at first. Upside: drastically smaller attack surface.

## Image size — typical targets

| App | Target size |
|---|---|
| Go / Rust static binary | 5–15 MB |
| Node.js app | 100–200 MB |
| Python app | 100–250 MB |
| Java app (with JRE) | 150–250 MB |

If your Node image is 1.5 GB, you shipped `node_modules/` twice, left dev deps, or forgot `--omit=dev`.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `FROM ubuntu:latest` | Specific version; smaller base |
| `COPY . .` before `RUN npm ci` | Deps before source for cache |
| `apt-get install -y *` no cleanup | `rm -rf /var/lib/apt/lists/*` same layer |
| `RUN chmod ...` in 10 separate layers | Combine; each layer has size cost |
| Running as root | `USER` before CMD |
| Shell form CMD | Exec form, signals work |
| Logs to file inside container | stdout/stderr |
| `ADD` for local files | `COPY` — `ADD` also untars and downloads, surprising |
| Secrets in `ENV` / `ARG` | Mount at runtime |
| Every service uses a different base image | Standardize; fewer bases to scan and update |
