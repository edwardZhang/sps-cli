# Mobile — Platform

Permissions, notifications, background tasks, biometrics, secure storage.

## Permissions

Request at the moment of need, not upfront.

```
User taps "Add photo" → now request camera / library permission.
```

Flow:
1. Check current status.
2. If not determined: show an in-app primer ("to attach photos we need access to…"), then prompt.
3. If denied: show clear "open Settings" guidance; don't re-prompt (iOS won't show the sheet again anyway).

Never:
- Ask for all permissions on first launch.
- Block the app on denied permissions (degrade gracefully).
- Auto-grant — users must choose.

Required: `NSUsageDescription` (iOS) / permission declarations (Android) with accurate copy. App stores reject vague ones.

## Sensitive permissions

| Permission | Treat as |
|---|---|
| Location (especially background) | Justify prominently, explain precisely how it's used |
| Camera / microphone | Visible indicator while active (OS usually does this) |
| Contacts / Photos / Calendar | Scoped access preferred (iOS 14+, Android 13+) |
| Notifications (iOS) | Explicit opt-in; user deciding = one chance on iOS |
| Accessibility services (Android) | High review bar; stores scrutinize |

## Notifications

### Local

For time / event reminders the device can schedule.

```
schedule(id, triggerDate, contentTitle, contentBody)
```

Rules:
- Idempotent id — rescheduling replaces.
- Cancel stale notifications on state change (task done → remove reminder).
- Respect quiet hours / Focus / DND.

### Push

Server-driven. Flow:
1. App requests token (APNs on iOS, FCM on Android).
2. Token sent to server, associated with user.
3. Server delivers payloads via APNs / FCM.

Content types:
- **Alert / default** — visible to user.
- **Silent / data-only** — wakes app to sync; no UI. Limited budget; iOS throttles.

Handle:
- Token rotation (OS may refresh; always sync to server).
- Logout: unregister token.
- Quiet / opt-out preferences server-side.

## Background tasks

Apps don't run in the background forever. Platforms give scheduled, constrained windows.

- **iOS**: `BGAppRefreshTask`, `BGProcessingTask` via `BGTaskScheduler`. Short windows, system-decided.
- **Android**: `WorkManager` — one API, handles Doze / idle batching. Avoid `AlarmManager` for modern apps.
- **Cross-platform**: framework wrappers around the above.

Rules:
- Keep work short and idempotent.
- Don't assume a window will run at a specific time.
- Don't rely on background work for correctness — network may be off.

## Biometrics

```
if canAuth(.biometrics):
    await authenticate(reason: "Unlock your vault")
else:
    await authenticate(.passcode)    // fallback
```

- iOS: `LocalAuthentication` / `LAContext`.
- Android: `BiometricPrompt`.

Never store actual biometric data. Use it to gate access to a key in Keychain / Keystore.

## Secure storage

| Need | Store |
|---|---|
| API tokens, refresh tokens | Keychain (iOS) / EncryptedSharedPreferences / DataStore with a master key (Android) |
| Encryption keys | Keychain / Keystore, hardware-backed where available |
| User preferences (non-sensitive) | UserDefaults / DataStore |
| Caches | App sandbox directory; wipe on logout |

Never:
- Tokens in `UserDefaults` / `SharedPreferences`.
- Plain-text credentials anywhere.
- Logging full tokens (even at DEBUG).

## Network security

- HTTPS with modern TLS (1.2 minimum, 1.3 preferred).
- **ATS** on iOS — use default settings; exceptions require justification.
- **Network Security Config** on Android — restrict cleartext.
- **Certificate pinning** for high-value endpoints. Pin the intermediate or leaf; plan the rotation.

## App Transport / Deep Link security

- Validate deep-link parameters; treat them as user input.
- Never execute code based on query string (e.g., "open this URL in WebView" without allow-list).
- For login-via-deep-link, verify signature; intermediaries may tamper.

## Web views

Minimize them. When unavoidable:
- Use `WKWebView` (iOS) / `WebView` with hardened settings (Android).
- Disable `allowFileAccess`, `javascriptEnabled` unless required.
- Never inject tokens into URLs loaded in web views.

For OAuth / in-app browser tabs (SFSafariViewController / Chrome Custom Tabs) — safer than a generic WebView because cookies and saved passwords work.

## Hardware surveys

When using camera / sensors / Bluetooth:
- Check availability (`AVCaptureDevice`, hardware feature on Android).
- Fail gracefully on missing hardware.
- Release resources on background / pause.
- Don't leave LEDs on or Bluetooth scanning when the feature is closed.

## Accessibility at the platform level

- iOS: VoiceOver, Dynamic Type, Reduce Motion, Bold Text, Smart Invert.
- Android: TalkBack, font scale, color correction, reduce animations.

Use the platform's semantic accessibility APIs, not custom text-to-speech.

Test at 200% font scale. Layout should expand gracefully, not truncate.

## Crash reporting

- Firebase Crashlytics, Sentry, BugSnag, custom — pick one.
- Capture: stack trace, device, OS version, app version, user id (hashed or opt-in).
- Log breadcrumbs — screen views, key user actions — to reconstruct what happened.
- De-symbolicate iOS crashes with dSYMs uploaded in CI. Android: ProGuard mapping files.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Requesting all permissions upfront | Ask at point of need |
| Tokens in UserDefaults / SharedPreferences | Keychain / Keystore |
| Background location without clear benefit | Foreground only |
| Polling in the background for "real-time" | Push notifications / WebSockets (when foreground) |
| Running as foreground service to bypass Doze | Violates Play Store policy |
| Opening external URLs in an in-app WebView with cookies | Use in-app browser tab |
| Using the older / deprecated `AlarmManager` for everything | WorkManager on modern Android |
| Stripping ATS / NSC to "make it easier" | Fix the server; don't open cleartext in prod |
| Hard-coded production API keys | Environment-specific config; rotate on leak |
| Silent push used for analytics (abuses the privilege) | Real notification or in-app event |
