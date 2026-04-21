# Layering

Split the code so business rules don't depend on the framework, the database, or the network. Hexagonal / clean architecture in practical form.

## The four layers

```
┌──────────────────────────────────────────────┐
│  Delivery (HTTP handler, CLI, gRPC, worker)  │  — framework-aware
├──────────────────────────────────────────────┤
│  Application (use cases, orchestration)      │  — framework-ignorant
├──────────────────────────────────────────────┤
│  Domain (entities, value objects, rules)     │  — pure
├──────────────────────────────────────────────┤
│  Infrastructure (DB, cache, HTTP clients)    │  — implements domain ports
└──────────────────────────────────────────────┘
```

Dependency direction: **only inward**. Delivery → Application → Domain. Infrastructure implements interfaces owned by the inner layers.

If your domain imports an HTTP framework, a DB driver, or a cache client, the layering is broken.

## Minimal layer roles

| Layer | Contains | Does NOT contain |
|---|---|---|
| Delivery | Request parsing, auth check, calls a use case, maps result to response | Business rules, DB queries |
| Application | Use case orchestration, transaction boundaries, calls repositories and services | SQL, HTTP, JSON parsing |
| Domain | Entities, value objects, invariants, domain events | I/O, frameworks |
| Infrastructure | Repository impls, HTTP client impls, message queue impls | Business decisions |

## Ports and adapters

The domain declares a **port** (interface). Infrastructure provides an **adapter** (implementation).

```
Domain declares (port):
  interface UserRepository
      findById(id) -> User | null
      save(user) -> void

Infrastructure provides (adapter):
  PostgresUserRepository    implements UserRepository
  InMemoryUserRepository    implements UserRepository  (for tests)
  RedisUserRepository       implements UserRepository  (cache-aside)
```

Rule: the adapter file imports the port. The port file never imports any adapter.

## Use case pattern

A use case is one method, one transaction boundary, one business intent.

```
class CreateOrder:
    deps: OrderRepository, UserRepository, PaymentGateway, EventBus

    execute(cmd: CreateOrderCommand) -> OrderId:
        user = userRepository.findById(cmd.userId)
        if not user:             raise UserNotFound
        if not user.canOrder():  raise UserCannotOrder

        order = Order.create(user, cmd.items)     # domain rules
        paymentRepository.authorize(order)        # infra
        orderRepository.save(order)               # infra
        eventBus.publish(OrderCreated(order.id))  # infra

        return order.id
```

Delivery turns an HTTP request into `CreateOrderCommand`, calls `execute`, turns the result into a response. That's it.

## Repository pattern

Collect the DB operations for one aggregate behind one interface.

```
interface OrderRepository:
    findById(id)      -> Order | null
    findByUser(uid)   -> list[Order]
    save(order)       -> void
    delete(id)        -> void
```

Rules:
- Repositories return **domain objects**, not DB rows.
- Queries that cross aggregates (reporting, analytics) do NOT belong in a repository; put them in a dedicated `Queries` / `ReadModel` interface.
- Avoid growing `findByXAndYAndZ` explosions — those signal you need a query object or a read model.

## Service vs domain vs use case

People confuse these. Rough guide:

| Name | Lives in | Contains |
|---|---|---|
| Entity / Aggregate | Domain | State + invariants + rules that depend ONLY on that state |
| Domain Service | Domain | Rules that span multiple aggregates but are still pure |
| Use Case / Application Service | Application | Orchestration: load, decide, persist, publish |
| Gateway / Client | Infrastructure | Talks to the outside world (HTTP, DB, queue) |

If you have a `FooService` that does both business rules and DB calls, split it.

## Dependency injection, without magic

Pass dependencies in as constructor args. Don't pull them from globals.

```
# Good
CreateOrder(orderRepo, userRepo, paymentGateway, eventBus)

# Bad
class CreateOrder:
    def execute():
        order_repo = Container.get("OrderRepository")   # hidden dep
```

Any framework DI container that ends up manipulating constructor signatures reflectively becomes impossible to reason about. Prefer explicit wiring in a composition root.

## Composition root

One file where everything is wired up.

```
# main / bootstrap
db        = Postgres(config.url)
cache     = Redis(config.redis_url)
eventBus  = Kafka(config.brokers)

userRepo   = PostgresUserRepository(db)
orderRepo  = CachedOrderRepository(
                PostgresOrderRepository(db),
                cache,
             )

createOrder = CreateOrder(orderRepo, userRepo, PaymentStripe(config.key), eventBus)

app.register("POST /orders", lambda req: http_create_order(req, createOrder))
```

All layering choices become visible in this one file.

## Transaction boundary

The use case decides where the transaction starts and ends, not the repository.

```
class TransferMoney:
    execute(cmd):
        with unitOfWork.begin():
            src = accountRepo.findById(cmd.fromId)
            dst = accountRepo.findById(cmd.toId)
            src.withdraw(cmd.amount)
            dst.deposit(cmd.amount)
            accountRepo.save(src)
            accountRepo.save(dst)
        # commit happens here; rollback on exception
```

One transaction per use case, not per repository call. If a use case needs multiple transactions, it's probably two use cases.

## Anti-patterns

| Anti-pattern | Why bad | Fix |
|---|---|---|
| Framework objects (HTTP request/response) inside the domain | Couples domain to HTTP | Parse at delivery, pass plain command |
| Repository returns a DB row | Leaks schema upward | Map to domain object at the edge |
| Controller calls the DB directly | Skips domain rules | Every write goes through a use case |
| ORM entities ARE the domain entities | Can't change storage without rewriting rules | Separate persistence model from domain model |
| Static "Service" class with 40 unrelated methods | No cohesion; everything imports everything | One use case per class |
| Domain event published before persistence succeeds | Consumers act on data that doesn't exist | Publish after commit, or use transactional outbox |

## Don't over-engineer

A 500-line CRUD service doesn't need four layers, a DI container, and a port-adapter diagram. Start simple:

```
# Acceptable for small services
handler -> repository -> db
```

Introduce the extra seams **when you feel the pain**: when tests get hard, when the DB needs replacing, when rules start repeating across endpoints. Layering is a response to complexity, not a prerequisite for it.
