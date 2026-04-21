# Swift — Testing

XCTest and Swift Testing (Swift 6+). For TDD, see `coding-standards/references/tdd.md`.

## Runner choice

- **XCTest** — mature, ships with Xcode, required for UI tests.
- **Swift Testing** — Swift 6 stdlib, cleaner API, macros for parametrized tests. Use for new unit tests when your toolchain supports it.

Both can coexist in the same target.

## XCTest

```swift
import XCTest
@testable import MyApp

final class UserServiceTests: XCTestCase {
    func test_createUser_returnsPersistedUser() async throws {
        let service = UserService(repo: InMemoryUserRepo())
        let user = try await service.create(email: "a@x.com")
        XCTAssertEqual(user.email, "a@x.com")
        XCTAssertFalse(user.id.isEmpty)
    }

    func test_createUser_rejectsEmptyEmail() async {
        let service = UserService(repo: InMemoryUserRepo())
        do {
            _ = try await service.create(email: "")
            XCTFail("expected ValidationError")
        } catch is ValidationError {
            // expected
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }
}
```

Name tests `test_behaviour_expectation`. Structure: **Arrange → Act → Assert**.

## Swift Testing (Swift 6+)

```swift
import Testing
@testable import MyApp

struct UserServiceTests {
    @Test
    func createUserReturnsPersistedUser() async throws {
        let service = UserService(repo: InMemoryUserRepo())
        let user = try await service.create(email: "a@x.com")
        #expect(user.email == "a@x.com")
        #expect(!user.id.isEmpty)
    }

    @Test
    func createUserRejectsEmptyEmail() async throws {
        let service = UserService(repo: InMemoryUserRepo())
        await #expect(throws: ValidationError.self) {
            try await service.create(email: "")
        }
    }
}
```

Cleaner: `#expect(...)` macro, `@Test` annotation, real async support.

## Parametrized tests

```swift
@Test("add cases", arguments: [
    (1, 2, 3),
    (0, 0, 0),
    (-1, 1, 0),
])
func add(a: Int, b: Int, expected: Int) {
    #expect(MyApp.add(a, b) == expected)
}
```

XCTest equivalent requires manual loops or `XCTestCase` subclasses.

## Assertions

| XCTest | Swift Testing |
|---|---|
| `XCTAssertEqual(a, b)` | `#expect(a == b)` |
| `XCTAssertTrue(x)` | `#expect(x)` |
| `XCTAssertNil(x)` | `#expect(x == nil)` |
| `XCTAssertThrowsError { ... }` | `#expect(throws: ...) { ... }` |
| `XCTFail("msg")` | `Issue.record("msg")` |

## Fakes over mocks

Hand-roll fakes; Swift's strong type system makes them cheap.

```swift
final class InMemoryUserRepo: UserRepositoryProtocol {
    private var users: [String: User] = [:]
    func find(id: String) async -> User? { users[id] }
    func save(_ u: User) async { users[u.id] = u }
}
```

For mock libraries, `Cuckoo` and `Mockable` exist; most teams find hand-rolled cheaper in Swift than in JVM.

## Async tests

Swift Testing supports `async` natively. XCTest also, from iOS 13+ / macOS 10.15+:

```swift
func test_loads() async throws {
    let user = try await service.load(id: "u1")
    XCTAssertEqual(user.id, "u1")
}
```

For code using completion callbacks (legacy), use `XCTestExpectation`:

```swift
func test_legacy() {
    let exp = expectation(description: "callback")
    legacy { result in
        XCTAssertNotNil(result)
        exp.fulfill()
    }
    wait(for: [exp], timeout: 5)
}
```

New code shouldn't need this — bridge to `async` with `withCheckedContinuation`.

## Timing / clock control

Mock time with a `Clock` protocol:

```swift
protocol Clock { func now() -> Date }

final class FixedClock: Clock {
    var time: Date
    init(_ t: Date) { self.time = t }
    func now() -> Date { time }
}
```

For `Task.sleep` in tests, use `ContinuousClock` with a manually advanced test clock (Swift Testing / swift-async-algorithms).

Swift Testing integrates with the new `Clock` primitives and supports virtual time.

## UI tests — XCUITest

```swift
final class AppUITests: XCTestCase {
    func test_login_success() {
        let app = XCUIApplication()
        app.launch()
        app.textFields["email"].tap()
        app.textFields["email"].typeText("a@x.com")
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.staticTexts["Welcome"].waitForExistence(timeout: 5))
    }
}
```

Rules:
- Use `accessibilityIdentifier`, not labels — labels break when copy changes.
- Reset app state in `setUp`; UI tests are order-dependent if you don't.
- Keep to happy paths and critical flows; they're slow and brittle.

## Snapshot tests

`swift-snapshot-testing` (`point-free`) for views, JSON, formatted strings.

```swift
import SnapshotTesting
import XCTest

final class UserViewTests: XCTestCase {
    func test_userView() {
        let vc = UserViewController(user: .sample)
        assertSnapshot(matching: vc, as: .image)
    }
}
```

Review diffs deliberately; don't mass-accept.

## Coverage

Xcode can emit `.xcresult` with coverage; `xcrun xccov view --report` for CLI. Set a threshold in your `fastlane` / CI.

## Performance tests

```swift
func test_perf_parsing() {
    measure {
        _ = parse(sampleInput)
    }
}
```

Xcode stores baselines; regressions highlight on re-run. Keep perf tests to critical paths; they're slow and machine-dependent.

## Test plans

Use Xcode test plans to split fast unit tests, slower integration, UI tests into separate CI stages:

```
UnitTests.xctestplan           # fast, ~seconds
IntegrationTests.xctestplan    # real deps, minutes
UITests.xctestplan             # UI, slow
```

Run unit on every PR; integration and UI on merge-to-main.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `Thread.sleep` / `sleep()` in tests to wait for async | `XCTestExpectation` or `async/await` |
| `try!` inside a test | Use `try` + `XCTAssertNoThrow` or Swift Testing `#expect(throws:)` |
| Shared state across tests via singletons | Reset in `setUp`; prefer DI |
| Snapshot test accepted without review | Always diff before committing |
| UI tests finding by label (`"Log in"`) | Use `accessibilityIdentifier` |
| Mocking the thing you're testing | Test via real public API |
| `XCTFail` + guard + `return` scattered inline | Use Swift Testing `#expect(throws:)` or helper methods |
| Tests depending on device locale / time | Inject locale / clock |
