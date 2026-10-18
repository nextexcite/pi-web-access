# CPA-backed Grok 4.7 search verification

Date: 2026-10-18. Scope: the `fix/xai-search-model-defaults` feature branch.

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

- `node --import ./test/isolate-env.mjs --test test/xai-provider.test.mjs`: **30/30 passed**.
- `npm run typecheck`: passed.
- Active LSP checks for the changed TypeScript/test files: no diagnostics.
- `git diff --check`: passed.
- `env -u XDG_CONFIG_HOME npm test`: **1,264 passed, 11 failed / 1,275 total**.
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
request-time auth URLs before any fetch or API-key fallback, and accept official
URL overrides. This closes the credential/endpoint mismatch found in Codex review.
Existing direct-xAI auth fallback and explicit-only routing checks remain green.

## Reference and limits

- [CPA request normalizer](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/runtime/executor/xai_executor_request.go): `filters` is forwarded; unsupported OpenAI `external_web_access` and `search_context_size` fields are stripped.
- [xAI Web Search](https://docs.x.ai/developers/tools/web-search): at most five domains; allow/exclude lists cannot be combined in one native filter.
- [xAI X Search](https://docs.x.ai/developers/tools/x-search): X handles and dates are separate features, not shared web-search recency filters.

This demonstrates one CPA-backed deployment and Grok 4.7, not every proxy/model
combination. Direct xAI API access and live X-only/media/location filters were not
tested. Direct-xAI model defaults, zero-config auto routing, and `provider: "all"`
behavior are unchanged. No browser cookie access was used.
