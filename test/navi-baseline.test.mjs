import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { corpusPath, runBaseline, validateCorpus } from "../scripts/navi-baseline.mjs";

const load = () => JSON.parse(readFileSync(corpusPath, "utf8"));

test("bilingual corpus keeps paired translations in one split and declares evidence rubrics", () => {
	const corpus = validateCorpus(load());
	assert.equal(corpus.cases.length, 16);
	for (const split of ["development", "holdout"]) for (const lane of ["stable", "fresh"]) {
		assert.ok(corpus.cases.some(item => item.split === split && item.lane === lane));
	}
	const leaked = load(); leaked.cases[1].split = "holdout";
	assert.throws(() => validateCorpus(leaked), /split leakage/);
	const duplicate = load(); duplicate.cases[1].id = duplicate.cases[0].id;
	assert.throws(() => validateCorpus(duplicate), /Invalid/);
});

test("baseline is reproducible, keeps holdout opt-in and labels missing measurements", () => {
	const options = { now: "2026-10-24T00:00:00Z" };
	const report = runBaseline(load(), options);
	assert.deepEqual(report, runBaseline(load(), options));
	assert.equal(report.results.length, 12);
	assert.equal(report.measuredRetrieval, false);
	assert.equal(runBaseline(load(), { split: "holdout" }).results.length, 4);
	for (const result of report.results) {
		assert.equal(result.jev.status, "skipped");
		assert.equal(result.costUsd, null);
		assert.equal(result.retrievalScore, null);
		for (const plan of Object.values(result.plans)) {
			assert.ok(plan.providers.length <= 2);
			assert.ok(!plan.providers.includes("fixture-unavailable"));
			assert.deepEqual(plan.limits, report.config.limits);
		}
	}
	assert.throws(() => runBaseline(load(), { split: "all" }), /Invalid/);
});
