# API Design

REST, GraphQL, gRPC conventions. Focus on contracts, not implementations.

## Style selection

| Style | Good for | Weak for |
|---|---|---|
| REST | CRUD resources, public APIs, cacheable reads | Rich queries, partial responses, real-time |
| GraphQL | Client-driven shape, many UIs against one backend | Simple CRUD, caching, rate limiting per field |
| gRPC | Service-to-service, strict schemas, streaming | Browsers without a proxy, public APIs |

When in doubt, start with REST. Switch later if the pain justifies the churn.

## REST resource conventions

Nouns, plural, lowercase, hyphenated. Hierarchy reflects ownership.

```
GET    /users                      # list
GET    /users/{id}                 # read one
POST   /users                      # create
PUT    /users/{id}                 # full replace
PATCH  /users/{id}                 # partial update
DELETE /users/{id}                 # delete

GET    /users/{id}/orders          # sub-resources
POST   /users/{id}/orders
```

Avoid verbs in paths (`/getUser`, `/createOrder`). If an action truly doesn't fit CRUD, sub-resource it: `POST /orders/{id}/cancel`.

## Pagination

Cursor-based for anything that can grow. Offset/limit is fine for small fixed sets.

```
# Cursor (preferred for large / infinite lists)
GET /events?cursor=eyJpZCI6MTIzfQ&limit=50
# Response
{
  "data": [...],
  "next_cursor": "eyJpZCI6MTczfQ",
  "has_more": true
}

# Offset (fine for small admin views)
GET /users?offset=0&limit=20
```

Offset pagination breaks silently when rows are inserted during paging; cursors don't.

## Filtering, sorting

```
GET /orders?status=paid&created_after=2026-01-01&sort=-created_at&limit=20

# Sort prefix: - for descending
sort=-created_at,name
```

Whitelist allowed filter and sort fields. Never pass user-provided strings into query builders without validation.

## Error responses

Consistent shape everywhere. Problem Details (RFC 9457) is a reasonable default.

```json
{
  "type": "https://errors.example.com/validation",
  "title": "Validation failed",
  "status": 422,
  "detail": "email is required",
  "errors": [
    { "field": "email", "code": "required" },
    { "field": "age", "code": "out_of_range" }
  ],
  "request_id": "req_01HX..."
}
```

Rules:
- `status` matches the HTTP status.
- `request_id` correlates with server logs.
- Never leak stack traces to clients.

## HTTP status codes

| Code | Use for |
|---|---|
| 200 | Successful read or update |
| 201 | Resource created; include `Location` header |
| 202 | Async accepted; polling URL in body or `Location` |
| 204 | Success with no body (e.g. DELETE) |
| 400 | Malformed request (bad JSON, missing path param) |
| 401 | No / invalid auth |
| 403 | Authenticated but forbidden |
| 404 | Resource does not exist (or is hidden from this caller) |
| 409 | Conflict (duplicate, version mismatch) |
| 422 | Well-formed but semantically invalid |
| 429 | Rate limited; include `Retry-After` |
| 500 | Unexpected server error |
| 503 | Dependency down / overloaded |

`400` vs `422`: parse error vs validation error. `403` vs `404`: exposing 403 leaks existence of the resource — return `404` when that leak matters.

## Versioning

Pick one and be consistent.

| Strategy | Example | Trade-off |
|---|---|---|
| URL | `/v1/users`, `/v2/users` | Simple; clutters paths; forces clients to migrate wholesale |
| Header | `Accept: application/vnd.api+json;version=2` | Clean URLs; harder to test in curl |
| Query | `/users?v=2` | Easy; often accidentally cached |

Bump the major version only for breaking changes. Additive changes (new optional fields) go in the same version.

## Idempotency

Any non-GET request that retries must be safe. Accept an `Idempotency-Key` header for unsafe methods.

```
POST /payments
Idempotency-Key: 7a8b9c...
```

Server stores `(key, request_hash) -> response` for N hours. Same key + same body → return stored response. Same key + different body → 409.

## GraphQL conventions

- One endpoint: `POST /graphql`.
- Mutations return the modified object plus a client-defined selection, so the UI can update without a refetch.
- Don't expose database IDs; use opaque global IDs (Relay spec) if you want pagination federation.
- Enforce max query depth and complexity to prevent DoS-by-query.

## gRPC conventions

- Use proto3.
- Every field is optional; breaking changes happen when you rename or renumber.
- Stream only when the payload doesn't fit one response.
- Put auth in metadata, not in the request message.

## Response shape

Keep it flat. Don't wrap with `{ success: true, data: ... }` unless your framework forces it — HTTP status already signals success.

```json
# Single resource
{ "id": "u_01H", "name": "Alice", "email": "a@x.com" }

# Collection
{ "data": [...], "next_cursor": "...", "has_more": false }

# Errors: see above
```

Consistency matters more than cleverness. Pick a shape, document it, follow it.

## Documentation

Every public endpoint has:
- path, method, auth requirement
- request body schema
- success response schema (with example)
- listed error codes

OpenAPI / Protobuf schemas are the contract. Hand-written prose docs drift and lie.
