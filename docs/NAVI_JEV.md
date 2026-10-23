# Jev decision adapter

Experimental library API, now used by the opt-in [standard web_search integration](NAVI_PI_ALPHA.md) in Pi/shared core. No ambient credential discovery or live calls happen on import. The host owns opt-in, query selection, credential references, provider allowlists and the overall request budget.

## Verified protocol

Checked against TypeSafe's [System One API](https://docs.typesafe.ai/api/system-one) and [Choice primitive](https://docs.typesafe.ai/primitives/choice) on 2026-10-23 UTC. The adapter posts to `https://api.typesafe.ai/v1/systemone` using bearer authentication. One request asks three choice questions and reads the corresponding `answers` entries. No SDK dependency is added.

`createJevDecisionEngine` accepts a full HTTPS endpoint, model, credential resolver, deadline and optional scoped fetch implementation. The default model is `jev-latest`; use an explicitly pinned model for future measured evaluations. Custom endpoints are trusted host configuration. Redirects, URL credentials, query parameters and fragments are rejected; injected transports must honor `redirect: "error"`. This API does not accept endpoint/model instructions from a query or model response.

Only validated depth, intent and freshness choices cross the decision boundary. Extra response fields, probability distributions and model text are discarded. This version makes no confidence-based decision and does not equate classification confidence with evidence quality. Criteria are versioned as `navi-signals-v1`.

## Example for a future host integration

```ts
import { createJevDecisionEngine } from "../navi-jev.ts";
import { classifyWithFallback } from "../navi-decision.ts";

const engine = createJevDecisionEngine({
  getApiKey: async signal => resolveHostCredential(signal),
  model: configuredModel,
  timeoutMs: 3000,
});
const outcome = await classifyWithFallback({
  engine,
  query: sanitizedQuery,
  signal: requestSignal,
  timeoutMs: Math.min(3000, remainingRequestMs),
});
// Pass outcome.signals only when outcome.status === "classified".
// A rules outcome omits signals; compileSearchPolicy then selects deterministic rules.
```

Names for host functions/values in this example are placeholders, not new `web-search.json` settings. The host must skip classification entirely when routing is off or provider selection is explicit; it must not launch work with zero remaining time. Shadow mode may classify only after opt-in to sending the sanitized query, while the existing search path remains authoritative.

## Failure behavior

- Default adapter deadline: 3 seconds, configurable from 1 to 60,000 ms; includes credential resolution, transport and reading the body. No retry or model failover.
- Nonempty queries are capped at 32 KiB UTF-8; response bodies are capped at 64 KiB of actual decoded stream bytes, regardless of content-length.
- Missing credentials, HTTP/transport failures and malformed choices produce fixed error codes. Remote bodies, raw error messages, URLs, keys and abort reasons are never copied to errors.
- `classifyWithFallback` bounds any decision-engine implementation, validates its outputs and returns a rules outcome on failure. Caller cancellation throws a sanitized `AbortError`, never a fallback instruction. The host still enforces the total search/fetch budget.
- An injected transport or credential resolver should honor its signal. The wrapper can stop awaiting an uncooperative implementation, but cannot forcibly stop external code.

## Verification and remaining gate

Offline tests exercise the documented request shape, malformed output, missing credentials, redirect/error statuses, body limits, stalled credentials/transport/body, cancellation and fallback into the planner. Run:

```sh
node --import ./test/isolate-env.mjs --test test/navi-jev.test.mjs test/navi-policy.test.mjs
```

Live Jev compatibility, classification quality and cost remain unverified. A future authorized smoke test must record the resolved model and latency with appropriate test data. NAV-5's host configuration and request execution are implemented on the integration branch; the Pi alpha still needs intended-host installation and live qualification.
