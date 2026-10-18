# Gemini website configuration: evidence and limits

## Contract

`geminiWebModel` and `geminiWebThinking` are website-only options forwarded from search to `queryWithCookies`; official API `searchModel`, API-first routing and cookie opt-in remain independent. A successful API result ignores unused website settings. `provider: "all"` remains API-only for Gemini.

Model syntax and unsupported thinking values fail before I/O. Valid model names are resolved against the selected account's current `GetUserStatus` catalog before generation or uploads. Category aliases and exact versioned display names are accepted only when unambiguous. Missing, retired or ambiguous models fail explicitly; no alternate model is requested. The configured default name remains `gemini-3.1-pro`, but its selection metadata is discovered rather than taken from stale static headers.

The supported/tested search configuration is explicit `geminiWebModel: "gemini-flash-lite"` or `"gemini-flash"`, with `geminiWebThinking: "default"`. The shared legacy Pro default is preserved for compatibility, not advertised as a newly tested zero-config path. Pro and Argon live testing is deferred.

Only `geminiWebThinking: "default"` is implemented: the reference-standard request flag `1` is sent consistently in header position 15 and body position 80. This is **not** verified support for UI Low/Medium/High, explicit standard/extended controls, thinking-off, or API thinking budgets. Those explicit overrides remain rejected. A requested flag, a selected UI label, and effective backend attestation are distinct evidence levels.

Selection IDs are not immutable public model IDs. Every call re-resolves the selected account's current ID/model-number/capacity tuple; contradictory tuples or alias collisions fail before uploads/generation. Exact duplicates are harmless; version pins never silently become category aliases. Model-number field 17 takes precedence over fallback field 9 per the pinned reference. Unsupported localized-only labels are not translated or guessed.

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
| Brave profile A — Free / extension | — | Not tested | Outside the completed live scope; no claim of support |
| Brave profile B — AI Pro / website picker | 3.5 Flash-Lite, 3.8 Flash, 3.1 Pro, 4 Argon | All shown; Low/Medium/High thinking options shown | UI-advertised. Owner supplied subscription class. No model-use metadata visible in completed responses. |
| Brave profile B — AI Pro / website UI | Flash-Lite, Flash | Both completed public prompts | UI-observed; category selection only, not server-confirmed backend identity |
| Brave profile B — AI Pro / extension | `gemini-flash`, `default` | **Success** in 19.7 s; two official Node.js URLs | Registered `web_search`, checkout `index.ts`, app/GetUserStatus/StreamGenerate HTTP 200, API route disabled. Strong Gemini Web route proof; no effective-model attestation. |
| Brave profile B — AI Pro / extension | `gemini-flash-lite`, `default` | Initial attempt: **error**, no usable answer, about 1.9 s. The first later retry reached all three Gemini Web endpoints (HTTP 200) but failed framing; after correcting the frame boundary, a one-request retry **succeeded** in 13.7 s with two official Node.js URLs in the result. | The successful retry used the checkout extension with Gemini API disabled. It establishes route compatibility for this prompt, not answer quality or effective backend model identity. No raw answer or response body was retained. |
| Brave profile B — AI Pro / extension | `gemini-pro`, `default` | **Timeout** at 120 s, no usable answer | App, GetUserStatus and StreamGenerate HTTP 200; stream did not complete before request deadline. No retry. |
| Brave profile B — AI Pro / extension | `gemini-argon` | Not attempted | Batch stopped after the preceding timeout to limit remote use. |

One grouped run used process-local cookie authorization for Flash, Flash-Lite and Pro. A Flash-Lite retry reached Gemini Web but failed framing. Source review subsequently identified that the local parser omitted the separator newline from the declared frame length; after that correction and the offline tests, the next one-request retry succeeded. No persistent Keychain permission was requested; the Free-profile catalog-only check remains unrun.

## Exploratory direct-generation pilot — not search-quality evidence

