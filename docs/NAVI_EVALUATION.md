# Navi evaluation starter

The first artifact is an offline planner baseline. It is a reproducibility and contract check, not evidence that Jev or any provider improves research. NAV-2 remains open until a retrieval runner, provenance/rank capture and grading are implemented.

## Corpus

`eval/navi/corpus-v1.json` contains 16 authored tasks: eight English/Chinese pairs covering API lookup, release freshness, source discovery and architectural comparisons. Twelve cases are development examples; four are a reserved holdout with both stable and fresh lanes. Translations stay in the same split to avoid leakage. The holdout is public and visible during implementation, so it is a reserved regression split, not a blind benchmark; independently authored unseen cases are needed for an unbiased evaluation.

Each case supplies expected task signals, required evidence and an answer rubric. Labels are initial judgments awaiting human adjudication. They do not contain a claimed correct research answer. Fresh cases require an as-of date and newly retrieved official evidence rather than a hard-coded latest version. Changing criteria or adjudicated labels requires a versioned corpus and comparison against the previous version.

## Reproducible offline run

```sh
node scripts/navi-baseline.mjs --split development --lane all
node scripts/navi-baseline.mjs --split holdout --lane fresh
```

The JSON report includes corpus hash/version, question version, timestamp, selection, provider fixture registry and identical execution ceilings. It compares rules, a fixed portfolio and a label-driven oracle control. The oracle feeds authored labels into the planner; it never masquerades as a Jev prediction. Fixtures have no real provider names or credentials. Unavailable fixture providers are excluded.

Upstream and Jev execution are explicitly skipped. Ranks, provenance, retrieval/answer scores, latency and cost are `null`, because nothing is retrieved. A successful process exit means a valid planning report was produced. It does not mean a provider responded or that an answer was correct. There is no live flag and no environmental key loading.

## Remaining baseline work

Add an explicitly authorized live/recorded execution lane for upstream, fixed portfolio, rules and Jev. The run manifest must identify code revision, exact decision model, corpus/question versions, provider configuration without secrets, run timestamp and shared budget. Pin final-answer model/prompts when grading end-to-end outcomes.

Persist ranked results with original URL, canonical URL, provider attribution, retrieval time and passage references. Capture actual calls, failures/skips, decision latency, search latency, total latency and known/unknown cost. Missing credentials must be skips, never empty-result successes; zero measured outcomes must not yield a success percentage.

Grade required-evidence coverage and citation support separately from final-answer correctness. Report English/Chinese and stable/fresh strata, p50/p95 latency, failures and paired task differences. Separate routing, rewriting, fusion and content-fetch ablations. Compare quality under matched call/cost ceilings; do not infer counterfactual quality from shadow logs. Run held-out comparisons only after tuning on the development split and review ambiguous labels before selecting defaults.
