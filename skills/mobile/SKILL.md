---
name: mobile
description: Mobile end skill — architecture, offline-first, state, performance, lifecycle. Platform-neutral (iOS / Android / cross-platform). Pair with a language skill (`swift` / `kotlin` / `typescript`) and `coding-standards`.
origin: original
---

# Mobile

Native and cross-platform mobile app architecture. **Platform-neutral**; load with a language skill for syntax and a framework perspective.

## When to load

- Native iOS (Swift + UIKit / SwiftUI) or Android (Kotlin + Jetpack Compose / Views)
- Cross-platform: React Native, Flutter, Kotlin Multiplatform, .NET MAUI
- Hybrid: Capacitor, Cordova
- Topics: lifecycle, offline, state, navigation, platform APIs, app size, battery

## Core principles

1. **Lifecycle is the tax.** Your app gets suspended, killed, restored — design for it, don't pretend it's a desktop.
2. **Offline is the default.** The network is bad, intermittent, or absent. Degrade gracefully.
3. **Screens are ephemeral; state persists.** Recreate UI from state on re-entry.
4. **One source of truth per piece of data.** Caches reconcile with server truth; UIs reflect the cache.
5. **Trim aggressively.** Every 1 MB costs downloads and disk. Every dep adds attack surface and supply risk.
6. **Respect the user's battery and data.** Background work is a privilege; schedule wisely.
7. **Accessibility is platform-native.** Use TalkBack / VoiceOver primitives, not custom read-aloud.
8. **Test on a low-end device with slow network.** "Works on latest iPhone" is not a release signal.

## How to use references

| Reference | When to load |
|---|---|
| [`references/architecture.md`](references/architecture.md) | MVVM / MVI / TCA / clean architecture, DI, module boundaries |
| [`references/state-and-data.md`](references/state-and-data.md) | Local store, sync, offline-first, optimistic updates, reactive streams |
| [`references/navigation.md`](references/navigation.md) | Stack, tab, modal, deep links, universal links, back-stack |
| [`references/performance.md`](references/performance.md) | Startup, frame rate, memory, battery, app size |
| [`references/platform.md`](references/platform.md) | Permissions, notifications, background tasks, biometrics, crypto / keychain |

## Forbidden patterns (auto-reject)

- Blocking the UI thread (network, disk, JSON parse) in the request path
- Storing secrets / tokens in `UserDefaults` / `SharedPreferences` — use Keychain / Keystore
- `Thread.sleep` / `Thread.sleep(...)` in UI code
- Manual lifecycle handling in modern frameworks (use `ViewModel` / `StateObject` / scoped observers)
- Global mutable singletons for business data
- Hard-coded base URLs in release builds
- Silent swallow of network errors (no indicator, no retry)
- Unbounded in-memory caches (OOM kills)
- Hitting `/me` on every screen (fetch once, cache, invalidate on write)
- "Reload the world" after any change (no delta / optimistic update)