Three prompts were sent through the existing AI Pro Brave website UI in fresh chats, with UI **Low selected** each time. The creative dialogue, known coding utility and fully specified math problem did not require web retrieval or citations. Their scores **do not answer whether Flash-Lite, Flash or Argon is good enough as a sourced search tool**. UI Low is not evidence of a server-confirmed thinking level.

The scores below are retained only as exploratory generation notes, not as model rankings. The single-sample capture/scoring procedure was not reliably blind: model mappings were visible during T1 and S1 scoring, one E1 answer was exposed during recovery, and `.innerText` preserved inconsistent rendered math and UI elements. At least one score note misread an answer. No aggregate/winner should be inferred.

| Task | Flash-Lite | Flash | Argon | Pro |
| --- | --- | --- | --- | --- |
| Entertainment dialogue, E1 | 8/16, 6.4 s | 12/16, 9.3 s | 15/16, 16.0 s | Generic refusal; no elapsed time retained |
| JavaScript stable de-duplication, T1 | 15/16, 9.6 s | 14/16, 9.3 s | 14/16, 11.9 s | Not sampled |
| Base-rate calculation, S1 | 16/16, 11.6 s | 13/16, 16.0 s | No visible answer after ~150 s; manually stopped | Not sampled |

The owner supplied the relevant cost ordering: Flash-Lite is fastest/cheapest and Argon most expensive; per-request usage measurement is not needed for this decision. Pro is low priority because it is likely to be superseded soon.

## Answer/citation screen — not ranked-search evaluation

With explicit approval, eight single searches were run through the registered checkout `web_search` extension: four prewritten public tasks, each once with Flash-Lite and Flash, alternating order. The existing Brave profile was used, Gemini API was disabled, `workflow: "none"` and `geminiWebThinking: "default"` were set, and no retries or quota measurements were made. All eight searches completed with app/GetUserStatus/StreamGenerate HTTP 200; API calls: zero. Blind 0–4 scoring was fixed before revealing the model mapping. One cited page per answer was checked (five unique pages because paired answers shared sources); raw answers and mapping remain outside this public evidence file.

| Task | Flash-Lite | Flash | Blind result and source-check limit |
| --- | ---: | ---: | --- |
| Wednesday S2 release dates | 2.06 | 3.96 | Both dates correct. Lite cited secondary TheWrap only despite the official-source requirement; Flash cited Netflix Tudum, whose checked page states both dates. |
| Node.js phases on 2025-10-01 | 2.75 | 2.71 | Both correctly answered v24 Current and v22 Active LTS. The checked official Node page links the detailed schedule but does not show that historical phase table in extracted text; a second cited official schedule URL was not fetched. |
| Bennu sample findings | 2.28 | 2.19 | Both gave 14/20 amino acids, all five nucleobases and the no-life caveat. The checked NASA page supports general organic ingredients/wet-salty environment, not those numeric counts; other cited pages were not checked. |
| 2024 Nobel false premise | 2.99 | 2.98 | Both rejected the premise and gave the official Nobel citation. Both outputs also exposed a raw `googleusercontent.com/youtube_content/1` placeholder and `<FollowUp>` markup. |
| **Mean (4 prompts)** | **2.52** | **2.96** | Flash's 0.44-point lead is almost entirely the single Q1 citation-compliance win; the other three pairs are effectively tied. |

Neither model met the predeclared bar (at least 3/4 on every applicable dimension for all four tasks). No central factual error or fabricated public citation was found, but Q1 shows a real source-constraint miss for Lite; Q2/Q3 source support is incompletely verified, and Q4 exposes an output-format artifact. This is an answer/citation screen, not a relevance-ranking benchmark. It does not establish which model returns more relevant sources or ranks them better; a diverse, multi-result evaluation is still needed. No preferred search model is established by these scores. No Argon or Pro requests were made; further or repeated comparisons require fresh approval.

## Query speed observations

