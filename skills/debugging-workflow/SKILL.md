---
name: debugging-workflow
description: Workflow skill — systematic debugging. Reproduce, isolate, hypothesize, verify. Works for bugs, performance issues, and live incidents.
origin: original
---

# Debugging Workflow

A method, not a ritual. Works for "user says it's broken" bugs, performance regressions, and live incidents.

## When to load

- Something is broken and you don't yet know why
- A test started failing and you don't know which change broke it
- A performance regression appeared
- You're on-call and an alert fired
- Reviewing someone's debug session to teach or coach

## The posture

1. **Change one variable at a time.** If you flip three things and it works, you don't know which one fixed it.
2. **Reproduce first, diagnose second, fix third.** Fixing without reproducing is guessing.
3. **Trust the data over the story.** Bug reports are leads, not proofs.
4. **Read the error, all of it.** Stack trace, message, timestamp, request id.
5. **When stuck, lower the abstraction.** Go one layer down until the mechanism is visible.
6. **Stop when stumped. Sleep. Reset.** Fresh eyes find bugs that tired eyes write bugs for.

## The flow

```
  Reproduce ──▶ Isolate ──▶ Hypothesize ──▶ Test ──▶ Fix ──▶ Verify
      ▲                                       │
      └──────────── disconfirm? back up ──────┘
```

### 1. Reproduce

You cannot debug what you can't reproduce. Turn the bug into a command.

- From a user report: collect the steps, the exact time, the user id, the device.
- From logs / metrics: narrow to the failing request or batch; get a request id.
- From a test: `cargo test --test my_test`, `pytest -k my_test`.

Goal: the smallest reproducible case. A 20-step manual reproduction is a lead; a 3-line test is evidence.

If you cannot reproduce:
- Add logging around the suspected area, ship a canary, wait for recurrence.
- Check if it's environment-specific (timezone, locale, OS, version).
- Check if it's data-specific (a particular record triggers it).
- Consider whether the bug is the bug report (user confused, different issue).

### 2. Isolate

Shrink the reproduction. Remove pieces one at a time. The last piece you remove is the bug's home.

Techniques:
- **Binary search** the codebase: comment out half; reproduce; comment out the remaining half; repeat. `git bisect` if the bug is recent.
- **Minimize the input**: shorter string, fewer rows, simpler config.
- **Swap in fakes**: if the bug reproduces with a fake DB, the bug isn't in the real DB.

### 3. Hypothesize

State, out loud or in writing, what you think is happening. One sentence.

> "When the cart is empty, checkout is calling `items[0]` and crashing."

A good hypothesis:
- Is specific (names a function, a condition).
- Is disprovable (there's an experiment that would show it's wrong).
- Explains the observed symptom AND the variations you've seen.

### 4. Test the hypothesis

Design the test that would disprove it.

- Add a print/log at the suspected line.
- Run with the minimal reproduction.
- Observe: does reality match the hypothesis?

If yes → proceed to fix.
If no → the hypothesis is wrong. Go back to step 3.

Don't let a wrong hypothesis linger. "It almost fits" is how debug sessions become five-hour goose chases.

### 5. Fix

Smallest correct change that fixes the bug and doesn't break other things.

- Add a test that would have caught this.
- Make the test fail.
- Apply the fix.
- Test passes.
- Other tests still pass.

Commit fix + test together.

### 6. Verify

- Run the test.
- Run the minimal reproduction.
- Run the original user scenario (if different).
- For production bugs: deploy to staging and verify there before prod.

Don't close the ticket until you've verified on the system where the bug was reported.

## Tools by abstraction level

When the bug hides, drop a layer.

| Level | Tools |
|---|---|
| **Logs** | grep, structured-log viewer, APM log search |
| **Metrics / dashboards** | Grafana, Datadog, CloudWatch |
| **Traces** | Jaeger, Tempo, DD APM |
| **Debugger** | `pdb`, IDE debuggers, `dlv`, `lldb` |
| **Profiler** | `pprof`, py-spy, perf, Instruments |
| **Network** | `tcpdump`, Wireshark, browser DevTools Network, `curl -v` |
| **System calls** | `strace` (Linux), `dtruss` (macOS) |
| **Kernel / hardware** | `perf`, eBPF, `iostat`, `top` |

You usually won't go below "traces". When you do, the bug was worth the depth.

## The log reading discipline

Read the entire trace, not just the top line.

```
ValidationError: email required
  at validate (validate.py:23)
  at create (service.py:41)
  at handler (app.py:15)      ← where the request started
```

