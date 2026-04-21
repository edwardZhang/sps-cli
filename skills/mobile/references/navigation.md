# Mobile — Navigation

Stack, tabs, modals, deep links, universal / app links.

## Core model

Mobile navigation is a stack (usually multiple, one per tab). The user always has:
- A clear back action (system or in-app).
- An understanding of where they are (title, breadcrumb, tab highlight).
- A way to exit / cancel a flow.

## Stack

```
Root ─▶ List ─▶ Detail ─▶ Edit ─▶ Confirmation
                  ▲
                  └── back returns here, not to List
```

Rules:
- **Keep stacks shallow.** 4+ levels usually means you should bring the user back to a root or use a modal.
- **Clear the stack after destructive flows** (signup complete, logout, delete-account).
- **Don't insert navigation into the middle** (teleports jarring to users).

## Tabs

Top-level categories — don't abuse. Rule of thumb: 3–5 tabs max.

- Each tab has its own stack.
- Switching tabs preserves per-tab state (position in list, scroll).
- Re-selecting the active tab scrolls to top (standard iOS / Android behavior).

## Modals

Use for tasks that are:
- Focused (one clear goal).
- Interruptible (user can cancel).
- Temporary (they don't want to return here later).

```
[ Close ]    Edit profile              [ Save ]
```

Don't use modals for content the user needs to return to. A profile page isn't a modal; editing the profile is.

Bottom sheets / partial modals are modals too. Same rules.

## Deep links

Every route should be addressable by URL.

```
myapp://orders/123
https://example.com/orders/123
```

- **Custom scheme** (`myapp://`) — older; still used for some flows.
- **Universal links (iOS) / App links (Android)** — modern; open the app if installed, fall back to web otherwise. Required for secure flows.

Setup is fiddly:
- iOS: `apple-app-site-association` file, `associatedDomains` entitlement.
- Android: intent filters + Digital Asset Links.

Test with scanner tools (`branch.io` validator, `assetlinks.google.com/tools`).

## Back-stack hydration

When the user lands via a deep link, the back stack should reflect the path they'd have if they navigated manually.

```
Link: /orders/123/items/7

# ❌ back pops out of the app
[ items/7 ]

# ✅ back goes to the logical parent
[ root ] ─▶ [ orders ] ─▶ [ order 123 ] ─▶ [ item 7 ]
```

Build the stack when resolving the link; don't leave the user stuck.

## Navigation state is your state

Declarative navigation (Compose Navigation, SwiftUI `NavigationStack`, React Navigation) treats the route as a data structure. Restore on cold start by persisting and rehydrating.

```
state = [ Home, Orders, Order(id=123) ]
// on process death, serialize; on cold start, rehydrate
```

Imperative navigation (push/pop calls) is harder to persist. Prefer declarative in new apps.

## Passing data between screens

Options, in order of preference:

1. **Route params** (IDs only). `order/123`. Serializable, deep-linkable.
2. **Shared ViewModel / store**. The source of truth lives in one place.
3. **Nav callbacks** (for single-screen outcomes: "picker returns a country"). Keep narrow.
4. **Serialized object in the route** — last resort; breaks if the model changes.

Don't pass live objects / closures across screens; the framework can't restore them after process death.

## Tabs + deep links

Deep link lands on a tab and a stack within that tab:

```
/profile/settings    ─▶  tab=Profile, stack=[Profile, Settings]
/cart                ─▶  tab=Cart, stack=[Cart]
```

Set the tab, then restore the stack, in one atomic transition.

## Transitions

- **Native** where available (push / pop, modal present). Users recognize the motion.
- **Custom** only for brand moments. Custom transitions are slow to build and often feel off on other devices.
- Respect `prefers-reduced-motion` — reduce or skip animations.

## Bottom navigation vs. side drawer

- **Bottom nav** (mobile-native, iOS tabs / Android BottomNavigationView): 3–5 top-level items, always visible.
- **Side drawer** (hamburger): de-emphasized items, usable with one hand awkward, often hurts discoverability.

Bottom nav by default. Drawer for overflow or very large navigation sets.

## Back button (Android) and gestures

- **Android hardware/system back**: must work everywhere. Never block.
- **iOS swipe-back**: enabled by default on navigation stacks; don't disable without reason.
- **Android predictive back** (13+): opt in via `BackInvokedCallback` to show a preview.

Handle in-flow back (dismiss modal, close keyboard, confirm-before-exit for unsaved data).

## Sign-out / session expiry

On logout or token revocation:
1. Clear secure storage (tokens, keys, cached user).
2. Wipe in-memory state.
3. Reset navigation to the auth / onboarding root.
4. Cancel any in-flight requests / subscriptions.

Skipping step 3 leaves the user on a logged-in screen with no data — confusing.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Deep link lands on a screen with no back stack | Hydrate the full path |
| Complex data serialized into the URL | Pass an ID; fetch from source |
| 8-tab bottom nav | Consolidate; use "More" or search |
| Modal pushing another modal pushing another | Rethink the flow |
| Blocking system back | Always respond; ask if truly destructive |
| Navigation in `useEffect` during render | Navigate on user action or in route loader |
| Different bottom nav per screen | Confusing; top-level navigation should be stable |
| Losing form state on rotation / background | Persist draft to local store |
| "Back" that goes forward (resets to root) | Match user expectation of "previous" |
