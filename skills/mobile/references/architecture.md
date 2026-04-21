# Mobile — Architecture

MVVM, MVI, TCA, clean architecture. Platform-neutral.

## The shapes

| Pattern | Idea | Good for |
|---|---|---|
| **MVVM** | View ← binds → ViewModel → Model | SwiftUI, Jetpack Compose, most modern apps |
| **MVI** | View → Intent → Reducer → State → View | Deterministic, testable flows; complex screens |
| **TCA** (iOS) | Redux-like, dependency-injected | Teams that want explicit wiring everywhere |
| **Clean / Onion** | Layers; domain in the middle | Large apps with multiple teams |

Most apps today land on MVVM + unidirectional data flow. MVI is MVVM with explicit state / intent naming. Pick one per project.

## Layering (clean-ish)

```
┌──────────────────────────────────────────┐
│  UI (screens, components)                 │   — platform-specific
├──────────────────────────────────────────┤
│  Presentation (ViewModels / Stores)      │   — state + actions
├──────────────────────────────────────────┤
│  Domain (entities, use cases)             │   — pure, platform-free
├──────────────────────────────────────────┤
│  Data (repositories + sources: API, DB)  │   — infrastructure
└──────────────────────────────────────────┘
```

- **UI** calls into the ViewModel; ViewModel calls into use cases / repos.
- **Domain** has no Android / iOS imports. Shareable across platforms.
- **Data** implements the interfaces the Domain declares.

Like `backend/layering.md`: dependency flows inward. Don't let `Context` / `UIApplication` leak into domain code.

## ViewModel — owner of screen state

```
ViewModel:
    state: observable<ScreenState>

    onIntent(Intent):
        match intent:
            case .load:    state = .loading; launch { fetchUser() }
            case .retry:   state = .loading; launch { fetchUser() }
            case .select(id): navigator.push(Detail(id))
```

Responsibilities:
- Own the screen's state
- Talk to use cases / repos
- Translate user input into state changes
- Survive configuration changes (rotation, dark mode) — framework handles if you use the right scope

NOT responsibilities:
- Drawing pixels
- Navigating directly (use a navigator / router)
- Accessing platform APIs directly (get them via DI)

## Unidirectional data flow

```
  User action ────▶ Intent ────▶ ViewModel ────▶ State
         ▲                                        │
         └────────────────────────────────────────┘
                        View observes
```

- Views are a function of state. Don't mutate state inside views.
- Intents are explicit. Don't let the view call arbitrary business logic.
- State changes are traceable (log the intent) for debugging.

## Dependency injection

Every non-trivial app uses DI. Options vary by platform:

| Platform | Common choices |
|---|---|
| Android | Hilt, Koin, manual constructor injection |
| iOS | Swinject, @Environment, manual |
| Cross-platform (KMP / RN) | Manual / small DI libs |

Prefer constructor injection; simpler, testable.

Anti-pattern: service locator / global accessor. They hide deps and make testing painful.

## Modularization

As the app grows, split by feature (not by layer):

```
app/
├── feature-auth/
│   ├── domain/    presentation/    data/
├── feature-orders/
│   ├── domain/    presentation/    data/
├── feature-profile/
├── shared/
│   ├── ui/        network/        persistence/
└── app-shell/              # wires features together, navigation root
```

Benefits:
- Parallel team work.
- Faster incremental builds.
- Forces clean interfaces between features.

Over-modularization before the app needs it is friction. Start single-module; split when team size or build time hurts.

## Use cases

A use case is one screen's intent: `GetUserProfile`, `PlaceOrder`, `LogOut`.

```
class PlaceOrder(
    val orderRepo: OrderRepository,
    val paymentGateway: PaymentGateway,
    val analytics: Analytics,
) {
    suspend fun invoke(cmd: PlaceOrderCommand): Result<OrderId> {
        val order = Order.create(cmd)                   // domain rule
        orderRepo.save(order)
        paymentGateway.authorize(order.total)
        analytics.track("order_placed", order.id)
        return Result.success(order.id)
    }
}
```

Small, one method, testable. Don't force every screen to go through a use case — if it's just loading data, call the repo from the ViewModel.

## Repository — hides the data sources

```
interface UserRepository {
    suspend fun get(id: String): User                    // hits cache, falls back to API
    suspend fun refresh(id: String): User                // forces network
    fun observe(id: String): Flow<User>                  // reactive stream
}
```

Inside:
- Local store (Room / SwiftData / Realm / SQLite).
- Remote source (HTTP client).
- Reconciliation logic (cache + network).

Consumers don't know or care. That's the point.

## Error surfacing

Domain errors → enum / sealed type that the ViewModel maps to UI state.

```
sealed class OrderError {
    object InsufficientFunds : OrderError()
    object OutOfStock        : OrderError()
    data class Network(val cause: Throwable) : OrderError()
    data class Unknown(val cause: Throwable) : OrderError()
}

state = State.Error(OrderError.InsufficientFunds)
// UI: show a dialog with specific copy + action
```

Never show a raw exception message to the user. Map to something actionable.

## Coroutine / async scoping

- Android: `viewModelScope`, `lifecycleScope`.
- iOS Swift: `Task`, tied to view lifecycle or `@StateObject`.
- React Native: effects tied to component lifecycle; clean up on unmount.
- Flutter: `dispose()` on `StatefulWidget`; `Stream` subscriptions cancelled.

Don't start work that outlives the scope. Leaked background tasks cause crashes, stale state, wasted battery.

## Feature flags

Every mobile release is "all or nothing" for some hours. Feature flags let you ship code dark and flip when ready.

- Client flag service (LaunchDarkly, ConfigCat, home-grown).
- Defaults that are safe if the service is unreachable (offline start).
- Short-lived; clean up flags once fully rolled out.

## Telemetry hooks

- App open, session start/end
- Screen viewed (one event per meaningful screen; don't inflate)
- Intent triggered (for key flows — signup, checkout)
- Error happened (with anonymous context; never PII)

Ship to a pipeline (Firebase Analytics, Segment, MixPanel, self-hosted) with a schema you control.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Business logic in view files | Move to ViewModel / use case |
| ViewModel holds a `Context` / `UIViewController` reference | Leaks UI into presentation; refactor |
| Singleton "service" with mutable business data | DI via constructor; scope to a request or screen |
| Navigation logic scattered across screens | Navigator / router at app level |
| Each screen fetches `/me` on start | Cache; fetch once, invalidate on logout / update |
| Data layer throws raw SQL exceptions to the UI | Repository maps to domain errors |
| Feature modules depending on each other arbitrarily | Feature modules depend on `shared/`; never on siblings |
| "Reactive Everywhere" — observable every primitive | Use streams for state that changes; keep static state static |