- **Top**: the immediate cause.
- **Middle**: the path that got there.
- **Bottom**: the entry point.

For multi-service requests, trace by **request id** across services. If you can't — fix that first.

## Debugging performance

Different but structurally similar:

1. **Measure**. Don't optimize without a number. `ab`, `k6`, `wrk` for throughput; APM for p95/p99.
2. **Profile**. Flame graph reveals the hot function. Guessing reveals nothing.
3. **Hypothesize the bottleneck**. "The SQL is slow" vs. "JSON serialization is slow" vs. "We're blocking on the main thread."
4. **Test with EXPLAIN / flame graph / profiler output**.
5. **Fix the highest-yield bottleneck**. Ignore the rest until you've re-measured.

Rule: **never optimize the 2% case while the 60% case is still on the table**.

## Debugging flaky tests

A flaky test is a bug. Treat it.

- **Shared mutable state** between tests — reset in setup / use fresh fixtures.
- **Order dependency** — tests depend on other tests' side effects.
- **Timing** — tests that wait for "done" via sleep; flip to deterministic waits.
- **Randomness** — uncontrolled random input; seed it.
- **External dependencies** — real network / time / env; mock or inject.

If you can't fix the flake in a week, DELETE the test. A flake that lies about whether the code works is worse than no test.

## Live incident

Debugging with a fire lit:

1. **Stop the bleeding first.** Roll back, disable a feature flag, scale up, divert traffic. Diagnose later.
2. **Preserve evidence** — snapshot logs, heap, DB state before you mitigate; you'll need them for the postmortem.
3. **One driver, many helpers**. One person coordinating; others investigate. Avoid overlapping operations.
4. **Communicate every 15 min** even if nothing new: "still investigating DB side; rollback started at 14:03".
5. **Fix the immediate symptom. Plan the durable fix.** Different timescales.
6. **Write the postmortem.** Always. Blameless. Drive action items to completion.

## Rubber-ducking

Explaining the problem, in full, in plain words, to anyone or anything:
- A colleague.
- A rubber duck on your desk.
- A paragraph in a doc.

Making the explanation forces you to sequence the facts; the sequence often exposes the missing step.

Most "aha!" moments during rubber-ducking come at "okay so X happens, then Y, then — wait, does Y actually happen?"

## Pair debugging

Two people, one keyboard. One describes their mental model, the other asks questions. Costly in time; often pays for itself on nasty bugs.

## Warning signs in your own process

- You've tried four fixes. None landed.
- You're re-running the test hoping it passes.
- You're editing code to "see what happens" without a hypothesis.
- You've been on the same bug for 3+ hours with no progress.

All of these say: **stop, step away, reset**. Take a walk. Explain the bug to someone. Sleep on it. You'll come back cheaper and more effective.

## Bugs that turn out to be "not bugs"

Always worth checking:
- **Timezone / DST** — off-by-one-hour bugs.
- **Locale** — decimal separators, date order, sort order.
- **Unicode** — grapheme cluster length vs. byte length; RTL order.
- **Float precision** — 0.1 + 0.2 ≠ 0.3.
- **Integer overflow** — counters that wrap.
- **Caches** — serving a stale copy.
- **Config drift** — dev has flag X on, prod doesn't.
- **Env variables** — typos, unset, accidentally committed.

When the bug is "it only happens in prod", it's usually one of these.

## Fixing responsibly

- Write a regression test BEFORE merging the fix.
- Describe what the test proves in the commit message.
- Link the original bug report / ticket.
- If the fix has broader implications, write an ADR.

## Forbidden patterns

- "Just add a try/except around it so it doesn't crash"
- Closing a ticket without a reproduction-proving test
- Rolling out a fix to prod before verifying on staging
- Shipping a fix and "hoping" it works
- Saying "it works on my machine" as a closing line
- Removing a test that's failing "to unblock CI"
- Blaming a user without reproducing the bug first
- Fixing the symptom when you know where the root cause is

## The two-question close

Before declaring "fixed":

1. **Do I have a test that would have failed before this change?**
2. **Do I know what caused the bug, not just what suppresses it?**

If either is "no", you haven't finished.

## Pair with

- [`coding-standards/references/tdd.md`](../coding-standards/references/tdd.md) — for the test-first fix discipline.
- [`qa-tester`](../qa-tester/SKILL.md) — for edge-case intuition.
- [`devops/references/observability.md`](../devops/references/observability.md) — tools for finding what you can't guess.