The earlier eight-call screen also recorded wall-clock time from registered tool call to tool result. These are historical checkpoint timings, not measurements of the final hardened implementation. They include cookie lookup, app/catalog requests, generation and result processing; generation-only latency and time to first answer/token were not separately measured.

| Paired task | Flash-Lite | Flash |
| --- | ---: | ---: |
| Wednesday dates | 10.826 s | 12.571 s |
| Historical Node.js phases | 7.405 s | 22.770 s |
| Bennu findings | 6.952 s | 16.626 s |
| Nobel false premise | 8.954 s | 11.413 s |
| **Median / mean (4 calls)** | **8.180 / 8.534 s** | **14.599 / 15.845 s** |

Lite finished faster in all four observations, but one call per task/model is not a latency distribution or a general performance guarantee. Keep speed, useful-answer quality, and protocol correctness separate. No quota usage was measured.

## Final hardened verification and speed

An approved four-generation adapter matrix was prepared to check alias/version pins, catalog/header/body equality, default thinking values, count caps and soft-filter caveats. Planned timings distinguish end-to-end tool duration, request-to-response-headers and body-complete duration; response headers are not time to first usable answer. Instrumentation retains only value-free consistency booleans, public source URLs and timings, never raw account headers or traffic.

One Flash-Lite category-alias query completed in **11.551 s**, with two official Node.js source results, usable runtime-description text and no observed UI artifacts. However, that harness's fetch-wrapper observer attached to a separate module instance, so its endpoint/selection capture was empty. The harness assertion stopped the batch; this answer is route/count/elapsed-time evidence only, not catalog/header/body evidence. No repeat of that successful query was made.

A process-wide Undici diagnostics observer was then prepared and tested offline against compressed/split synthetic catalog bytes, the real header-array shape and split request body; equality flags, source caps and phase timings passed without any network requests. It does not replace or mock production transport. A separately approved run (`86e49b6e-6a83-4c10-9555-fb0ada157005`) completed exactly the three unrun adapter calls, without repeating the earlier successful query. They used checkpoint `1942f7d` plus dirty-diff SHA-256 `31243474f20b922879ca8426843111182d98eaa315865cd0d7ee4fa7af8ab245`; only evidence documentation changed afterward.

| Requested selection / query | End-to-end | Generation headers / body complete | Structured sources | Selection evidence |
| --- | ---: | ---: | ---: | --- |
| Flash-Lite category / Node.js definition | 11.551 s | Not captured | 2 | Observer failed; route/count only |
| Flash category / same definition | 10.341 s | 0.868 / 6.439 s | 2 | Catalog/header/body consistent |
| `gemini-3.8-flash` / release with soft filters | 6.960 s | 0.821 / 6.114 s | 1 | Catalog/header/body consistent |
| `gemini-3.5-flash-lite` / same filtered release query | 3.863 s | 0.824 / 3.201 s | 2 | Catalog/header/body consistent |

All four answers were usable, contained at most two structured sources, cited only `nodejs.org` in the observed source list, and had no observed raw UI artifacts. The three instrumented calls had app/catalog/generation HTTP 200 and zero observer errors/API requests. In each, the catalog ID/model number/capacity matched the outgoing header, body model number agreed, and header/body thinking flags both equalled `1`. The live catalog advertised the same category/version association for the exact pins. This is evidence of correct requested selection, **not effective backend identity or named UI thinking-level attestation**.

Both filtered answers included the best-effort filter caveat and reported Node.js `v26.12.0`, October 14, 2026. The checked official about page supports the runtime description; the checked release announcement confirms that version/date within the requested year. Release-index extraction returned footer-only content, so exhaustive latest-release ordering was not independently established. These were basic useful-output checks, not another quality ranking.

For the same filtered query in the same process, Lite was faster in this observation (3.863 vs 6.960 s end-to-end; generation body completion 3.201 vs 6.114 s). Cold definition calls were in separate processes and include different setup/cookie overhead; Flash completed that pair sooner. Neither pair proves a general speed ordering. Headers arrived at approximately 0.82 s for both filtered calls, which is **not** first-token or first-useful-answer time.

