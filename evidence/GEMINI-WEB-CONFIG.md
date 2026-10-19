# Gemini Web search: final status and lessons

**Investigation closed, 2026-10-19.** The experimental, opt-in adapter is retained. Flash-Lite/Low works in the final bounded check, but the evidence does **not** justify recommending Gemini Web as a dependable primary search provider. No further probes, restarts or comparisons are planned.

## Final working code and evidence

The client discovers model selection metadata from the actual cookie session's catalog, rejects unavailable/ambiguous selections without substitution, validates response framing, and sends matched model/thinking fields. API-first routing, cookie opt-in and API-only Gemini participation in `provider: "all"` are unchanged. The legacy website default remains `gemini-3.1-pro`; Lite requires explicit configuration. macOS cookie reads are read-only in place without database snapshots; Python fallback paths are encoded as file URIs so profile names stay literal. Encryption passwords are cached only in-process.

The last live check loaded this checkout's actual `index.ts` directly in Pi 1.3.0: existing selected Brave profile, `gemini-3.5-flash-lite`, Low, API unavailable, `numResults: 10`, no content fetching or curator, one generation, no retry. It preceded the final offline-reviewed URI-encoding and parser-error classification fixes; no new live validation followed those fixes.

| Observation | Result |
| --- | --- |
| Tool call → result | **11.182 s** |
| Generation request → headers / completed body | **0.987 / 6.759 s** |
| App / catalog / generation | HTTP 200 / 200 / 200 |
| Selection and thinking | Catalog/header/body matched; Low flags **1 / 1** |
| API calls / observer errors | 0 / 0 |
| Returned references | **5/5** exact URLs fetched as useful official Vercel pages |

The checked Vercel [environment](https://vercel.com/docs/deployments/environments) and [promotion](https://vercel.com/docs/deployments/promoting-a-deployment) documentation supported Preview branch overrides, new deployments after variable edits, Preview-to-Production rebuilds with Production variables, and staged Production promotion without rebuilding. The answer's broad build-time wording needs qualification: server-only variables are read at runtime from the immutable deployment; cache-clearing advice is troubleshooting guidance, not a universal requirement. This is one useful result, not broad reliability, native search ranking or backend-budget proof. First-useful-answer time was not measured.

## Tracking multiple profiles

- Browser preset, visible profile name, profile directory and Google account within a profile are different selectors. Verify the intended browser's Profile Path; do not guess `Default`. Pin `browserCookies.browser` and `.profile`; automatic discovery selects the first qualifying profile, not necessarily the intended subscription.
- Profile configuration is cached. Use separately initialized clients/processes for comparisons. A visible Google account switch does not prove that the cookie adapter changed accounts; catalog/request evidence matters more than picker labels.
- A UI `/u/N` URL is not an authenticated RPC contract. An agent-added routing/digest guard created a false blocker and was removed entirely. The final call used the established request path. Tests that merely encode an assumption do not validate upstream behavior. No account-path/header override or email-digest prerequisite remains.

## Mapping thinking levels

Observed Flash-Lite 3.5 / Flash 3.8 UI values are **not numerically sequential**:

| Setting | Header `[15]` / body `[80]` | Lite observations |
| --- | ---: | --- |
| `default` / `low` | **1 / 1** | Low was most consistently usable; final check passed |
| `medium` | **4 / 4** | Short functional reply succeeded; ten-source search timed out |
| `high` | **2 / 2** | One research search completed with better coverage, about 2.58× Low's time |

Explicit levels apply only to Flash/Flash-Lite names; other families remain default-only. Default equals Low here, **not thinking-off** or a saved UI preference. API budgets, booleans and standard/extended aliases are rejected. These are verified request controls, not independently attested backend reasoning budgets or general quality improvements. Medium/High remain experimental; the final rerun covered Low only.

## Possible timeouts

The twelve-cell ten-result study produced five usable Lite lists and one Lite Medium timeout. Flash produced no usable list: five timeouts and one provider-error reply. Lite Low's four calls took 6.443–9.849 s; the High research call took 16.649 s. These small historical samples are not latency guarantees.

Timeouts occurred despite HTTP 200, near the 120 s request limit; setup can make total tool time longer. Native Flash also stalled, including on a trivial non-search prompt. Backend versus session/browser/transport causes were not isolated. Flash, Pro and Argon are not qualified as reliable by this work.

A timeout is an incomplete/censored outcome, not a slow success. Headers and first body bytes are not useful answers; quick provider-error replies are failures. Do not hide them with silent retries or model changes. Parser failures are classified as `invalid-response`; another provider is tried only when the configured routing policy explicitly permits that fallback.

## Domain allowlist: not enforced

`domainFilter`, including `-domain` exclusions, is **best-effort prompt guidance**, not a native enforced filter, local post-filter or security boundary. Small `nodejs.org` checks complied, but broader official-source instructions were sometimes missed. There is no measured general compliance rate: passing examples do not establish a working hard allowlist. `recencyFilter` is guidance too, not verified freshness.

The runtime explicitly qualifies these constraints. Do not use them for privacy/compliance enforcement. `numResults`, unlike those soft filters, deterministically caps unique structured references: default 5, normalized 1–20; fewer results are valid and additional answer links can remain.

## Source provenance and quality

References are parsed from model-authored Markdown, not a verified native Google result list. Native UI authored links and citation-panel destinations differed. Citation order is not demonstrated SERP rank, and citations alone do not prove retrieval.

An earlier audit of **44 distinct URLs** found **31 verified, 10 confirmed HTTP 404 and 3 access-blocked/unverified**. Missing URLs appeared verbatim in the model output, not from parser corruption. The final five working Vercel pages do not erase those failures. Access failures remain unknown, not automatically irrelevant; judgments were not end-to-end blinded. No general model/level winner is established.

Every website-search answer carries a provenance warning; domain/recency guidance receives another qualification. API answers and direct extraction output remain unchanged.

## Final offline validation

**72/72 focused tests pass**; TypeScript and diff checks pass. Full suite: **1,285/1,296 pass**, with exactly the accepted nonempty set of **11 pre-existing failures**, no additional names. This is not a green full suite; unrelated failures were not repaired. The four source/test paths changed by the review fixes reported zero LSP diagnostics; existing auxiliary-rule false-positive dispositions were disclosed, not counted as fixes.

```sh
node --import ./test/isolate-env.mjs --test \
  test/gemini-web-current-models.test.mjs \
  test/gemini-web-generation.test.mjs \
  test/gemini-web-cookie-opt-in.test.mjs \
  test/gemini-web-header-overflow.test.mjs \
  test/chrome-cookie-extraction.test.mjs
npm run typecheck
git diff --check
```

No account identities, personal profile directories, credentials or raw traffic are included. No provider/global defaults were changed. This closes the investigation with working code and recorded limitations, not promised follow-up work.
