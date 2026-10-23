# Navi foundation

Status: experimental planning contract, not an enabled routing feature. No Jev calls, provider requests, telemetry export or owner configuration changes are introduced here.

## Integration boundaries

`web-tool-core.ts` owns the shared tool execution contract; `gemini-search.ts` owns existing provider selection and adapters. `index.ts` supplies Pi behavior and `mcp-server.ts` / `mcp-cli.ts` expose standalone MCP behavior. Keep the new policy independent of those hosts.

`navi-policy.ts` introduces a pure first-round planner and `DecisionEngine` interface. A host supplies a sanitized query to a decision adapter, validates the response, and passes task signals plus operational provider capabilities into the planner. Adapters own authentication and protocol mapping; the planner receives neither credentials nor provider response text.

The capability preferences are initial hypotheses, not measured rankings. Capability diversity does not establish independent underlying indexes. Registry order is the stable tie-breaker and contains no hard-coded vendor preference.

## Contract invariants

- `off` bypasses the planner. `shadow` returns a proposal while keeping execution with the existing host; the host must not dispatch it and must contain planning failures. `on` returns a plan.
- The host resolves upstream explicit/configured provider choices before planning, including `auto` and `all`. Explicit arrays retain their order and cannot be silently replaced or truncated. Invalid/unavailable/disallowed choices fail closed.
- Missing decision signals select deterministic rules. Malformed signals fail validation; the future adapter/host owns failure containment and fallback.
- Automatic first-round selection is bounded by the remaining search-call budget and uses at most two providers. `investigate` is a strategy label, not an implemented research loop.
- Limits describe total permitted work. The future executor must reserve/decrement search calls across all queries, retries and expansions, enforce content limits and use an absolute deadline/cancellation signal. A pure planner cannot enforce wall-clock limits by itself.
- Errors do not echo arbitrary provider IDs, model text, queries or secrets.

## Next implementation slice

1. Audit actual provider capabilities and readiness; make no live claim from mock data.
2. Verify the Jev protocol and implement an injected adapter with response validation, timeout and cancellation.
3. Add opt-in configuration and request-level budget enforcement in the shared core. Preserve existing configured-provider and Pi/MCP isolation behavior.
4. Add provenance and redacted trace events. Keep raw query logging opt-in; separate planned and executed actions.
5. Evaluate before changing defaults. Extract a service boundary from validated contracts without importing Pi state into the core.

## Local verification

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
node --import ./test/isolate-env.mjs --test test/navi-policy.test.mjs
git diff --check
```

These are offline policy checks. They do not certify a working Jev integration, an installed Pi alpha, a live search portfolio or a hosted service. Follow AGENTS.md for broader tests and delivery.
