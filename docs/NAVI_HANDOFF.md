# Navi CLI handoff

## Starting point

Repository: <https://github.com/nextexcite/pi-web-access>. Continue on **`feat/nav-5-pi-routing`**. It starts from `custom` at `fe31a5e` (upstream v0.44.0) and fast-forwards through the unmerged foundation/adapter dependencies. PRs target `custom`; `main` remains the upstream mirror. No owner installation/configuration was updated.

Earlier review branches:

- [PR #6](https://github.com/nextexcite/pi-web-access/pull/6), `feat/nav-1-foundation`: roadmap and pure policy contract. Initial CI passed. Codex found silent duplicate-provider deduplication; fixed at `9d8cb1e` with a budget regression and re-review requested.
- [PR #7](https://github.com/nextexcite/pi-web-access/pull/7), `feat/nav-4-jev-adapter`: isolated Jev adapter, fallback, evaluation seed and provider inventory. Initial CI passed. Codex found lost unavailable/timeout categories; fixed at `cbfb345`, including PR #6's fix, with re-review requested.
- Current branch adds the standard web_search runtime integration. Its PR includes the earlier commits until those dependencies merge. Do not rebase/force-push `custom`; resolve integration in review order and verify resulting heads.

The initial PR #8 head `a19e392` received a clean Codex review. Dependency fixes were then propagated with merge ancestry preserved; a fresh review/CI is required for the updated head. Always inspect current GitHub state rather than treating historical approval as approval of later commits.

For a fresh CLI checkout:

```sh
git clone --branch feat/nav-5-pi-routing --single-branch https://github.com/nextexcite/pi-web-access.git navi
cd navi
git status --short
cat AGENTS.md
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
```

Existing checkouts must preserve unrelated work before switching branches. Use the current branch head from Git; this document intentionally avoids embedding its own commit hash. Keep test/build artifacts off the owner's Mac per AGENTS.md. GitHub CI runs the full suite/build.

## Goal and decisions

Navi's destination is a standalone agent-facing search/evidence service; first deliverable is a Pi extension. Initial workload is bilingual technical lookup, source discovery, release freshness and architectural comparison. Jev is the first optional decision engine; future OpenAI Decisions/Clef protocols must be supplied/verified before implementation. Missing API keys do not remove candidate services from the roadmap.

Read [NAVI_ROADMAP.md](NAVI_ROADMAP.md), [NAVI_ARCHITECTURE.md](NAVI_ARCHITECTURE.md), [NAVI_PI_ALPHA.md](NAVI_PI_ALPHA.md), [NAVI_JEV.md](NAVI_JEV.md), [NAVI_EVALUATION.md](NAVI_EVALUATION.md) and [NAVI_PROVIDERS.md](NAVI_PROVIDERS.md).

This slice keeps routing at the existing shared-core seam. It does not duplicate the upstream extension or introduce a framework/service deployment. `navi-policy.ts` is pure; `navi-jev.ts` owns vendor protocol; `navi-decision.ts` contains decision failure; `navi-runtime.ts` owns config/readiness and a per-request budget; `web-tool-core.ts` formats/stores results for Pi/MCP; `index.ts` rejects incompatible summary/curator lifecycles in on.

Why only three executable providers: counting one adapter invocation was insufficient. Brave retries after 429, Tavily rotates keys, and Exa MCP can fall back from advanced to basic. The new internal `beforeSearchRequest` hook reaches each actual HTTP attempt in those adapters. It also rejects search redirects under Navi while preserving existing behavior when absent. Audit equivalent paths before adding any other provider to on.

Why content is awaited: Pi's existing background fetch does not inherit a request deadline or reservation budget. Navi on disables provider inline content, reserves bounded extraction jobs, stores errors for skipped URLs, and suppresses background fetch. The content ceiling counts URL extraction jobs, not every underlying HTTP call or billable provider unit. Do not claim a hard cost cap.

Why explicit defaults remain strict: configured/per-call arrays are resolved before Navi; they skip Jev and are dispatched as individual providers without `searchRouting` substitution. Unsupported or over-budget selections fail. Shadow uses the legacy execution path and treats hypothetical planning failures as diagnostics.

## Verified locally

Offline transport fixtures exercise both actual Pi extension registration/tool execution and standalone shared core. They cover Jev proposal/legacy-route separation, configured arrays, cross-query budgets, real adapter retry/failover hooks, redirect rejection, bounded awaited content, deadline, cancellation and independent concurrent calls. Typecheck and the focused regression suite must pass on the final published head; the current PR/Linear issue records exact counts and CI state.

Recommended focused command:

```sh
node --import ./test/isolate-env.mjs --test --test-skip-pattern='built' \
  test/navi-*.test.mjs test/search-routing.test.mjs \
  test/provider-precedence.test.mjs test/allowed-search-providers.test.mjs \
  test/x-search.test.mjs test/web-tool-core.test.mjs \
  test/proxy-request.test.mjs test/provider-api-url.test.mjs \
  test/provider-gateway-coverage.test.mjs test/brave-rate-limit.test.mjs
node scripts/navi-baseline.mjs --split development --lane all
git diff --check
```

No live paid/model/provider calls, credential-store inspection, deployment, release or npm publication was performed. The 16-task corpus and offline planner report do not prove retrieval quality. NAV-2/NAV-3 remain in progress. Installed Pi reload behavior and intended-host credential readiness remain unverified.

## Next actions for the taking-over agent

1. Inspect current GitHub heads, CI, review comments and local status. The owner explicitly instructed: always invoke `@codex review` on PRs and monitor feedback. This authorization persists for this workflow; request review on each PR, address findings, and re-request after fixes. Follow AGENTS.md's exact-head review/CI gate. Do not infer a successful review from an empty review list.
2. Address review/CI failures before merging. Keep PR #6, #7 and the current integration PR dependency order clear. Do not merge automatically without owner authorization.
3. With owner-authorized live access, qualify Jev using one non-sensitive query, record resolved model/latency, then smoke standard Pi `web_search` with rules and Jev in off/shadow/on. Verify explicit supported arrays, a tiny exhausted budget, cancellation and includeContent. Check invalid/unused settings and unrelated X Search credential isolation. Use existing credential references; never put secrets/private gateway endpoints in docs.
4. Only then update an authorized installation/reload Pi. Do not run `npm publish` or change package identity as routine delivery. Installable/live smoke is still required before marking NAV-5 fully done.
5. Continue NAV-6 provenance/fusion/redacted traces, and NAV-2 actual retrieval evaluation. Decide defaults from held-out outcomes under matched budgets, not this seed's authored labels. Audit additional providers for on and decide how to bound extraction subrequests before expanding guarantees.

## Tracking

[Linear project](https://linear.app/tianjis/project/navi-agent-facing-search-and-evidence-364ca217a2e8), team NAV. NAV-1 foundation, NAV-4 adapter and NAV-5 integration are review work; NAV-2 baseline and NAV-3 inventory have partial artifacts and remaining gates. Native Linear/GitHub connection is established (NAV-12). Linear's advertised `get_agent_context` returned `Tool not found`; repo docs and issue descriptions hold the durable handoff instead.

Suggested initial CLI prompt:

> Read AGENTS.md and docs/NAVI_HANDOFF.md, inspect the current feature branch and GitHub review/CI state, then continue NAV-5 qualification. Preserve unrelated local work and the explicit-provider/budget/cancellation invariants. Report the concrete live-access or merge authorization needed; do not treat offline fixtures as a live smoke or enable owner settings automatically.
