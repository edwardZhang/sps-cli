# Kotlin — Testing

JUnit 5, Kotest, MockK, turbine for Flow. For TDD, see `coding-standards/references/tdd.md`.

## Runner choice — JUnit 5 is the default

Fine for most projects. Kotest is a Kotlin-first alternative with extra styles (BehaviorSpec, FunSpec) — pick one per project and be consistent.

```kotlin
// JUnit 5
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals

class UserServiceTest {
    @Test
    fun `creates user with generated id`() {
        val svc = UserService(InMemoryUserRepo())
        val u = svc.create("a@x.com")
        assertEquals("a@x.com", u.email)
    }
}
```

Backtick-quoted function names are standard Kotlin test style — they read as behaviour statements.

## Assertions

- `kotlin.test.*` for cross-platform (`assertEquals`, `assertTrue`, `assertFailsWith`).
- `AssertJ` (Java) for rich fluent asserts.
- `Kotest assertions` (`shouldBe`, `shouldHaveSize`) if you've adopted Kotest.

```kotlin
// kotlin.test
assertEquals(5, add(2, 3))
assertFailsWith<ValidationError> { validate(bad) }

// AssertJ
assertThat(users).hasSize(3).extracting("email").contains("a@x.com")

// Kotest
user.name shouldBe "A"
users shouldHaveSize 3
```

Pick one assertion library per project. Mixing creates friction.

## Parameterized tests

```kotlin
@ParameterizedTest
@CsvSource("1,2,3", "0,0,0", "-1,1,0")
fun `add`(a: Int, b: Int, expected: Int) {
    assertEquals(expected, add(a, b))
}

@ParameterizedTest
@MethodSource("cases")
fun `login cases`(c: LoginCase) { ... }

companion object {
    @JvmStatic
    fun cases() = listOf(
        LoginCase("a@x.com", "pw", true),
        LoginCase("", "pw", false),
    )
}
```

Kotest syntax is lighter:
```kotlin
"add" - {
    withData(
        nameFn = { "${it.a} + ${it.b}" },
        Triple(1, 2, 3), Triple(0, 0, 0)
    ) { (a, b, want) -> add(a, b) shouldBe want }
}
```

## Mocking — MockK

MockK is Kotlin-idiomatic (final classes work out of the box; Mockito needs extra config).

```kotlin
import io.mockk.*

val repo = mockk<UserRepository>()
every { repo.find("u1") } returns User("u1", "a@x.com")
every { repo.find(not("u1")) } returns null

val svc = UserService(repo)
assertEquals("a@x.com", svc.getEmail("u1"))

verify(exactly = 1) { repo.find("u1") }
```

Coroutine mocks:
```kotlin
val svc = mockk<UserService>()
coEvery { svc.fetch("u1") } returns User("u1", "a@x.com")
coVerify { svc.fetch("u1") }
```

`relaxed = true` makes all unconfigured calls return defaults. Use sparingly — silent defaults mask bugs.

## Prefer fakes over mocks

```kotlin
class InMemoryUserRepo : UserRepository {
    private val users = mutableMapOf<String, User>()
    override fun find(id: String) = users[id]
    override fun save(u: User) { users[u.id] = u }
}
```

Reuse across tests; reset in `@BeforeEach`. More code up front; much less friction when the interface grows.

## Coroutine tests — `runTest`

```kotlin
import kotlinx.coroutines.test.runTest

@Test
fun fetches() = runTest {
    val svc = UserService(fakeRepo)
    val u = svc.fetchUser("u1")             // no real delay
    assertEquals("u1", u.id)
}
```

`runTest` virtualizes time. `delay(1.hours)` completes instantly. `advanceTimeBy(...)` controls the scheduler.

## `Flow` tests — turbine

```kotlin
import app.cash.turbine.test

@Test
fun `flow emits expected values`() = runTest {
    viewModel.state.test {
        assertEquals(State.Loading, awaitItem())
        viewModel.load()
        assertEquals(State.Success(user), awaitItem())
        cancelAndIgnoreRemainingEvents()
    }
}
```

Don't test Flows by collecting into a list in an uncontrolled scope — tests become flaky.

## Integration tests

- **JVM backend**: real DB via Testcontainers; real HTTP via Ktor client or `MockWebServer`.
- **Android**: instrumented tests (`androidx.test`), or local-JVM Robolectric for fast feedback.

```kotlin
@Test
fun `loads user from real db`() = runTest {
    Testcontainers.start("postgres:16")
    val repo = JdbcUserRepository(dataSource)
    repo.save(User("u1", "a@x.com"))
    assertEquals("a@x.com", repo.find("u1")?.email)
}
```

Keep integration tests in a separate source set (`src/integrationTest/`) with its own Gradle task — `./gradlew integrationTest`.

## Android UI tests

- **Jetpack Compose**: `createComposeRule()`, `onNodeWithText(...).performClick()`.
- **Views**: Espresso.

```kotlin
@get:Rule
val compose = createComposeRule()

@Test
fun `shows user name`() {
    compose.setContent { UserCard(user = sampleUser) }
    compose.onNodeWithText("Alice").assertIsDisplayed()
}
```

## Code coverage

JaCoCo for JVM / Android. See `coding-standards/references/tdd.md` for target numbers.

```kotlin
// build.gradle.kts
plugins { jacoco }
tasks.test { finalizedBy(tasks.jacocoTestReport) }
```

## Property tests — Kotest property API

```kotlin
import io.kotest.property.*
import io.kotest.property.arbitrary.*

"sort is idempotent" - {
    checkAll(Arb.list(Arb.int())) { xs ->
        xs.sorted() shouldBe xs.sorted().sorted()
    }
}
```

Great for parsers, serializers, invariants.

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `Thread.sleep` in coroutine tests | `delay` + `runTest` |
| `runBlocking` in tests of suspend functions | `runTest` virtualizes time |
| Over-mocking (10 mocks for 20 LOC) | Use a fake |
| `verify { ... }` counts that duplicate the mock setup | Assert observable behaviour instead |
| Snapshot tests for flaky output (time, UUID) | Inject fakes / fixed values |
| Tests that depend on coroutine ordering | Use `runTest` scheduler primitives, not real threads |
| Real network in unit tests | Fake the HTTP client or use `MockWebServer` |
| Test name like `test1`, `test2` | Describe behaviour: \`\`add combines positives\`\` |
