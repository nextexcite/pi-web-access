# Navi opt-in routing slice

Status: implemented for standard `web_search` through the shared Pi/MCP core, tested with offline transports. Default is off. Installed owner configuration is untouched. This is a review branch, not a deployed or live-qualified Pi alpha.

## Configuration

Add `navi` to the existing `web-search.json` only when opting in. Example:

```json
{
  "navi": {
    "mode": "shadow",
    "providers": ["brave", "exa", "tavily"],
    "limits": {
      "maxSearchCalls": 4,
      "maxContentFetches": 2,
      "deadlineMs": 15000
    },
    "decision": { "engine": "rules", "timeoutMs": 1500 }
  }
}
```

`mode` is `off`, `shadow` or `on`. Absent config/default mode is off and ignores unused Navi settings. Enabled settings are validated. Limits allow 1–100 search attempts, 0–20 extraction jobs and 1–120,000 ms per request. These are safety ceilings, not spending targets. Provider order is a deterministic tie-breaker.

Rules require no decision API key. To select Jev, set `decision.engine` to `jev` and supply `decision.apiKey` as an existing credential-source string, for example `$JEV_API_KEY`. Optional `decision.model`, `decision.endpoint` and `decision.timeoutMs` are passed to the [Jev adapter](NAVI_JEV.md). The endpoint is a full HTTPS URL. There is no automatic key lookup from Pi's model registry or an unrelated environment variable. Both Pi and standalone MCP resolve only the explicitly configured reference. Literal keys and private gateway URLs must remain outside Git.

Enabling Jev sends normalized search queries to the configured decision service. It does not send conversation history, provider credentials or Pi registry state. There is no automatic detection/redaction of secrets inside a user-supplied query; only send appropriate queries. Trace diagnostics omit query text, credentials, endpoints and remote error bodies. Existing search-result storage continues to contain the user's queries and retrieved content.

## Modes and overrides

| Mode | Planning | Executed search/content behavior |
| --- | --- | --- |
| off | No classification or planner | Existing path and configured-provider fallback behavior |
| shadow | Bounded hypothetical planning; optional Jev | Existing path, including its content/background behavior; Navi limits do not constrain legacy execution |
| on | Plan and execute within one budget | Audited portfolio only; await bounded content, no background content job |

Shadow planning/configuration failure is recorded as `details.navi.status = "shadow-error"` and does not stop the existing search. Its planning deadline is separate from the legacy search lifecycle. A shadow proposal is never dispatched. Pi curator and auto-summary remain on their existing separate paths in off/shadow; this slice does not instrument hypothetical plans inside the curator.

On supports **Brave, Exa and Tavily**. They have request-attempt hooks through retries and Exa MCP fallback. Availability checks report adapter configuration, not proven reachability/quota/quality; Exa can use its existing keyless MCP route. Automatic selection intersects `navi.providers`, current availability and `webSearch.allowedProviders`.

Explicit per-call selections and configured single/array defaults retain their order and skip decision-engine construction and credentials. Explicit selections still obey the global allowlist, availability and request budget. Unsupported providers, `all`, and over-budget explicit selections fail clearly; no replacement or truncation. Use off/shadow for the other existing providers until their attempts are audited. Existing `searchRouting` fallback chains are not entered by Navi on; selected providers are dispatched individually and strictly. Model output cannot select an endpoint, credential or arbitrary provider.

## Execution and accounting

- One absolute deadline starts before readiness, decision and provider work. Every query, retry and awaited page extraction shares its signal. Caller cancellation propagates as a sanitized `AbortError`; it never initiates fallback work.
- A search call means an actual outbound search HTTP attempt, including Brave retry, Tavily key failover and Exa MCP advanced/basic fallback. Reservation occurs immediately before fetch. Jev requests have separate decision deadlines and do not consume search-attempt slots, but their time counts toward the total deadline.
- Search providers receive `includeContent: false` in on. This prevents provider-controlled content retrieval from bypassing the extraction-job ceiling. If requested, full content is obtained in the shared core and awaited.
- A content fetch means one URL extraction job, not one HTTP packet. A job may involve redirects, provider extraction fallback or special URL handling. This ceiling and deadline do **not** establish a hard dollar cap or bound every extraction subrequest. Future accounting should expose those suboperations before claiming either.
- Queries and selected providers execute in stable order. Earlier work/retries may consume budget needed by later queries. Later failures are returned explicitly instead of silently dropping queries. Successful sources survive other provider failures or deadline exhaustion.
- Every result URL gets either fetched content or a stored error entry when content was requested. Failed/skipped URLs are not launched later by Pi's background hook. No new fusion ranking is claimed; URL deduplication is conservative and full provenance work remains NAV-6.

`details.navi` reports mode/status, ordinal plans and basis, decision disposition, limits, actual search-attempt/extraction counts, deadline status and partial status. It is a small call diagnostic, not a persisted telemetry/evaluation pipeline. Partial output is also identified in tool text.

## Scope and qualification

Navi on requires `workflow: "none"`. Pi curator/summary workflows have separate lifecycles and are rejected in on rather than bypassing its budgets. Standalone MCP rejects unsupported workflows as before. `source_check`, `fetch_content`, dedicated `x_search`, curator commands and already-stored content tools retain their existing behavior; Navi budgets cover one standard `web_search` request and its requested content only, not an entire agent session.

Offline coverage includes actual Pi extension registration/tool execution, standalone shared-core behavior, off/shadow isolation, Jev proposal versus executed route, explicit/configured arrays, budget exhaustion across queries and retries, redirects, extraction ceilings, deadline/abort and independent concurrent requests. No live Jev/provider call or installation update was performed. Live credential/readiness and Pi reload smoke remain handoff gates; see [NAVI_HANDOFF.md](NAVI_HANDOFF.md).
