import assert from "node:assert/strict";
import { test } from "node:test";
import { createJevDecisionEngine } from "../navi-jev.ts";
import { classifyWithFallback } from "../navi-decision.ts";
import { compileSearchPolicy } from "../navi-policy.ts";

const signals = { depth: "standard", intent: "comparison", freshness: "recent" };
const responseBody = () => ({ model: "fixture", answers: Object.fromEntries(Object.entries(signals).map(([key, choice]) => [key, { type: "choice", choice, confidence: 0.9 }])), usage: { input_tokens: 1, output_tokens: 1 } });
const input = () => ({ query: "比较当前的 API", signal: new AbortController().signal });
const engine = (overrides = {}) => createJevDecisionEngine({ getApiKey: async () => "fixture-key", fetch: async () => Response.json(responseBody()), ...overrides });
const errorCode = code => error => {
	assert.equal(error.code, code);
	assert.equal(error.message, `Navi Jev decision failed: ${code}`);
	assert.equal(error.cause, undefined);
	return true;
};

test("Jev sends one typed request with host-injected model, endpoint and credentials", async () => {
	let calls = 0;
	const adapter = engine({ endpoint: "https://gateway.example.test/jev/v1/systemone", model: "pinned-fixture-model", fetch: async (url, init) => {
		calls++;
		assert.equal(url, "https://gateway.example.test/jev/v1/systemone");
		assert.equal(init.method, "POST");
		assert.equal(init.redirect, "error");
		assert.equal(init.headers.Authorization, "Bearer fixture-key");
		assert.equal(init.headers["Content-Type"], "application/json");
		const body = JSON.parse(init.body);
		assert.equal(body.model, "pinned-fixture-model");
		assert.deepEqual(body.state, { query: input().query });
		assert.deepEqual(Object.keys(body.questions), ["depth", "intent", "freshness"]);
		for (const [key, question] of Object.entries(body.questions)) {
			assert.equal(question.type, "choice");
			assert.ok(signals[key] in question.criteria);
		}
		return Response.json({ ...responseBody(), secret: "discard", providers: ["override"] });
	} });
	assert.equal(adapter.id, "jev");
	assert.deepEqual(await adapter.classify(input()), signals);
	assert.equal(calls, 1);
});

test("rejects invalid trusted configuration without reflecting it", () => {
	for (const endpoint of ["bad-secret", "http://remote.test", "https://user:secret@example.test", "https://example.test?secret=1", "https://example.test#secret", "https://example.test?", "file:///secret"]) {
		assert.throws(() => engine({ endpoint }), errorCode("configuration"));
	}
	for (const timeoutMs of [0, -1, 1.5, Infinity, 60_001]) assert.throws(() => engine({ timeoutMs }), errorCode("configuration"));
	assert.throws(() => engine({ model: " " }), errorCode("configuration"));
});

test("missing keys and invalid queries do not send a request", async () => {
	let calls = 0;
	const fetch = async () => { calls++; throw new Error("unexpected"); };
	await assert.rejects(engine({ getApiKey: async () => null, fetch }).classify(input()), errorCode("unavailable"));
	for (const query of ["", " ", "中".repeat(11_000)]) {
		await assert.rejects(engine({ fetch }).classify({ ...input(), query }), errorCode("query"));
	}
	assert.equal(calls, 0);
});

test("malformed or missing choices cannot enter the policy", async () => {
	const wrongType = responseBody(); wrongType.answers.depth.type = "score";
	const wrongChoice = responseBody(); wrongChoice.answers.intent.choice = "secret-override";
	for (const body of [null, [], {}, { answers: {} }, wrongType, wrongChoice]) {
		await assert.rejects(engine({ fetch: async () => Response.json(body) }).classify(input()), errorCode("response"));
	}
	await assert.rejects(engine({ fetch: async () => new Response("secret malformed JSON") }).classify(input()), errorCode("response"));
	await assert.rejects(engine({ fetch: async () => new Response(null) }).classify(input()), errorCode("response"));
});

