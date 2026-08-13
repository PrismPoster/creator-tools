# Contributing

Thanks for looking. This package stays useful by being narrow and verifiable, so
the review bar is about evidence rather than volume.

## The two bars

**A new constant needs a first-party source.** A platform frame size, a safe area,
a codec limit — the PR must link the page it was read from, and that page must
belong to the platform itself. A figure quoted from a blog, a competitor's
calculator, or an LLM is not a source. If the platform doesn't publish the number,
that is itself the finding: model it as `unpublished` with the reason, the way
TikTok's safe area is modelled.

**A new function needs a test that fails without it.** Not a test that asserts the
function was called — a test that would break if the arithmetic were wrong. The
existing suite is a reasonable guide: it catches real defects, including a
pixel-losing rounding bug and an SRT parser that silently dropped every end
timestamp.

## Scope

In scope: pure, deterministic utilities a creator or an encoder pipeline needs.

Out of scope: anything with a network call, a runtime dependency, a framework
binding, or an API key. Those belong in your app, not here. A React hook wrapping
these functions is a fine thing to build — just not in this package.

## Conventions

- **Invalid input returns `null`; it does not throw.** These functions sit behind
  text inputs where a half-typed value is normal.
- **`null` means "no answer exists"** and must stay distinguishable from a real
  zero. Never substitute a plausible default for an unknown.
- **Round once, at the boundary.** Sizes come back as whole pixels.
- **Comments explain constraints, not mechanics.** Write down the thing the next
  reader can't see from the code — why the remainder goes right, why the median
  and not the mean.

## Before you open a PR

```bash
npm install
npm run typecheck
npm test
```

Both must be clean. If you changed a published constant, say in the PR body which
first-party page you read it from and when.

## Reporting a wrong number

Open an issue with the value, what it should be, and the first-party source. A
wrong constant here propagates into other people's renders, so these get fixed
ahead of features.
