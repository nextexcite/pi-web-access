import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNaviConfig, runNaviSearch } from "../navi-runtime.ts";

const registry = () => [
	{ id: "brave", capabilities: ["keyword", "fresh"], available: true },
	{ id: "exa", capabilities: ["semantic", "fresh"], available: true },
	{ id: "tavily", capabilities: ["keyword", "fresh"], available: false },
];
const config = extra => parseNaviConfig({ mode: "on", ...extra });
const request = extra => ({ config: config(), queries: ["query"], requested: "auto", allowed: ["brave", "exa", "tavily"], options: {}, includeContent: false, ...extra });
const response = provider => ({ provider, answer: provider, results: [{ url: `https://example.test/${provider}`, title: provider, snippet: provider }] });
const dependencies = extra => ({ registry, fetchPages: async () => [], search: async (_query, options) => { options.beforeSearchRequest(); return response(options.provider); }, ...extra });

test("mode is default off and ignores unused settings, enabled configuration is bounded", () => {
	assert.equal(parseNaviConfig(undefined), undefined);
	assert.equal(parseNaviConfig({ mode: "off", limits: "invalid", decision: { apiKey: "!must-not-run" } }), undefined);
	for (const value of [{ mode: "bad" }, { mode: "on", providers: ["unknown"] }, { mode: "on", limits: { deadlineMs: Infinity } }, { mode: "on", limits: { maxSearchCalls: 0 } }, { mode: "on", decision: { engine: "unknown" } }]) assert.throws(() => parseNaviConfig(value));
});

test("shadow classifies and plans without any provider or content execution", async () => {
	let classifications = 0;
	const out = await runNaviSearch(request({ config: config({ mode: "shadow" }), includeContent: true }), dependencies({
		engine: () => ({ id: "fixture", classify: async () => { classifications++; return { depth: "quick", intent: "lookup", freshness: "any" }; } }),
		search: async () => { throw new Error("shadow must not execute"); },
		fetchPages: async () => { throw new Error("shadow must not fetch"); },
	}));
	assert.equal(classifications, 1);
	assert.deepEqual(out.trace.plans[0].providers, ["brave"]);
	assert.equal(out.trace.status, "shadow");
	assert.equal(out.trace.searchAttempts, 0);
	assert.deepEqual(out.results, []);
	const failed = await runNaviSearch(request({ config: config({ mode: "shadow" }), requested: "all" }), dependencies());
	assert.equal(failed.trace.status, "shadow-error");
	const bounded = await runNaviSearch(request({ config: config({ mode: "shadow", limits: { maxSearchCalls: 1 } }), queries: ["a", "b"] }), dependencies());
	assert.equal(bounded.trace.plans.flatMap(plan => plan.providers).length, 1);
	assert.equal(bounded.trace.searchAttempts, 0);
	assert.equal(bounded.trace.status, "shadow-error");
});

test("explicit selections retain order and bypass decision engine creation", async () => {
	const order = [];
	const out = await runNaviSearch(request({ requested: ["brave", "exa", "brave"] }), dependencies({
		engine: () => { throw new Error("must not instantiate"); },
		search: async (_query, options) => { options.beforeSearchRequest(); order.push(options.provider); assert.equal(options.providerFromConfig, false); assert.equal(options.includeContent, false); return response(options.provider); },
	}));
	assert.deepEqual(order, ["brave", "exa"]);
	assert.equal(out.trace.plans[0].decision, "bypassed-explicit");
	assert.deepEqual(out.results[0].providers, order);
});

test("explicit over-budget, unsupported, unavailable and disallowed requests fail before dispatch", async () => {
	let calls = 0;
	for (const extra of [
		{ queries: ["a", "b", "c"], requested: ["brave", "exa"] },
		{ requested: "all" }, { requested: "xai" }, { requested: "tavily" }, { requested: "brave", allowed: ["exa"] },
	]) {
		const out = await runNaviSearch(request(extra), dependencies({ search: async () => { calls++; } }));
		assert.ok(out.results.every(result => result.error));
		assert.equal(out.trace.searchAttempts, 0);
	}
	assert.equal(calls, 0);
});