test("transport, credential failures and HTTP bodies never expose raw details or retry", async () => {
	await assert.rejects(engine({ getApiKey: async () => { throw new Error("credential-secret"); } }).classify(input()), errorCode("transport"));
	await assert.rejects(engine({ fetch: async () => { throw new Error("https://private.test key=secret"); } }).classify(input()), errorCode("transport"));
	for (const status of [301, 307, 401, 429, 500]) {
		let calls = 0, cancelled = false;
		await assert.rejects(engine({ fetch: async () => {
			calls++;
			return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { location: "https://private.test" } });
		} }).classify(input()), errorCode("http"));
		assert.equal(calls, 1);
		assert.equal(cancelled, true);
	}
});

test("response limit measures actual bytes and cancels oversized bodies", async () => {
	let cancelled = false;
	await assert.rejects(engine({ fetch: async () => new Response(new ReadableStream({ start(controller) {
		controller.enqueue(new Uint8Array(65_537));
	}, cancel() { cancelled = true; } }), { headers: { "content-length": "1" } }) }).classify(input()), errorCode("response"));
	assert.equal(cancelled, true);
});

test("deadline covers credential resolution, transport and stalled response bodies", async () => {
	const never = () => new Promise(() => {});
	await assert.rejects(engine({ timeoutMs: 15, getApiKey: never }).classify(input()), errorCode("timeout"));
	await assert.rejects(engine({ timeoutMs: 15, fetch: never }).classify(input()), errorCode("timeout"));
	let cancelled = false;
	await assert.rejects(engine({ timeoutMs: 15, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) }).classify(input()), errorCode("timeout"));
	assert.equal(cancelled, true);
});

test("caller cancellation is sanitized before dispatch and while reading a body", async () => {
	const before = new AbortController(); before.abort(new Error("secret reason"));
	let called = false;
	await assert.rejects(engine({ fetch: async () => { called = true; } }).classify({ query: "query", signal: before.signal }), errorCode("cancelled"));
	assert.equal(called, false);
	const during = new AbortController();
	const adapter = engine({ fetch: async () => new Response(new ReadableStream({ start() { queueMicrotask(() => during.abort("secret")); } })) });
	await assert.rejects(adapter.classify({ query: "query", signal: during.signal }), errorCode("cancelled"));
});

test("decision failures produce a rules proposal; classified signals reach the same compiler", async () => {
	const policy = { mode: "on", providers: [{ id: "fixture", capabilities: ["keyword"], available: true }], allowedProviders: ["fixture"], limits: { maxSearchCalls: 1, maxContentFetches: 0, deadlineMs: 100 } };
	for (const candidate of [undefined, { id: "broken", classify: async () => { throw new Error("secret"); } }, { id: "malformed", classify: async () => ({}) }]) {
		const outcome = await classifyWithFallback({ ...input(), engine: candidate, timeoutMs: 100 });
		assert.equal(outcome.status, "rules");
		assert.equal(compileSearchPolicy({ ...policy, signals: outcome.signals }).proposal.basis, "rules");
	}
	const outcome = await classifyWithFallback({ ...input(), engine: engine(), timeoutMs: 100 });
	assert.deepEqual(outcome, { status: "classified", signals });
	assert.equal(compileSearchPolicy({ ...policy, signals: outcome.signals }).proposal.basis, "signals");
});

test("generic decision boundary bounds any engine and propagates cancellation without fallback", async () => {
	let seenSignal;
	const hanging = { id: "hanging", classify: ({ signal }) => { seenSignal = signal; return new Promise(() => {}); } };
	assert.deepEqual(await classifyWithFallback({ ...input(), engine: hanging, timeoutMs: 15 }), { status: "rules", reason: "timeout" });
	assert.equal(seenSignal.aborted, true);
	const controller = new AbortController();
	const pending = classifyWithFallback({ query: "query", signal: controller.signal, engine: hanging, timeoutMs: 100 });
	controller.abort("secret");
	await assert.rejects(pending, error => error.name === "AbortError" && error.message === "Navi decision cancelled");
	await assert.rejects(classifyWithFallback({ ...input(), timeoutMs: Infinity }), /Invalid Navi decision timeout/);
});
