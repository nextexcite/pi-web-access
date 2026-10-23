# Navi roadmap

Navi is a standalone agent-facing search and evidence service. The first deliverable is a Pi extension, developed in this fork before the validated core is exposed as a service.

Planning source: [Linear project](https://linear.app/tianjis/project/navi-agent-facing-search-and-evidence-364ca217a2e8).

## Baseline and ownership

Start from `custom` at `fe31a5e19fdff42d4da8e8ceeafd8ed7c728a190`, which includes upstream v0.44.0 (`d0e323a`) and existing fork customizations. `main` is an upstream mirror, not the customization baseline. Feature PRs target `custom`; preserve existing dedicated X Search, gateway safeguards and Pi/MCP credential isolation.

## Outcomes and sequence

### M0 · Baseline and service boundaries

Audit the current public fork and applicable instructions; record upstream/base commit and integration seams. Establish host-neutral policy/decision contracts, redacted trace schema, a bilingual seed workload and repeatable baseline commands. Gate: contracts preserve explicit providers and hard limits; fixtures are clearly distinguished from live evidence; branch and review are linked.

### M1 · Pi extension alpha

Ship opt-in off/shadow/on routing through Pi, starting with Jev plus deterministic fallback. Support a small complementary provider portfolio, missing-key diagnostics, deadlines/cancellation and provenance-preserving fusion. Gate: installable extension passes existing relevant regressions, handles decision-provider failure, preserves explicit overrides and completes live smoke tests with available credentials. This is the first user-facing deliverable.

### M2 · Measured routing quality

Build stable, fresh and daily-use evaluation lanes. Compare upstream, fixed portfolios, rules and Jev under matched budgets; separate retrieval quality from final-agent correctness. Ablate rewriting, routing, fusion and fetching. Gate: held-out evaluation report supports default-policy choices and documents regressions, p50/p95 latency, failures and known/unknown cost. Shadow logs alone cannot demonstrate regret.

### M3 · Evidence-aware retrieval

Add conservative canonicalization, provenance-preserving fusion, bilingual passage extraction, source assessment and bounded gap-driven fetching/escalation. Gate: gains on difficult technical tasks without hidden research loops; duplicate pages are not counted as independent corroboration; unsupported or conflicting claims remain explicit.

### M4 · Delegated research contract

Expose a distinct delegated-research operation with question, evidence requirements, budget, cancellation, coverage, citations and unresolved gaps. Gate: demonstrable advantage on multi-step work over low-level search loops; the calling agent controls delegation and stopping limits.

### M5 · Standalone agent-facing service

Deliver the committed service destination using the same validated core, with versioned HTTP/MCP interfaces, explicit credential ownership, authentication, resource isolation, deployment/runbook and observability. Gate: Pi plus an independent agent client pass the same contract suite; restart/failure behavior and usage attribution are verified. Select hosting and persistence from actual operational needs.

### M6 · Additional decision engines and measured adaptation

Integrate user-introduced decision engines (OpenAI Decisions / Cloudflare Clef candidates) behind the validated interface after current API verification. Calibrate outcomes; consider learned policies only with sufficient representative data and logged selection probabilities. Gate: held-out engine comparisons, engine-independent contracts and evidence that adaptation outperforms simpler policies.

## Immediate work

| Issue | Deliverable |
| --- | --- |
| NAV-1 | Charter, roadmap, host-neutral policy foundation and regression tests |
| NAV-2 | Bilingual evaluation corpus and reproducible baseline runner |
| NAV-3 | Provider capability and credential-readiness inventory |
| NAV-4 | Jev adapter with protocol verification and validated typed output |
| NAV-5 | Pi/shared-core integration with off/shadow/on modes and execution budgets |
| NAV-6 | Provenance-preserving fusion and redacted traces |
| NAV-12 | Native Linear/GitHub connection and branch/PR linkage |

Later outcome epics NAV-7 through NAV-11 track evaluation, evidence gaps, delegated research, standalone service delivery and additional decision engines. Calendar targets remain unset until baseline work establishes reasonable estimates.

## Workloads and evaluation

Start with English/Chinese API lookup, documentation/source discovery, release freshness and architectural comparisons. Preserve stable regressions separately from fresh research tasks; keep a held-out set and capture daily-use corrections. Required evidence and grading rubrics precede benchmark claims.

Compare upstream, fixed complementary portfolios, rules and Jev under matched execution budgets. Measure retrieval and same-model final-agent outcomes separately. Ablate routing, query adaptation, fusion and fetching. Record unknown cost as unknown, not zero. An unexecuted shadow policy cannot establish counterfactual success.

## Provider and decision-engine policy

Provider candidates are not restricted to services with existing API keys. Candidate selection, implemented adapters, operational availability and live validation are separate states. Credentials gate live tests only. Fixtures do not certify provider availability, quality or integration correctness.

Jev is the first decision engine. OpenAI Decisions and Cloudflare Clef are future candidates supplied by the owner; verify their current API contracts before adding adapters. The core must not embed vendor request schemas or credentials. No additional subscriptions or paid test campaigns are authorized by this roadmap alone.

## Boundaries

Ordinary search assistance is bounded retrieval. Multi-step delegated research has an explicit separate request contract and ownership of its budget. Caller overrides, allowlists, cancellation and total budgets remain authoritative. Retrieved material cannot grant execution authority. Provenance survives fusion, and decision confidence is never presented as verified evidence confidence.

Do not build a generic orchestration platform, multi-tenant billing, custom model training or learned bandit policy before evidence supports that investment. Hosting choice is deferred; the standalone service destination is committed.

