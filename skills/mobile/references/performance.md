# Mobile — Performance

Startup, frame rate, memory, battery, app size.

## Measure first

- **iOS**: Xcode Instruments — Time Profiler, Allocations, Energy Log, App Launch template.
- **Android**: Android Studio Profiler, Macrobenchmark, Perfetto, Battery Historian.
- **Cross-platform**: framework-specific profilers (React Native Flipper, Flutter DevTools).

No optimization without a profile. Anecdotes lie; flame graphs don't.

## Startup

Cold start = process launch → first meaningful screen. Budget:
- iOS: < 400 ms to first frame (Apple's guideline).
- Android: < 5 s for cold start acceptable; < 2 s is good.

Common startup killers:
- Synchronous work in `Application` / `AppDelegate` init (SDK init, network pings).
- Excessive DI graph construction at cold start.
- Loading a huge JSON on the main thread.
- First screen fetching data sequentially.

Strategy:
1. **Do nothing on launch** that isn't required to render the first screen.
2. **Defer SDK init** (analytics, crash reporter) using platform idle callbacks.
3. **Show a real UI fast** — skeleton, cached content, progressive hydration.
4. **Parallelize first-screen data fetches.**

## Frame rate — 60 fps / 120 fps

16.67 ms per frame at 60 Hz; 8.33 ms at 120 Hz. A frame budget missed = visible jank.

- **Never block the UI thread** with disk, network, JSON parsing, or big computations.
- **Measure jank** with the platform tool (Choreographer on Android, Core Animation FPS on iOS).
- **Move work off-main**:
  - Android: coroutines on `Dispatchers.Default` / `IO`; Compose's `LaunchedEffect`.
  - iOS: `Task.detached(priority: .utility)` / async functions.
  - Cross-platform: web workers, Dart isolates.

## Lists — virtualize

Any list with > ~50 items should virtualize (render only what's visible).

- **iOS**: `UITableView` / `UICollectionView` already do; `LazyVStack` in SwiftUI; avoid mapping huge arrays into `ForEach` inside `ScrollView`.
- **Android**: `RecyclerView` / `LazyColumn` (Compose). Set `contentType` / `key` for recycling.
- **React Native**: `FlatList` / `SectionList` with `keyExtractor` and `getItemLayout`.
- **Flutter**: `ListView.builder` / `SliverList`.

Rules:
- Every row has a stable key.
- `shouldRecompose` / `areItemsTheSame` return correctly.
- Avoid inline lambdas that change identity every render.

## Images

Biggest single memory user in typical apps.

- Use a cached image loader (Coil, Glide, SDWebImage, Kingfisher, FastImage for RN).
- Decode to the display size, not the source size. A 4000 × 3000 photo in a 300-pt avatar is a memory bomb.
- Cache policies: memory (tight), disk (generous, bounded), TTL for dynamic URLs.
- Placeholders + fade-in; avoid layout shift.

## Memory

- Hold what you're rendering. Let the rest evict.
- Bitmap-heavy screens (photo grids, video thumbnails) need aggressive recycling.
- Watch for retain cycles (iOS) / context leaks (Android). A ViewModel holding a View, a Handler with an activity reference — standard leaks.
- Detekt / leak-detection tools: LeakCanary (Android), Instruments Leaks (iOS), profile before release.

## Battery

Users notice battery drain. What costs most:
- **Network chatter** (small requests often > big requests rarely).
- **Wakeups** (alarms, background fetches, location).
- **Sensors** (GPS, accelerometer, BT scan) when used continuously.
- **Bad CPU loops** (unnecessary re-renders, background polling).

Rules:
- Batch network calls where you can.
- Use platform background scheduler (`WorkManager`, `BGTaskScheduler`) — they batch across apps.
- Respect Doze / Low Power Mode signals.
- Don't hold wake locks or background location without a visible reason.

## App size

Each MB costs downloads, installs, abandonment. Rough targets:
- < 50 MB initial download is great.
- Over 100 MB, users on cellular are warned.

Tools:
- Android App Bundle splits by ABI / language / density.
- iOS: App Thinning, on-demand resources.
- Strip debug symbols in release.
- Audit deps — one chart library can add 5 MB of unused code.

## Package size audit

Largest offenders, in order:
1. Unstripped native libraries (x86 + arm + arm64 + armv7).
2. Bundled fonts / images / videos.
3. Heavy SDKs (ads, analytics) that ship more than they use.
4. Translations (if your app ships without user-language stripping).
5. Debug info left in release.

## Launch / anim / transition perf

- Launch screen: show the UI immediately (Asset catalog on iOS, splash theme on Android). Don't build your own splash from a UIKit / Activity — it's slower.
- Transitions: use platform defaults; they're hardware-accelerated. Custom animations often miss frames on low-end devices.
- Prefer `transform` / `opacity` equivalents over layout-triggering properties.

## Network

- HTTP/2 or HTTP/3 → multiplexing reduces handshake cost.
- Response compression (gzip / brotli) on.
- Cache-Control on static assets; ETag for dynamic.
- Retry with backoff on failures.
- Consider **delta** payloads for large lists (send only what changed).

## Ahead-of-time vs JIT

- Android R8 / ProGuard: enable in release. Strips unused code and shrinks bundles.
- iOS: always AOT; no JIT. Focus on link-time optimization (`-Os`, whole-module).
- Cross-platform: Hermes (RN), Flutter AOT — verify you're in release mode.

## Benchmarks in CI

Macrobenchmark (Android) or Instruments via XCTest (iOS) can run critical-flow timing on every merge. Fail builds on regression beyond threshold.

```
@Test
fun startup() = benchmarkRule.measureRepeated(
    packageName = PACKAGE,
    metrics = listOf(StartupTimingMetric()),
) { pressHome(); startActivityAndWait() }
```

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| Loading full profile on every screen | Cache; invalidate on change |
| Images served at 4K for 400 px displays | Server-side resizing or loader |
| Launch SDK initialization chain takes 2 seconds | Defer; init on first use |
| Rendering a grid without virtualization | Use the platform list |
| Polling for notifications every 10 seconds | Push / long-poll |
| JSON parse on main thread for big payloads | Background + stream |
| Keeping full Log / PDF in memory | Stream; flush |
| Shipping debug logs in release | Strip |
| Background location for features that don't need it | Request only when needed |
| Running animations during heavy scroll | Throttle or pause |
