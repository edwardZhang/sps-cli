# Mobile — State & Data

Local store, sync, offline-first, optimistic updates, reactive streams.

## Offline-first

Network is the slow, unreliable layer. Design the app so the local store is the fast path; the network syncs in the background.

```
UI ──reads──▶ Local Store ◀──writes sync── API
      ──writes──▶ Local Store + Outbox ──drain──▶ API
```

Benefits:
- Cold start without network → user still sees cached content.
- Actions feel instant (optimistic + outbox).
- Seamless reconnection; app doesn't die on Wi-Fi flip.

## Local storage choices

| Store | Platform / Cross | Shape |
|---|---|---|
| SQLite (direct) | All | Relational, battle-tested |
| Room | Android | SQLite ORM; compile-time query checking |
| Core Data / SwiftData | iOS | Object graph |
| Realm | Cross | Object DB, live objects |
| SQLDelight | KMP / cross | SQL-first, multiplatform |
| MMKV / DataStore | Key-value | Simple prefs, fast, typed |
| Keychain / Keystore | All | Secrets |

Rule: one primary store per domain. Mixing Room + Realm + a JSON cache for the same data creates reconciliation hell.

## Cache + network reconcile

### Stale-while-revalidate

Return cached data immediately; refresh in the background.

```
suspend fun getUser(id: String): Flow<User> = flow {
    emit(cache.get(id))                       // instant
    try {
        val fresh = api.getUser(id)
        cache.put(id, fresh)
        emit(fresh)                            // update UI
    } catch (_: IOException) {
        // offline; keep showing cached
    }
}
```

### Freshness policy

Some data is OK to show even if hours old (product catalog); some must be current (bank balance). Per-type policy:

```
policy[User]        = staleAfter(5.minutes)
policy[ProductList] = staleAfter(24.hours)
policy[Balance]     = alwaysRefresh
```

## Optimistic updates + outbox

For user-driven writes, show the expected result immediately; queue the server call; reconcile.

```
place_order(order):
    local.insert(order.copy(status=PENDING))
    outbox.enqueue(PostOrder(order.id))
    return order.id                             # UI navigates away instantly
```

The outbox worker:
1. Reads next job.
2. Calls the server (with retry + backoff).
3. On success: update local row (`status=CONFIRMED`), remove job.
4. On permanent failure: mark local row (`status=FAILED`), notify user, drop job.

Conflict strategy when the server returns a different truth (e.g., order replaced due to out-of-stock): domain decides — replace, merge, prompt user.

## Queue vs. sync protocol

Simple apps: an outbox table with next-id, retry count, last-error. Good enough.

Complex sync (collaborative editing, multi-device): use a sync framework (CRDTs, Yjs, Automerge, Firebase, CouchDB). Implementing one by hand is a trap.

## Reactive streams everywhere

Mobile UIs love reactivity because the underlying data changes often.

| Tech | Stream type |
|---|---|
| Kotlin | `Flow`, `StateFlow`, `SharedFlow` |
| Swift (Apple) | `Publisher` (Combine), `AsyncStream`, `Observable` |
| RxJava / RxSwift | `Observable`, `Flowable` |
| React Native | Hooks + state libs |

Your repository exposes a stream. The ViewModel transforms. The view collects.

```
// Kotlin
val user: StateFlow<User?> = userRepo.observe(id)
    .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), null)
```

`WhileSubscribed(5_000)`: keeps the upstream alive 5s after the last subscriber — survives rotation without a cold re-fetch.

## Pagination

Two patterns:

### Offset / page

Simple but breaks when rows are inserted during paging. OK for static lists.

### Cursor / keyset

Opaque cursor that points to the last-seen item. Stable across inserts.

```
interface OrderApi {
    suspend fun list(cursor: String?, limit: Int): Page<Order>
}

data class Page<T>(val data: List<T>, val nextCursor: String?)
```

Platform paging libs (Jetpack Paging, TCA Pagination) handle prefetch, retry, error states. Use them; rolling your own is a maintenance burden.

## Forms & input

- **Draft persistence**: save form input to local store keyed by form id. Survive process death.
- **Validation**: same schema on client and server (share via contract or mirror carefully).
- **Submit**: optimistic + outbox if idempotent; otherwise show submitting state.

## Images

The single biggest memory user and jank source in mobile.

- Use the platform image loader (Coil / Glide on Android, SDWebImage / Kingfisher on iOS).
- Resize to the display size **on the server** (API returns `url?w=400`) or via the loader.
- Cache aggressively; size the cache (e.g. 100 MB disk, 50 MB memory).
- Placeholders + cross-fade; never show a flash of broken image.

## Real-time updates

- **Polling**: simple, works offline, battery-expensive. OK for low-urgency data.
- **WebSockets / SSE**: real-time, drains battery if poorly scoped. Tear down in background.
- **Push notifications**: for out-of-app updates. Use silent push to wake and sync.

Rule: subscribe only when the user is looking. Unsubscribe on background / detached views.

## Data security

See `security.md` for the big picture. Quick must-dos:

- Tokens / secrets → Keychain (iOS) or EncryptedSharedPreferences / Keystore (Android).
- Never log full tokens.
- HTTPS only. Pin certificates for critical endpoints where your threat model warrants.
- Wipe sensitive caches on logout.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Fetching on every screen entry | Cache + observe; fetch only when stale |
| Syncing all data up-front on login | Lazy load; fetch on demand |
| Outbox without retry / backoff | Loop; drain with exponential backoff |
| Showing "please wait, syncing…" for every write | Optimistic + outbox |
| Global mutable store for server data | Repository + reactive stream |
| Ignoring background / killed state | Persist enough state to resume |
| Unbounded memory caches | Set a size cap with LRU eviction |
| Network-only fallback for offline | Degrade: cached data + "offline" banner |
| Duplicate local schemas (Room + SwiftData with different shapes on same domain) | One domain model; platform stores map to it |
