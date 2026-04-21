# Security

Authentication, authorization, input validation, rate limiting, secrets. The non-negotiables.

## AuthN vs AuthZ

| | Authentication | Authorization |
|---|---|---|
| Answers | Who are you? | What can you do? |
| Failure code | 401 | 403 |
| Mechanism | Session, token, signature | Role / policy / permission check |

Never conflate these. A 401 says "tell me who you are"; a 403 says "I know who you are and you can't do this".

## Session vs token

| | Server session | Stateless token (JWT) |
|---|---|---|
| State | Server-side (DB / Redis) | In the token itself |
| Revocation | Delete session row | Hard — need blocklist or short TTL |
| Scale | Needs sticky / shared store | Stateless across servers |
| Size on wire | Small (cookie id) | Large (signed payload) |
| First-party web | Excellent | Overkill |
| Service-to-service | Weak | Natural fit |

For a browser-based web app, **server-side sessions with secure cookies** are usually the right answer. JWTs shine for APIs, federation, and service-to-service.

## Cookies — secure defaults

```
Set-Cookie: session=abc...; Secure; HttpOnly; SameSite=Lax; Path=/
```

- **Secure** — HTTPS only.
- **HttpOnly** — JS can't read it (blocks XSS-based token theft).
- **SameSite=Lax** — default; blocks CSRF on cross-site POSTs. Use `Strict` for admin; `None` + `Secure` only for true cross-origin use cases.
- **Path** — scope to where it's needed.
- Don't store user data in the cookie payload; store an opaque session id.

## JWT rules

- Always check signature. Reject `alg: none`. Reject unexpected algorithms.
- Verify `iss`, `aud`, `exp`, `nbf`.
- Short lifetime (5–15 min) + rotating refresh token.
- Don't put secrets inside; tokens are readable by anyone who has them.
- Rotate signing keys; publish via JWKS.
- Revocation: maintain a short jti blocklist in Redis for stolen-token cases.

## Authorization models

| Model | Use when |
|---|---|
| RBAC (roles) | Small fixed set of roles: admin, user, moderator |
| ABAC (attributes) | Rules depend on attributes of user, resource, time, IP |
| ReBAC (relationships) | "Can Alice read doc X?" answered via a graph (Google Zanzibar / OpenFGA) |
| Policy-as-code (OPA, Cedar) | Complex rules that need to live outside the app |

Start with RBAC. Graduate to ReBAC/ABAC when roles no longer express the rules. Never hard-code `if user.email == "admin@x.com"`.

## Enforce authorization at the boundary

Every handler starts with a permission check. No implicit trust.

```
handler(req):
    user = requireAuth(req)
    resource = repo.load(req.id)
    if not user.can(READ, resource):
        return 403 | 404           # 404 if the existence of the resource is itself secret
    return resource
```

`403` vs `404`: return 404 if the existence of the resource is itself secret (e.g., private documents); return 403 otherwise.

## Input validation

Validate everything at the edge, once. Never trust "internal" callers.

```
schema:
    email   : string, format=email
    age     : int, 0 <= x <= 150
    role    : enum(user, admin)

handler(req):
    cmd = schema.parse(req.body)      # rejects anything else
    useCase.execute(cmd)
```

Rules:
- Whitelist what you accept, not blacklist what you reject.
- Reject unknown fields (guard against mass-assignment).
- Bound all variable-size inputs (strings, arrays): `max_length`, `max_items`.
- Parse into strong types at the boundary; don't pass raw dicts through the system.

## Injection defenses

- **SQL**: parameterized queries ONLY. Never string-concatenate. ORMs handle this if you use their query API, not raw strings.
- **Command**: don't build shell commands from user input. If you must: use array-form `exec` (no shell) and whitelist args.
- **LDAP / XPath / NoSQL**: same rule — parameterize.
- **Template injection**: never render user input as a template (Jinja2, ERB, etc.).
- **Path traversal**: canonicalize and assert the result is inside an allow-listed directory.
- **Prototype pollution / mass assignment**: whitelist fields; never `Object.assign(user, req.body)`.

## Passwords

- **argon2id** (preferred) or **bcrypt** (with cost ≥ 12). Never SHA-* for passwords.
- Never log passwords, even hashed.
- Enforce length (≥ 12 chars), not character classes. Check against a breached-password list (HaveIBeenPwned API / offline list).
- Account-level lockout on repeated failures, plus rate limiting per IP/account.

## Secrets

- Never in source control. `.env` files are .gitignored; production secrets come from a secret manager (Vault, AWS Secrets Manager, GCP Secret Manager, 1Password Connect).
- Rotate on compromise AND on a schedule.
- Scope per-service and per-environment. One stolen dev key should never reach prod.
- Don't print secrets to logs. Redact at the logger config.

## Rate limiting

Apply at the edge (CDN/API gateway) AND per-endpoint in the app.

Limits by identity:
- Anonymous: by IP — coarse, bypassable with proxies.
- Authenticated: by user id — reliable.
- Authenticated + IP: both, for defense in depth.

Algorithms:
- **Token bucket**: allows short bursts; refill rate controls long-run.
- **Fixed window**: simple, but bursty at boundaries.
- **Sliding window**: smooth; costs more.

Always include `Retry-After` on 429 responses.

## CSRF

Required if the client is a browser using cookies. Not required if you use `Authorization: Bearer` (attacker can't trigger the header).

Defenses, pick one:
- **SameSite=Lax cookie** (default-covers most cases).
- **Double-submit cookie** — random token in cookie AND in a header; server checks they match.
- **Synchronizer token** — per-session token in the form + server-side store.

## CORS

Set it to what you actually need. `Access-Control-Allow-Origin: *` with credentials is a silent vulnerability — browsers refuse, but a misconfigured gateway can still leak.

```
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Credentials: true
Access-Control-Allow-Methods: GET, POST, PATCH, DELETE
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Max-Age: 86400
```

## Security headers (for any HTML-serving endpoint)

```
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
Content-Security-Policy: default-src 'self'; ...
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

## Audit logging

Every security-relevant event gets an immutable log entry:
- login (success / fail), password change, role change, permission change
- admin actions, data exports
- access to sensitive resources

Include: actor, action, target, timestamp, source IP, request id. Store separately from app logs so a compromised app can't tamper with them.

## Anti-patterns

| Anti-pattern | Why |
|---|---|
| Rolling your own crypto | Don't. Use the standard library / vetted lib. |
| Comparing secrets with `==` | Timing attack; use constant-time compare |
| Returning different errors for "user doesn't exist" vs "wrong password" | Username enumeration |
| Trusting `X-Forwarded-For` without checking source | Spoofable; respect it only from trusted proxies |
| One API key per team, shared over Slack | No revocation granularity |
| Storing JWTs in localStorage | XSS steals them; use HttpOnly cookies |
| "Security through obscurity" (weird endpoint paths) | Not a control |
| Disabling TLS verification "temporarily" in prod | Never |
