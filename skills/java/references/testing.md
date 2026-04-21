# Java — Testing

JUnit 5, AssertJ, Mockito, Testcontainers. For TDD, see `coding-standards/references/tdd.md`.

## JUnit 5 — the default

```java
import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;

class UserServiceTest {
    private UserService service;

    @BeforeEach
    void setUp() { service = new UserService(new InMemoryUserRepo()); }

    @Test
    @DisplayName("creates a user with a generated id")
    void create_returnsPersistedUser() {
        var u = service.create("A", "a@x.com");
        assertEquals("A", u.name());
        assertNotNull(u.id());
    }

    @Test
    void create_rejectsEmptyEmail() {
        assertThrows(ValidationException.class, () -> service.create("A", ""));
    }
}
```

Use `@DisplayName` for behaviour-focused names that don't fit Java method-name rules.

## AssertJ — fluent assertions

```java
import static org.assertj.core.api.Assertions.*;

assertThat(users)
    .hasSize(3)
    .extracting(User::email)
    .contains("a@x.com")
    .doesNotContain("banned@x.com");

assertThat(user.role()).isEqualTo(Role.ADMIN);

assertThatThrownBy(() -> service.create("A", ""))
    .isInstanceOf(ValidationException.class)
    .hasMessageContaining("email");
```

Much richer than JUnit's built-ins. Most Java codebases use AssertJ or Hamcrest. Pick one per project.

## Mockito — when you need mocks

Fakes > mocks (see `coding-standards` / `typescript`/`python` refs). But Mockito works when a fake is too heavy.

```java
import static org.mockito.Mockito.*;

@Test
void loadsFromRepo() {
    var repo = mock(UserRepository.class);
    when(repo.find("u1")).thenReturn(Optional.of(new User("u1", "a@x.com")));

    var service = new UserService(repo);
    assertEquals("a@x.com", service.getEmail("u1"));

    verify(repo, times(1)).find("u1");
}
```

`@Mock` + `@InjectMocks` for less boilerplate; enable with `@ExtendWith(MockitoExtension.class)`.

Don't mock types you own — change them instead. Mock boundaries (HTTP clients, clocks, external APIs).

## Parametrized tests

```java
@ParameterizedTest
@CsvSource({
    "1, 2, 3",
    "0, 0, 0",
    "-1, 1, 0",
})
void add(int a, int b, int expected) {
    assertEquals(expected, Math.addExact(a, b));
}

@ParameterizedTest
@EnumSource(Role.class)
void allRolesHaveLabel(Role r) {
    assertNotNull(r.label());
}

@ParameterizedTest
@MethodSource("loginCases")
void login(LoginCase c) { ... }
static Stream<LoginCase> loginCases() { ... }
```

## Lifecycle annotations

| Annotation | Runs |
|---|---|
| `@BeforeEach` | Before each `@Test` |
| `@AfterEach` | After each `@Test` |
| `@BeforeAll` | Once before any test (static) |
| `@AfterAll` | Once after all tests (static) |
| `@Nested` class | Group related tests, fresh fixtures |

`@TestInstance(Lifecycle.PER_CLASS)` if you want non-static `@BeforeAll` or shared state.

## `@Nested` for readability

```java
@Nested
@DisplayName("when user is banned")
class WhenBanned {
    @BeforeEach void setUp() { user = userWithStatus(BANNED); }

    @Test void cannotLogin() { ... }
    @Test void cannotPost()  { ... }
}
```

Reads as a spec. Tests stay organized without helper functions exploding the file.

## Integration tests — Testcontainers

Real dependencies, Docker-driven, ephemeral.

```java
@Testcontainers
class UserRepoIT {
    @Container
    static final PostgreSQLContainer<?> PG =
        new PostgreSQLContainer<>("postgres:16-alpine");

    @Test
    void savesAndLoads() throws Exception {
        var ds = dataSource(PG.getJdbcUrl(), PG.getUsername(), PG.getPassword());
        var repo = new JdbcUserRepository(ds);
        repo.save(new User("u1", "a@x.com"));
        assertThat(repo.find("u1")).isPresent();
    }
}
```

Split integration tests (`*IT.java`) from unit tests (`*Test.java`) in the build so you don't run them every time.

## Spring Boot tests

Layered:

```java
@WebMvcTest(UserController.class)          // only web layer + @MockBean repo
class UserControllerTest { ... }

@DataJpaTest                                // only JPA + embedded DB
class UserRepoTest { ... }

@SpringBootTest                             // full app context
class UserIntegrationTest { ... }
```

Prefer `@WebMvcTest` / `@DataJpaTest` over `@SpringBootTest` — they load a slice, are much faster.

`@TestContainers` + `@SpringBootTest` for real-DB integration tests on the production stack.

## Async tests

```java
@Test
void futureCompletes() throws Exception {
    var f = asyncService.load(id);
    assertEquals("a@x.com", f.get(5, TimeUnit.SECONDS).email());
}
```

For streams/flows, use Awaitility:

```java
import static org.awaitility.Awaitility.await;

await().atMost(5, SECONDS).until(() -> queue.size() > 0);
```

## Property tests — jqwik

```java
@Property
boolean sortIsIdempotent(@ForAll List<@IntRange(min = -1000, max = 1000) Integer> xs) {
    var sorted = xs.stream().sorted().toList();
    var twice  = sorted.stream().sorted().toList();
    return sorted.equals(twice);
}
```

Niche but valuable for parsers, invariants.

## Coverage

JaCoCo is the default. Set a threshold in Maven / Gradle and fail CI on drop.

```xml
<!-- Maven: jacoco-maven-plugin -->
<rule>
  <element>BUNDLE</element>
  <limits>
    <limit><counter>LINE</counter><minimum>0.80</minimum></limit>
  </limits>
</rule>
```

## Anti-patterns

| Anti-pattern | Fix |
|---|---|
| `Thread.sleep` to wait for async | Awaitility / explicit futures |
| `@Test(expected = ...)` (JUnit 4) | JUnit 5: `assertThrows` |
| Mocking what you don't own without wrapping | Create a wrapper type; mock the wrapper |
| Tests that load full Spring context for a pure-logic test | `@WebMvcTest` / plain JUnit |
| Mockito `any()` for every arg | Assert specific args — catches bugs |
| Mocking final classes without Mockito inline extension | Enable `mockito-inline` or refactor to an interface |
| Shared mutable static state across tests | `@BeforeEach` reset or move state into instance |
| Snapshot / text asserts for time-dependent output | Inject a clock |
| Tests named `test1`, `test2` | Describe behaviour — `create_rejectsEmptyEmail` |