test("one request budget covers all queries and retry attempts, with partial failures visible", async () => {
	let requests = 0;
	const out = await runNaviSearch(request({ config: config({ limits: { maxSearchCalls: 3 } }), queries: ["a", "b", "c"] }), dependencies({ search: async (_query, options) => {
		for (let attempt = 0; attempt < 2; attempt++) { options.beforeSearchRequest(); requests++; }
		return response(options.provider);
	} }));
	assert.equal(requests, 3);
	assert.equal(out.trace.searchAttempts, 3);
	assert.equal(out.trace.partial, true);
	assert.equal(out.results.length, 3);
	assert.equal(out.results[0].error, null);
	assert.ok(out.results[1].error && out.results[2].error);
});

test("provider failures do not expose raw errors and successful work survives a deadline", async () => {
	const started = Date.now();
	const out = await runNaviSearch(request({ config: config({ limits: { deadlineMs: 30 } }) }), dependencies({ search: async (_query, options) => {
		options.beforeSearchRequest();
		if (options.provider === "brave") return new Promise(() => {});
		return response(options.provider);
	} }));
	assert.ok(Date.now() - started < 500);
	assert.equal(out.trace.deadlineReached, true);
	assert.equal(out.trace.partial, true);
	assert.equal(out.results[0].error, null);
	const failed = await runNaviSearch(request({ requested: "brave" }), dependencies({ search: async (_query, options) => { options.beforeSearchRequest(); throw new Error("secret endpoint credential"); } }));
	assert.doesNotMatch(JSON.stringify(failed), /secret endpoint credential/);
});

test("content jobs share request deadline and fetch ceiling; skipped URLs get stored error entries", async () => {
	const fetched = [];
	const out = await runNaviSearch(request({ config: config({ limits: { maxContentFetches: 1 } }), includeContent: true }), dependencies({ fetchPages: async ([url]) => { fetched.push(url); return [{ url, title: "page", content: "body", error: null }]; } }));
	assert.equal(fetched.length, 1);
	assert.equal(out.trace.contentFetches, 1);
	assert.equal(out.content.length, 2);
	assert.equal(out.content[0].error, null);
	assert.match(out.content[1].error, /limit/);
	const stalled = await runNaviSearch(request({ requested: "brave", config: config({ limits: { deadlineMs: 25 } }), includeContent: true }), dependencies({ fetchPages: async () => new Promise(() => {}) }));
	assert.equal(stalled.trace.deadlineReached, true);
	assert.ok(stalled.content[0].error);
});

test("caller cancellation propagates and separate concurrent requests have independent budgets", async () => {
	const controller = new AbortController();
	const pending = runNaviSearch(request({ signal: controller.signal }), dependencies({ search: async (_query, options) => { options.beforeSearchRequest(); controller.abort("private reason"); return new Promise(() => {}); } }));
	await assert.rejects(pending, error => error.name === "AbortError" && error.message === "Navi request cancelled");
	const runs = await Promise.all([1, 2].map(() => runNaviSearch(request({ config: config({ limits: { maxSearchCalls: 1 } }) }), dependencies())));
	assert.deepEqual(runs.map(run => run.trace.searchAttempts), [1, 1]);
});

test("the absolute deadline includes decision time; failed decisions fall back within remaining time", async () => {
	let calls = 0;
	const expired = await runNaviSearch(request({ config: config({ limits: { deadlineMs: 20 }, decision: { timeoutMs: 1000 } }) }), dependencies({
		engine: () => ({ id: "hanging", classify: () => new Promise(() => {}) }),
		search: async () => { calls++; },
	}));
	assert.equal(calls, 0);
	assert.equal(expired.trace.deadlineReached, true);
	const fallback = await runNaviSearch(request(), dependencies({ engine: () => ({ id: "failed", classify: async () => { throw new Error("private detail"); } }) }));
	assert.equal(fallback.trace.plans[0].basis, "rules");
	assert.equal(fallback.trace.plans[0].decision, "rules");
	assert.ok(fallback.results[0].results.length);
});