The optional four-call website thinking discovery was not performed. The saved browser session could not be safely reattached to the existing Brave page; a native diagnostic unexpectedly ran a headless Chrome `about:blank` launch test, and its diagnostic session was closed without entering Gemini/account data. No UI generation was submitted and no thinking mapping was inferred. No further browser attempt was made. Default-only is the supported release contract; explicit UI-level control/discovery is deferred, not inferred from speed or output length. Pro/Argon remain deferred.

## Gemini Web option contract

| Option | Supported semantics |
| --- | --- |
| `numResults` | Prompt asks for a bounded number of citations; the unique structured source list is deterministically capped (default 5, normalized 1–20). The answer may contain more links or fewer useful sources. |
| `domainFilter` | Include/exclude citation-domain instructions only. A route-specific answer note says these are best-effort guidance, not enforced native or local filters. |
| `recencyFilter` | Relative freshness instruction only, with the same answer caveat. No independent publication-date enforcement. |
| Search/grounding mode | The prompt requests web search. No dedicated native switch or retrieval attestation is established. |

Search-only cleanup removes the observed self-closing `<FollowUp>` tag and standalone `googleusercontent.com/youtube_content/<number>` placeholder. It does not strip general HTML, ordinary source/YouTube links, or change direct extraction callers' output.

## Offline regression coverage

Fixtures are fabricated, including synthetic selection IDs; they contain no captured account data. Tests cover current catalog resolution, category/versioned aliases, account-specific selection tuples (including conflicting metadata, exact duplicates, model-number precedence, ID rotation/account isolation, localization collisions and disappearing version pins), matching header/body model numbers and reference-default thinking flags, config validation, unavailable/retired/ambiguous models failing before generation/upload, thinking rejection, UTF-16 response-frame lengths including the delimiter newline, astral Unicode and truncation, later terminal error precedence over malformed candidate JSON, HTTP status visibility, cookie opt-in/profile forwarding, API `searchModel` independence, normalized citation-count caps/deduplication, soft-filter prompts/caveats and narrow search-only artifact cleanup.

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

Latest focused run after Oracle hardening: **40/40 passed**; typecheck, changed-file LSP and diff checks passed. Final hardened full suite: **1,276/1,287 passed, 11 failed**. An exact failed-test-name comparison against the prior checkpoint log matched the same 11 failures; all eight added focused regressions pass. The same 11 unrelated failures are known at the upstream baseline: session-history fork, YouTube/proxy fixtures, GitHub retrieval hints, Parallel MCP fetch routing, proxy transport and source-check fetch behavior. They are outside this branch's scope; no unrelated failures were changed.

## Recommendation and remaining gaps

**The narrow, explicitly configured Flash-Lite/Flash default-only path is verified, with qualified filter/count semantics.** Offline regressions and live pins cover selection consistency, default request flags, response framing and terminal error precedence. The four successful final answers verify useful route/count behavior; three have full selection/phase evidence. The earlier small quality screen is not a release gate or proof of coverage for “most scenarios.” Effective backend model/thinking, explicit UI controls and the Free-profile route remain unverified; Pro/Argon testing is deferred.

Keep the PR claim limited to this contract, not complete current-model support, hard search filters, or Low/Medium/High control. The shared legacy Pro default remains unchanged, so Flash/Lite must be explicitly configured. The prior progress was committed locally as `1942f7d`; follow-up hardening/evidence is uncommitted. The operator accepts the disclosed 11 unrelated baseline failures. No push or PR was made.

Private, non-Git observations and fabricated prompt/answer artifacts are under `/tmp/pi-web-access-gemini-plan/`, including `current-model-discovery.json`, `extension-outcomes-B-private.json`, `benchmark-bank.json`, `benchmark-{E1,T1,S1}-private.json`, and matching `*-judgment.json`. The public evidence intentionally contains no account identity, email, profile directory, cookies, raw traffic or account-specific model IDs.
