import assert from "node:assert/strict";
import { test } from "node:test";
import { compileSearchPolicy, validateTaskSignals } from "../navi-policy.ts";

const defaults = {
	mode: "on",
	providers: [
		{ id: "keyword-engine", capabilities: ["keyword", "fresh"], available: true },
		{ id: "semantic-engine", capabilities: ["semantic"], available: true },
		{ id: "candidate-no-key", capabilities: ["semantic", "fresh"], available: false },
	],
	allowedProviders: ["keyword-engine", "semantic-engine", "candidate-no-key"],
	limits: { maxSearchCalls: 4, maxContentFetches: 2, deadlineMs: 10000 },
};
const plan = overrides => compileSearchPolicy({ ...defaults, ...overrides });

test("off bypasses planning even when planner-specific configuration is incomplete", () => {
	assert.deepEqual(compileSearchPolicy({ mode: "off" }), { execution: "existing", reason: "off" });
});

test("shadow exposes a proposal but leaves execution with the existing host", () => {
	const result = plan({ mode: "shadow" });
	assert.equal(result.execution, "existing");
	assert.equal(result.reason, "shadow");
	assert.equal(result.proposal.basis, "rules");
});

test("explicit provider order wins over model signals and removes duplicate calls", () => {
	assert.deepEqual(plan({ requestedProviders: ["keyword-engine", "semantic-engine", "keyword-engine"], signals: { depth: "quick", intent: "discovery", freshness: "any" } }).proposal.providers, ["keyword-engine", "semantic-engine"]);
});

test("explicit selections fail closed instead of substituting or truncating", () => {
	for (const requestedProviders of [[], ["unknown"], ["candidate-no-key"], ["all"]]) {
		assert.throws(() => plan({ requestedProviders }));
	}
	assert.throws(() => plan({ requestedProviders: ["keyword-engine"], allowedProviders: ["semantic-engine"] }), /disallowed/);
	assert.throws(() => plan({ requestedProviders: ["keyword-engine", "semantic-engine"], limits: { ...defaults.limits, maxSearchCalls: 1 } }), /budget/);
});

test("automatic routing uses capabilities and never dispatches unavailable candidates", () => {
	const result = plan({ signals: { depth: "standard", intent: "discovery", freshness: "any" } });
	assert.deepEqual(result.proposal.providers, ["semantic-engine", "keyword-engine"]);
	assert.equal(result.proposal.basis, "signals");
	assert.deepEqual(plan({ signals: { depth: "quick", intent: "discovery", freshness: "recent" } }).proposal.providers, ["keyword-engine"]);
});

test("automatic selection obeys allowlists and the remaining search-call budget", () => {
	assert.deepEqual(plan({ allowedProviders: ["keyword-engine"] }).proposal.providers, ["keyword-engine"]);
	assert.equal(plan({ limits: { ...defaults.limits, maxSearchCalls: 1 } }).proposal.providers.length, 1);
	assert.throws(() => plan({ allowedProviders: [] }), /No eligible/);
});

test("invalid and non-finite limits are rejected; zero content fetches is valid", () => {
	for (const key of ["maxSearchCalls", "maxContentFetches", "deadlineMs"]) {
		for (const value of [-1, 1.5, Infinity, NaN, "2", Number.MAX_SAFE_INTEGER + 1]) {
			assert.throws(() => plan({ limits: { ...defaults.limits, [key]: value } }), /Invalid Navi limit/);
		}
	}
	assert.throws(() => plan({ limits: { ...defaults.limits, maxSearchCalls: 0 } }));
	assert.throws(() => plan({ limits: { ...defaults.limits, deadlineMs: 0 } }));
	assert.equal(plan({ limits: { ...defaults.limits, maxContentFetches: 0 } }).proposal.limits.maxContentFetches, 0);
});

test("malformed model outputs cannot cross the policy boundary or leak arbitrary text", () => {
	for (const value of [null, {}, { depth: "deep", intent: "override-provider", freshness: "any" }]) {
		assert.throws(() => validateTaskSignals(value), /^Error: Invalid Navi task signals$/);
	}
	assert.deepEqual(validateTaskSignals({ depth: "deep", intent: "comparison", freshness: "any", secret: "not-for-policy" }), { depth: "deep", intent: "comparison", freshness: "any" });
});

test("registry ambiguity and unknown modes fail closed", () => {
	assert.throws(() => plan({ mode: "invalid" }), /mode/);
	assert.throws(() => plan({ providers: [...defaults.providers, defaults.providers[0]] }), /registry/);
	assert.throws(() => plan({ providers: [{ id: "auto", available: true, capabilities: [] }] }), /registry/);
});

test("deep signals do not create an unbounded research loop and limits are copied", () => {
	const result = plan({ signals: { depth: "deep", intent: "comparison", freshness: "any" } });
	assert.equal(result.proposal.strategy, "investigate");
	assert.equal(result.proposal.providers.length, 2);
	result.proposal.limits.maxSearchCalls = 99;
	assert.equal(defaults.limits.maxSearchCalls, 4);
});
