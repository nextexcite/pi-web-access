# CPA-backed Grok 4.7 search verification

Date: 2026-10-18. Scope: the historical `fix/xai-search-model-defaults` feature branch.

> Historical evidence: the experimental fork now uses upstream `xaiResponsesUrl`,
> `xaiApiKey` and configurable `xaiSearchTimeoutMs` instead of `xaiSearchProvider`.
> The configuration and live results below describe the earlier implementation,
> not a fresh live validation of the merged endpoint-based route. See the README
> for current configuration and migration instructions.

## Configuration and privacy

The live test used an existing authenticated Pi model provider backed by
CLIProxyAPI (CPA), requesting `grok-4.7` with `api: "openai-responses"`.
The provider's private registry name is represented here as `[private-cpa-provider]`.
No private provider name, gateway hostname, API key, header value, account identity,
cookie, or raw session transcript is included in this evidence.

Equivalent public configuration (the example provider name is not a real account):

```json
{
  "xaiSearchProvider": "cpa",
  "xaiSearchModel": "grok-4.7",
  "xaiSearchTools": ["web_search"],
  "allowBrowserCookies": false,
  "workflow": "none"
}
```

The test loaded this checkout's **`index.ts`** explicitly into fresh Pi 1.3.0 CLI
processes. It did not use the installed extension, a rewritten `fetch`, a mocked
provider registry, or the earlier temporary routing adapter. The private config
was isolated from the owner's normal configuration. Each run used `--no-session`,
no project context, no MCP, and no other extensions, with only `web_search` exposed.
The controller also used the registered CPA-backed Grok 4.7 model. Search requests
used `provider: "xai"`; the extension itself resolved the configured CPA endpoint
and credentials. Pi JSON events confirmed one tool call, exact requested arguments,
a successful tool result, and one successful query per run.

## Live extension results

| Check | Source count | Observed source hosts | Tool duration | Result |
|---|---:|---|---:|---|
| Basic Grok 4.7 context-window search | 3 | `docs.x.ai` | 12.85 s | Answer and citations returned |
| `domainFilter: ["docs.x.ai"]` | 3 | `docs.x.ai` | 9.95 s | All returned URLs matched |
| `domainFilter: ["-docs.x.ai"]` | 3 | `docs.aws.amazon.com`, `docs.oracle.com`, `www.grokati.com` | 12.35 s | No returned URL matched the excluded domain |
| `recencyFilter: "week"`, `numResults: 2` | 2 | `techcrunch.com`, `x.ai` | 19.88 s | Answer returned; source cap respected |

The model returned a 500,000-token context-window answer for the first three
queries. This records a useful source-linked search result, not independent
verification of every claim in the generated answers. Recency is prompt guidance;
the last row does not prove hard date filtering. Search-time cost/usage was not
reported and no cost is inferred.

## Offline checks

- `node --import ./test/isolate-env.mjs --test test/xai-provider.test.mjs`: **31/31 passed**.
- `npm run typecheck`: passed.
- Active LSP checks for the changed TypeScript/test files: no diagnostics.
- `git diff --check`: passed.
- `env -u XDG_CONFIG_HOME npm test`: **1,265 passed, 11 failed / 1,276 total**.
  The same 11 failures were already reproduced on the upstream baseline
  `18e36f9` before this enhancement: session-history clone retention, three
  YouTube answer-mode fixtures, two GitHub tool-hint fixtures, Parallel MCP
  fetch routing, three proxy-transport fixtures, and one source-check fixture.
  The full suite is **not green**; these unrelated failures were not patched.

Mocks verify that native `allowed_domains` / `excluded_domains` fields are actually
sent, normalization/deduplication, the five-domain boundary, prompt-only mixed or
oversized lists, and no web filter fields on `x_search`. CPA tests cover the
registered endpoint/model/credentials, request-time URL overrides, invalid config,
fail-closed behavior with direct-xAI keys present, key/header redaction, case-insensitive
header overrides, and an actual loopback HTTP redirect that is rejected without
contacting its target. Direct-xAI tests additionally reject non-official model and
request-time auth URLs before any fetch or API-key fallback, including when
registry authentication fails or has no key, and accept official URL overrides.
Endpoint tests also reject bare `?` and `#` delimiters. These close the endpoint
and fallback edge cases found in Codex review.
Existing direct-xAI auth fallback and explicit-only routing checks remain green.

## Reference and limits

- [CPA request normalizer](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/xai_executor_request.go): `filters` is forwarded; unsupported OpenAI `external_web_access` and `search_context_size` fields are stripped.
- [xAI Web Search](https://docs.x.ai/developers/tools/web-search): at most five domains; allow/exclude lists cannot be combined in one native filter.
- [xAI X Search](https://docs.x.ai/developers/tools/x-search): X handles and dates are separate features, not shared web-search recency filters.

This demonstrates one CPA-backed deployment and Grok 4.7, not every proxy/model
combination. Direct xAI API access and live X-only/media/location filters were not
tested. Direct-xAI model defaults, zero-config auto routing, and `provider: "all"`
behavior are unchanged. No browser cookie access was used.

## Dogfood timeout follow-up — 2026-10-19

The owner's X-focused research hit the previous 60-second client deadline.
Live probes with the same CPA-backed Grok model returned HTTP 200: a simple web
search took 8.4 seconds, X-only search 14.4 seconds, and an X-focused query took
47.7 seconds with web search only versus 24.2 seconds with both tools enabled.
Replaying the exact failed query with both tools took 54.7 seconds, leaving too
little margin under the old deadline. These are individual observations, not a
latency benchmark or proof that enabling X Search alone prevents timeouts.

The owner configuration now opts into both `web_search` and `x_search`; the
package default remains web-only. The request/response deadline is now 120
seconds. Expiry becomes a normal provider network failure eligible for configured
fallback instead of being mistaken for caller cancellation. Caller cancellation
still propagates unchanged, including while reading JSON.

- Three new regression tests failed before the fix and passed afterwards.
- Focused provider, routing, concurrency, error-rendering and error-flag checks:
  **82/82 passed**; typecheck and `git diff --check` passed.
- A fresh, in-memory Pi SDK session loaded this checkout's real `index.ts` and
  executed its registered `web_search` with `provider: "xai"`, the owner's normal
  config and real registry credentials, without a mocked fetch or controller
  model request. The exact failed query returned a successful structured result
  with five X sources. This repeated/warm request took 1.4 seconds; its speed is
  not evidence of typical cold-search latency.
- No credentials, private endpoint, provider identity, cookies or raw transcript
  are recorded here. Returned political claims were not independently verified.
- The full suite was not rerun for this follow-up; the earlier baseline-failure
  caveat remains.
