# Gemini website configuration: evidence and limits

## Contract

`geminiWebModel` and `geminiWebThinking` are website-only options forwarded from search to `queryWithCookies`; official API `searchModel`, API-first routing and cookie opt-in remain independent. A successful API result ignores unused website settings. `provider: "all"` remains API-only for Gemini.

Model syntax and unsupported thinking values fail before I/O. Valid model names are resolved against the selected account's current `GetUserStatus` catalog before generation or uploads. Category aliases and exact versioned display names are accepted only when unambiguous. Missing, retired or ambiguous models fail explicitly; no alternate model is requested. The configured default name remains `gemini-3.1-pro`, but its selection metadata is discovered rather than taken from stale static headers.

Only `geminiWebThinking: "default"` is implemented. The request uses the public reference's default protocol value; this is **not** verified support for UI Low/Medium/High, standard/extended controls, thinking-off, or API thinking budgets. Those explicit overrides remain rejected.

## Protocol provenance

Public research, pinned to [HanaokaYuzu/Gemini-API commit 1ad0d4a](https://github.com/HanaokaYuzu/Gemini-API/tree/1ad0d4a93e505e77c79769d78ef2997641f973c8), inspected 2026-10-18:

- [`constants.py`](https://github.com/HanaokaYuzu/Gemini-API/blob/1ad0d4a93e505e77c79769d78ef2997641f973c8/src/gemini_webapi/constants.py): selection-header construction, read-only user-status RPC and rejection codes. Static model enums are deprecated.
- [`types/availablemodel.py`](https://github.com/HanaokaYuzu/Gemini-API/blob/1ad0d4a93e505e77c79769d78ef2997641f973c8/src/gemini_webapi/types/availablemodel.py): account-derived model identity, display/category labels, capacity and model number.
- [`client.py`](https://github.com/HanaokaYuzu/Gemini-API/blob/1ad0d4a93e505e77c79769d78ef2997641f973c8/src/gemini_webapi/client.py): request construction, body fields 79/80, length-prefixed response frames and per-part terminal errors.
- [`utils/parsing.py`](https://github.com/HanaokaYuzu/Gemini-API/blob/1ad0d4a93e505e77c79769d78ef2997641f973c8/src/gemini_webapi/utils/parsing.py): the length count starts at the delimiter newline after the digits and covers that newline plus the JSON frame in UTF-16 code units. The parser now validates that full boundary.

These are unofficial protocol observations, not a Google specification. Production code contains no current-model ID table. Account capacity follows the reference; unobserved sparse capacity formats are rejected rather than guessed. Successful selection metadata or answer text does not establish the backend's effective model.

## Live compatibility matrix

Tested on branch `feat/gemini-web-model-thinking`, base HEAD `bb80d249544432c58b744e200e5954f8cdfe39cc`; worktree changes were uncommitted. The actual extension runs used Pi 1.3.0 with this checkout's `index.ts` explicitly loaded in an isolated session. Gemini API keys, gateways and ADC were disabled; instrumented live requests reached `gemini.google.com`, with zero API-provider calls. Profile references are anonymized and only the explicitly selected Brave profiles were used.

| Profile / route | Requested selection | Outcome | Evidence and limit |
| --- | --- | --- | --- |
| Brave profile A — Free / website picker | Auto (Gemini 3 models) | Shown as selected | UI-advertised only; generation not tested |
| Brave profile A — Free / website picker | 3.1 Pro | Upsell marker shown; generation not tested | UI-advertised only; no upgrade action recorded |
| Brave profile A — Free / website picker | 4 Argon | Upgrade dialog opened; dismissed without model change or generation | UI-observed entitlement gate; no paid upgrade attempted |
| Brave profile A — Free / extension | — | Not tested | Fresh Keychain authorization for this profile was not approved; no claim of support |
| Brave profile B — AI Pro / website picker | 3.5 Flash-Lite, 3.8 Flash, 3.1 Pro, 4 Argon | All shown; Low/Medium/High thinking options shown | UI-advertised. Owner supplied subscription class. No model-use metadata visible in completed responses. |
| Brave profile B — AI Pro / website UI | Flash-Lite, Flash | Both completed public prompts | UI-observed; category selection only, not server-confirmed backend identity |
| Brave profile B — AI Pro / extension | `gemini-flash`, `default` | **Success** in 19.7 s; two official Node.js URLs | Registered `web_search`, checkout `index.ts`, app/GetUserStatus/StreamGenerate HTTP 200, API route disabled. Strong Gemini Web route proof; no effective-model attestation. |
| Brave profile B — AI Pro / extension | `gemini-flash-lite`, `default` | Initial attempt: **error**, no usable answer, about 1.9 s. One cold-process follow-up stopped at the five-second cookie-read deadline. The first later retry reached all three Gemini Web endpoints (HTTP 200) but failed framing; after correcting the frame boundary, a one-request retry **succeeded** in 13.7 s with two official Node.js URLs in the result. | The successful retry used the checkout extension with Gemini API disabled. It establishes route compatibility for this prompt, not answer quality or effective backend model identity. No raw answer or response body was retained. |
| Brave profile B — AI Pro / extension | `gemini-pro`, `default` | **Timeout** at 120 s, no usable answer | App, GetUserStatus and StreamGenerate HTTP 200; stream did not complete before request deadline. No retry. |
| Brave profile B — AI Pro / extension | `gemini-argon` | Not attempted | Batch stopped after the preceding timeout to limit remote use. |

A cold SDK process first timed out reading Brave's password-store authorization before any Google/API request. One grouped run then reused its in-memory authorization for Flash, Flash-Lite and Pro. A later cold-process diagnostic stopped at the five-second password-read deadline before network access. One authorized Flash-Lite retry then reached Gemini Web but failed framing. Source review subsequently identified that the local parser omitted the separator newline from the declared frame length; after that correction and the offline tests, the next one-request retry succeeded. No persistent Keychain permission was requested; the Free-profile catalog-only check remains unrun.

## Exploratory direct-generation pilot — not search-quality evidence

Three prompts were sent through the existing AI Pro Brave website UI in fresh chats, with UI **Low selected** each time. The creative dialogue, known coding utility and fully specified math problem did not require web retrieval or citations. Their scores **do not answer whether Flash-Lite, Flash or Argon is good enough as a sourced search tool**. UI Low is not evidence of a server-confirmed thinking level.

The scores below are retained only as exploratory generation notes, not as model rankings. The single-sample capture/scoring procedure was not reliably blind: model mappings were visible during T1 and S1 scoring, one E1 answer was exposed during recovery, and `.innerText` preserved inconsistent rendered math and UI elements. At least one score note misread an answer. No aggregate/winner should be inferred.

| Task | Flash-Lite | Flash | Argon | Pro |
| --- | --- | --- | --- | --- |
| Entertainment dialogue, E1 | 8/16, 6.4 s | 12/16, 9.3 s | 15/16, 16.0 s | Generic refusal; no elapsed time retained |
| JavaScript stable de-duplication, T1 | 15/16, 9.6 s | 14/16, 9.3 s | 14/16, 11.9 s | Not sampled |
| Base-rate calculation, S1 | 16/16, 11.6 s | 13/16, 16.0 s | No visible answer after ~150 s; manually stopped | Not sampled |

The owner supplied the relevant cost ordering: Flash-Lite is fastest/cheapest and Argon most expensive; per-request usage measurement is not needed for this decision. Pro is low priority because it is likely to be superseded soon.

## Bounded source-grounded quality screen

With explicit approval, eight single searches were run through the registered checkout `web_search` extension: four prewritten public tasks, each once with Flash-Lite and Flash, alternating order. The existing Brave profile was used, Gemini API was disabled, `workflow: "none"` and `geminiWebThinking: "default"` were set, and no retries or quota measurements were made. All eight searches completed with app/GetUserStatus/StreamGenerate HTTP 200; API calls: zero. Blind 0–4 scoring was fixed before revealing the model mapping. One cited page per answer was checked (five unique pages because paired answers shared sources); raw answers and mapping remain outside this public evidence file.

| Task | Flash-Lite | Flash | Blind result and source-check limit |
| --- | ---: | ---: | --- |
| Wednesday S2 release dates | 2.06 | 3.96 | Both dates correct. Lite cited secondary TheWrap only despite the official-source requirement; Flash cited Netflix Tudum, whose checked page states both dates. |
| Node.js phases on 2025-10-01 | 2.75 | 2.71 | Both correctly answered v24 Current and v22 Active LTS. The checked official Node page links the detailed schedule but does not show that historical phase table in extracted text; a second cited official schedule URL was not fetched. |
| Bennu sample findings | 2.28 | 2.19 | Both gave 14/20 amino acids, all five nucleobases and the no-life caveat. The checked NASA page supports general organic ingredients/wet-salty environment, not those numeric counts; other cited pages were not checked. |
| 2024 Nobel false premise | 2.99 | 2.98 | Both rejected the premise and gave the official Nobel citation. Both outputs also exposed a raw `googleusercontent.com/youtube_content/1` placeholder and `<FollowUp>` markup. |
| **Mean (4 prompts)** | **2.52** | **2.96** | Flash's 0.44-point lead is almost entirely the single Q1 citation-compliance win; the other three pairs are effectively tied. |

Neither model met the predeclared bar (at least 3/4 on every applicable dimension for all four tasks). No central factual error or fabricated public citation was found, but Q1 shows a real source-constraint miss for Lite; Q2/Q3 source support is incompletely verified, and Q4 exposes an output-format artifact. This is a small screen, not a general benchmark. **Provisional choice: Flash is the safer default when source quality matters; Flash-Lite remains a plausible cheaper/faster option, but is not yet demonstrated good enough for the stated sourced-search bar.** The evidence does not establish a broad Flash advantage. No Argon or Pro requests were made; further or repeated comparisons require fresh approval.

## Offline regression coverage

Fixtures are fabricated, including synthetic selection IDs; they contain no captured account data. Tests cover current catalog resolution, category/versioned aliases, account-specific selection fields, config validation, unavailable/retired/ambiguous models failing before generation/upload, thinking rejection, UTF-16 response-frame length validation including the delimiter newline, astral Unicode and truncation, later terminal error precedence over malformed candidate JSON, HTTP status visibility, cookie opt-in/profile forwarding, and API `searchModel` independence.

Focused command (isolated environment, Node from the local toolchain):

```sh
node --import ./test/isolate-env.mjs --test \
  test/gemini-web-current-models.test.mjs \
  test/gemini-web-generation.test.mjs \
  test/gemini-web-cookie-opt-in.test.mjs \
  test/gemini-web-header-overflow.test.mjs
npm run typecheck
git diff --check
```

Latest focused run after parser fixes: **32/32 passed**; typecheck and diff checks passed. Full suite: **1,268/1,279 passed, 11 failed**. The same 11 unrelated failures are known at the upstream baseline: session-history fork, YouTube/proxy fixtures, GitHub retrieval hints, Parallel MCP fetch routing, proxy transport and source-check fetch behavior. They are outside this branch's scope; no unrelated failures were changed.

## Recommendation and remaining gaps

**The parser correction and both lower-cost routes are live-verified; the quality result is provisional.** Deterministic regressions cover the separator-inclusive UTF-16 frame boundary and later terminal rejection precedence. The eight-call screen gives Flash a cautious edge on one explicit citation constraint, but neither model passes the all-task bar. Effective backend model/thinking and the Free-profile route remain unverified. Keep any PR claim narrow; do not market this as complete support for current Gemini models or Low/Medium/High thinking. No commit, push or PR was made.

Private, non-Git observations and fabricated prompt/answer artifacts are under `/tmp/pi-web-access-gemini-plan/`, including `current-model-discovery.json`, `extension-outcomes-B-private.json`, `benchmark-bank.json`, `benchmark-{E1,T1,S1}-private.json`, and matching `*-judgment.json`. The public evidence intentionally contains no account identity, email, profile directory, cookies, raw traffic or account-specific model IDs.
