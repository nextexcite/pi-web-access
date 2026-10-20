import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const xaiModuleUrl = new URL("../xai-search.ts", import.meta.url).href;
const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;
const curatorPageModuleUrl = new URL("../curator-page.ts", import.meta.url).href;

async function createHome(config) {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-xai-"));
	await writeFile(join(home, "web-search.json"), JSON.stringify(config) + "\n", "utf8");
	return home;
}

function runChild(script, env) {
	const childEnv = { ...process.env };
	for (const key of [
		"PI_CODING_AGENT_DIR", "XDG_CONFIG_HOME", "XAI_API_KEY", "ANYSEARCH_API_KEY", "OPENAI_API_KEY", "BRAVE_API_KEY",
		"PARALLEL_API_KEY", "TINYFISH_API_KEY", "TAVILY_API_KEY", "JINA_API_KEY", "SERPDIVE_API_KEY", "KAGI_API_KEY", "OLLAMA_API_KEY", "SERPBASE_API_KEY", "SEARXNG_BASE_URL", "EXA_API_KEY",
		"PERPLEXITY_API_KEY", "GEMINI_API_KEY",
	]) delete childEnv[key];
	Object.assign(childEnv, env);
	return spawnSync(process.execPath, ["--input-type=module"], {
		input: script,
		encoding: "utf8",
		env: childEnv,
		maxBuffer: 2 * 1024 * 1024,
	});
}

// Responses API sources are split across `url_citation` annotations on the
// answer, raw search-call sources, and the response-level citations URL list.
function successBody() {
	return JSON.stringify({
		output: [
			{ type: "web_search_call", action: { sources: [{ url: "https://x.ai/news", title: "xAI News" }] } },
			{
				type: "message",
				content: [{
					type: "output_text",
					text: "Grok Imagine v1.5 shipped with reference images.",
					annotations: [{ type: "url_citation", url: "https://x.ai/news/grok-imagine", title: "Grok Imagine", start_index: 0, end_index: 12 }],
				}],
			},
		],
		citations: ["https://x.ai/news/grok-imagine", "https://x.ai/citation-only"],
	});
}

function xSearchBody() {
	return JSON.stringify({
		output: [
			{
				type: "x_search_call",
				action: {
					sources: [
						{ url: "https://x.com/i/status/raw", title: "Raw X post" },
						{ url: "https://x.com/i/status/annotated", title: "Raw duplicate" },
						{ ignored: true },
					],
				},
				sources: ["https://x.com/i/status/source-string"],
			},
			{
				type: "message",
				content: [{
					type: "output_text",
					text: "People are discussing the release on X.",
					annotations: [
						{ type: "url_citation", url: "https://x.com/i/status/annotated", title: "Annotated X post", start_index: 0, end_index: 6 },
						{ type: "url_citation", url: "https://x.com/i/status/answer", title: "Answer citation", start_index: 7, end_index: 15 },
					],
				}],
			},
		],
		citations: [
			"https://x.com/i/status/citation-only",
			{ url: "https://x.com/i/status/citation-object", title: "Citation object" },
			42,
		],
	});
}

test("xAI posts the verified minimal Responses body and reads citation source shapes", async () => {
	const home = await createHome({ xaiApiKey: "xai-key" });
	const child = runChild(`
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), method: init.method, headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) };
			return new Response(${JSON.stringify(successBody())}, { status: 200 });
		};
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		const result = await searchWithXai("what shipped?");
		console.log(JSON.stringify({ captured, result }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const { captured, result } = JSON.parse(child.stdout.trim());

	assert.equal(captured.url, "https://api.x.ai/v1/responses");
	assert.equal(captured.method, "POST");
	assert.equal(captured.headers.authorization, "Bearer xai-key");
	// Only these three fields are verified against a live account. Adding
	// stream/include/tool_choice/parallel_tool_calls risks a 400 that costs the
	// user the whole search, so the body must stay exactly this shape.
	assert.deepEqual(Object.keys(captured.body).sort(), ["input", "model", "tools"]);
	assert.deepEqual(captured.body.tools, [{ type: "web_search" }]);
	assert.match(captured.body.input, /what shipped\?$/);

	assert.match(result.answer, /Grok Imagine v1\.5 shipped/);
	// Annotations carry titles, so they win the dedupe and come first; raw
	// sources and response-level citations fill in what they missed.
	assert.deepEqual(result.results.map((r) => r.url), ["https://x.ai/news/grok-imagine", "https://x.ai/news", "https://x.ai/citation-only"]);
	assert.equal(result.results[0].title, "Grok Imagine");
});

test("xAI opts into web and X tools and keeps annotation sources first", async () => {
	const home = await createHome({ xaiApiKey: "xai-key", xaiSearchTools: ["web_search", "x_search"] });
	const child = runChild(`
		let captured;
		globalThis.fetch = async (_url, init) => { captured = JSON.parse(init.body); return new Response(${JSON.stringify(xSearchBody())}, { status: 200 }); };
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		const result = await searchWithXai("what are people saying?");
		console.log(JSON.stringify({ captured, result }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const { captured, result } = JSON.parse(child.stdout.trim());

	assert.equal(captured.model, "grok-4.6");
	assert.deepEqual(captured.tools, [{ type: "web_search" }, { type: "x_search" }]);
	assert.match(captured.input, /Search the web and X/);
	assert.deepEqual(result.results.map((r) => r.url), [
		"https://x.com/i/status/annotated",
		"https://x.com/i/status/answer",
		"https://x.com/i/status/raw",
		"https://x.com/i/status/source-string",
		"https://x.com/i/status/citation-only",
		"https://x.com/i/status/citation-object",
	]);
	assert.equal(result.results[0].title, "Annotated X post");
	assert.equal(result.results.at(-1).title, "Citation object");
});

test("xAI keeps mixed domain filters, recency and source count as prompt guidance", async () => {
	const home = await createHome({ xaiApiKey: "xai-key" });
	const child = runChild(`
		let captured;
		globalThis.fetch = async (_url, init) => { captured = JSON.parse(init.body); return new Response(${JSON.stringify(successBody())}, { status: 200 }); };
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		await searchWithXai("filtered", { recencyFilter: "week", domainFilter: ["example.com", "-spam.example"], numResults: 4 });
		console.log(JSON.stringify(captured));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const body = JSON.parse(child.stdout.trim());
	assert.deepEqual(body.tools, [{ type: "web_search" }]);
	assert.match(body.input, /past week/);
	assert.match(body.input, /Only use sources from: example\.com\./);
	assert.match(body.input, /Do not use sources from: spam\.example\./);
	assert.match(body.input, /around 4 distinct sources/);
});

// The registry path survives model retirement by walking the appropriate
// model-candidate list against models pi actually knows. The api-key path
// can't — nothing tells it which ids are live — so `xaiSearchModel` is its
// escape hatch, the same one `openaiSearchModel` gives the OpenAI backend.
test("xaiSearchModel pins the model id on the api-key path", async () => {
	const home = await createHome({ xaiApiKey: "xai-key", xaiSearchModel: "  grok-5  " });
	const child = runChild(`
		let captured;
		globalThis.fetch = async (_url, init) => { captured = JSON.parse(init.body); return new Response(${JSON.stringify(successBody())}, { status: 200 }); };
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		await searchWithXai("pinned");
		console.log(JSON.stringify(captured));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout.trim()).model, "grok-5");
});

test("xAI defaults to the first candidate model when xaiSearchModel is unset", async () => {
	const home = await createHome({ xaiApiKey: "xai-key" });
	const child = runChild(`
		let captured;
		globalThis.fetch = async (_url, init) => { captured = JSON.parse(init.body); return new Response(${JSON.stringify(successBody())}, { status: 200 }); };
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		await searchWithXai("default");
		console.log(JSON.stringify(captured));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout.trim()).model, "grok-4.5");
});

test("an explicit unknown xAI model is sent as configured and server rejection is surfaced", async () => {
	const home = await createHome({ xaiApiKey: "xai-key", xaiSearchModel: "grok-not-real" });
	const child = runChild(`
		let model;
		globalThis.fetch = async (_url, init) => {
			model = JSON.parse(init.body).model;
			return new Response("invalid model", { status: 400 });
		};
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		try { await searchWithXai("explicit model"); console.log(JSON.stringify({ ok: true })); }
		catch (error) { console.log(JSON.stringify({ model, error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.model, "grok-not-real");
	assert.match(output.error, /xAI API error 400/);
});

test("xaiSearchModel authenticates through its own registry entry for every tool combination", async () => {
	for (const tools of [undefined, ["web_search"], ["x_search"], ["web_search", "x_search"]]) {
		const home = await createHome({ xaiSearchModel: "  grok-4.7  ", xaiSearchTools: tools });
		const child = runChild(`
			const lookups = [];
			const ctx = { modelRegistry: {
				find(provider, id) {
					lookups.push([provider, id]);
					return id === "grok-4.7" ? { id } : undefined;
				},
				async getApiKeyAndHeaders(model) {
					return { ok: true, apiKey: "registry-test-key", headers: { "x-test-header": "preserved" } };
				},
			} };
			let captured;
			globalThis.fetch = async (_url, init) => {
				captured = { body: JSON.parse(init.body), headers: Object.fromEntries(new Headers(init.headers)) };
				return new Response(${JSON.stringify(successBody())}, { status: 200 });
			};
			const { isXaiSearchAvailable, searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
			const available = await isXaiSearchAvailable(ctx);
			const result = await searchWithXai("configured registry model", {}, ctx);
			console.log(JSON.stringify({ available, captured, lookups }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const { available, captured, lookups } = JSON.parse(child.stdout.trim());
		assert.equal(available, true);
		assert.equal(captured.body.model, "grok-4.7");
		assert.deepEqual(captured.body.tools, (tools ?? ["web_search"]).map(type => ({ type })));
		assert.equal(captured.headers.authorization, "Bearer registry-test-key");
		assert.equal(captured.headers["x-test-header"], "preserved");
		assert.ok(lookups.length >= 2);
		assert.ok(lookups.every(([provider, id]) => provider === "xai" && id === "grok-4.7"));
	}
});

test("xAI preserves candidate auth fallback when the configured registry model is unavailable", async () => {
	for (const failure of ["missing", "no-key", "throws"]) {
		const home = await createHome({ xaiSearchModel: "grok-4.7", xaiSearchTools: ["x_search"] });
		const child = runChild(`
			const lookups = [];
			const ctx = { modelRegistry: {
				find(_provider, id) {
					lookups.push(id);
					return id === "grok-4.5" || (id === "grok-4.7" && ${JSON.stringify(failure)} !== "missing") ? { id } : undefined;
				},
				async getApiKeyAndHeaders(model) {
					if (model.id === "grok-4.7") {
						if (${JSON.stringify(failure)} === "throws") throw new Error("unavailable");
						return { ok: false };
					}
					return { ok: true, apiKey: "fallback-test-key" };
				},
			} };
			const { resolveXaiAuth } = await import(${JSON.stringify(xaiModuleUrl)});
			console.log(JSON.stringify({ auth: await resolveXaiAuth(ctx), lookups }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const { auth, lookups } = JSON.parse(child.stdout.trim());
		assert.deepEqual(lookups, ["grok-4.7", "grok-4.6", "grok-4.5"]);
		assert.deepEqual(auth, { apiKey: "fallback-test-key", model: "grok-4.7", headers: {}, responsesUrl: "https://api.x.ai/v1/responses" });
	}
});

test("xAI tries a configured built-in candidate once before falling back to an API key", async () => {
	const home = await createHome({ xaiSearchModel: "grok-4.3", xaiApiKey: "api-fallback-test-key" });
	const child = runChild(`
		const lookups = [];
		const ctx = { modelRegistry: {
			find(_provider, id) { lookups.push(id); return undefined; },
		} };
		const { resolveXaiAuth } = await import(${JSON.stringify(xaiModuleUrl)});
		console.log(JSON.stringify({ auth: await resolveXaiAuth(ctx), lookups }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const { auth, lookups } = JSON.parse(child.stdout.trim());
	assert.deepEqual(lookups, ["grok-4.3", "grok-4.5", "grok-build-0.1"]);
	assert.deepEqual(auth, { apiKey: "api-fallback-test-key", model: "grok-4.3", headers: {}, responsesUrl: "https://api.x.ai/v1/responses" });
});

test("xAI preserves unconfigured registry model order and API-key fallback", async () => {
	for (const tools of [undefined, ["x_search"], ["web_search", "x_search"]]) {
		const home = await createHome({ xaiSearchTools: tools });
		const child = runChild(`
			const lookups = [];
			const ctx = { modelRegistry: {
				find(_provider, id) { lookups.push(id); return undefined; },
			} };
			const { resolveXaiAuth } = await import(${JSON.stringify(xaiModuleUrl)});
			console.log(JSON.stringify({ auth: await resolveXaiAuth(ctx), lookups }));
		`, { PI_CODING_AGENT_DIR: home, XAI_API_KEY: "api-fallback-test-key" });
		assert.equal(child.status, 0, child.stderr);
		const { auth, lookups } = JSON.parse(child.stdout.trim());
		const expected = tools ? ["grok-4.6", "grok-4.5", "grok-4.3", "grok-build-0.1"] : ["grok-4.5", "grok-4.3", "grok-build-0.1"];
		assert.deepEqual(lookups, expected);
		assert.deepEqual(auth, { apiKey: "api-fallback-test-key", model: expected[0], headers: {}, responsesUrl: "https://api.x.ai/v1/responses" });
	}
});

test("a non-string or empty xaiSearchModel is rejected rather than silently ignored", async () => {
	for (const bad of [42, "   "]) {
		const home = await createHome({ xaiApiKey: "xai-key", xaiSearchModel: bad });
		const child = runChild(`
			globalThis.fetch = async () => { throw new Error("must not reach the network"); };
			const { isXaiSearchAvailable, searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
			if (await isXaiSearchAvailable()) throw new Error("invalid model must be unavailable");
			try {
				await searchWithXai("bad model");
				console.log(JSON.stringify({ threw: false }));
			} catch (err) {
				console.log(JSON.stringify({ threw: true, message: err.message }));
			}
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const { threw, message } = JSON.parse(child.stdout.trim());
		assert.equal(threw, true, `xaiSearchModel ${JSON.stringify(bad)} should be rejected`);
		assert.match(message, /xaiSearchModel .* must be a non-empty string/);
	}
});

test("xaiSearchTools is validated and may opt into X-only search", async () => {
	const home = await createHome({ xaiApiKey: "xai-key", xaiSearchTools: ["x_search"] });
	const child = runChild(`
		let captured;
		globalThis.fetch = async (_url, init) => { captured = JSON.parse(init.body); return new Response(${JSON.stringify(xSearchBody())}, { status: 200 }); };
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		const result = await searchWithXai("x only");
		console.log(JSON.stringify({ captured, result }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const { captured } = JSON.parse(child.stdout.trim());
	assert.deepEqual(captured.tools, [{ type: "x_search" }]);
	assert.match(captured.input, /^Search X and answer/);

	for (const bad of [null, "x_search", [], ["x_search", "x_search"], ["x_search", "unknown"], ["web_search", 42]]) {
		const badHome = await createHome({ xaiApiKey: "xai-key", xaiSearchTools: bad });
		const badChild = runChild(`
			globalThis.fetch = async () => { throw new Error("must not reach the network"); };
			const { isXaiSearchAvailable, searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
			const available = await isXaiSearchAvailable();
			try {
				await searchWithXai("bad tools");
				console.log(JSON.stringify({ available, threw: false }));
			} catch (err) {
				console.log(JSON.stringify({ available, threw: true, message: err.message }));
			}
		`, { PI_CODING_AGENT_DIR: badHome });
		assert.equal(badChild.status, 0, badChild.stderr);
		const { available, threw, message } = JSON.parse(badChild.stdout.trim());
		assert.equal(available, false, `xaiSearchTools ${JSON.stringify(bad)} should only make xAI unavailable`);
		assert.equal(threw, true, `xaiSearchTools ${JSON.stringify(bad)} should be rejected`);
		assert.match(message, /xaiSearchTools .* (?:non-empty array|web_search or x_search|duplicates)/);
	}
});

test("explicit xai provider routing works", async () => {
	const home = await createHome({});
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => { calls.push(String(url)); return new Response(${JSON.stringify(successBody())}, { status: 200 }); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("route", { provider: "xai" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, { PI_CODING_AGENT_DIR: home, XAI_API_KEY: "xai-env-key" });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { provider: "xai", calls: ["https://api.x.ai/v1/responses"] });
});

test("xAI is never part of auto fallback, even with a key configured", async () => {
	const home = await createHome({ xaiApiKey: "xai-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("unexpected auto provider"); };
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try { await search("auto", { provider: "auto" }); console.log(JSON.stringify({ ok: true, calls })); }
		catch (error) { console.log(JSON.stringify({ ok: false, error: String(error), calls })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.ok(output.calls.every((url) => !url.startsWith("https://api.x.ai/")));
});

test("provider \"all\" does not fan out to xAI", async () => {
	const home = await createHome({ xaiApiKey: "xai-key", braveApiKey: "brave-key" });
	const child = runChild(`
		const calls = [];
		globalThis.fetch = async (url) => {
			calls.push(String(url));
			if (String(url).startsWith("https://api.x.ai/")) throw new Error("xAI must not be part of all");
			return new Response(JSON.stringify({ web: { results: [{ title: "Brave", url: "https://example.com/brave", description: "ok" }] } }), { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		const result = await search("fan out", { provider: "all" });
		console.log(JSON.stringify({ provider: result.provider, calls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.provider, "all");
	assert.ok(output.calls.every((url) => !url.startsWith("https://api.x.ai/")));
});

test("xAI without any credential explains all three ways to supply one", async () => {
	const home = await createHome({});
	const child = runChild(`
		globalThis.fetch = async () => { throw new Error("must not reach the network"); };
		const { searchWithXai, isXaiSearchAvailable } = await import(${JSON.stringify(xaiModuleUrl)});
		const available = await isXaiSearchAvailable();
		try { await searchWithXai("nope"); console.log(JSON.stringify({ available, ok: true })); }
		catch (error) { console.log(JSON.stringify({ available, ok: false, error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, false);
	assert.equal(output.ok, false);
	assert.match(output.error, /xAI developer API credentials/);
	assert.match(output.error, /Grok website access alone does not authenticate API requests/);
	assert.match(output.error, /subscription\/API billing is separate/);
	assert.match(output.error, /xaiApiKey/);
	assert.match(output.error, /XAI_API_KEY/);
	assert.doesNotMatch(output.error, /sign in with .*subscription/i);
});

test("xAI classifies common API HTTP failures and redacts credentials", async () => {
	for (const status of [400, 401, 403, 429]) {
		const home = await createHome({ xaiApiKey: "xai-secret" });
		const child = runChild(`
			globalThis.fetch = async () => new Response("denied for xai-secret", { status: ${status} });
			const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
			try { await searchWithXai("redact"); console.log(JSON.stringify({ ok: true })); }
			catch (error) { console.log(JSON.stringify({ error: String(error) })); }
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.match(output.error, new RegExp(`xAI API error ${status}:`));
		assert.doesNotMatch(output.error, /xai-secret/);
		assert.match(output.error, /\[redacted\]/);
	}
});

test("xAI reports configurable request/body deadlines as provider failures", async () => {
	for (const [configured, expected] of [[undefined, 60_000], [120_000, 120_000], [300_000, 300_000], [600_001, 600_000]]) {
	for (const stage of ["request", "body"]) {
		const home = await createHome({ xaiApiKey: "xai-key", xaiSearchTimeoutMs: configured });
		const child = runChild(`
			const deadline = new AbortController();
			let timeoutMs;
			AbortSignal.timeout = ms => { timeoutMs = ms; return deadline.signal; };
			const expire = () => {
				deadline.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
				throw deadline.signal.reason;
			};
			globalThis.fetch = async () => ${stage === "request" ? "expire()" : "({ ok: true, status: 200, json: async () => expire() })"};
			const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
			try { await searchWithXai("slow search"); console.log(JSON.stringify({ ok: true })); }
			catch (error) { console.log(JSON.stringify({ timeoutMs, message: error.message })); }
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.equal(output.timeoutMs, expected);
		assert.equal(output.message, `xAI search timed out after ${expected / 1000} seconds`);
		assert.doesNotMatch(output.message, /abort|invalid JSON/i);
	}
	}
});

test("xAI preserves caller cancellation during request and response reading", async () => {
	for (const stage of ["request", "body"]) {
		const home = await createHome({ xaiApiKey: "xai-key" });
		const child = runChild(`
			const caller = new AbortController();
			const reason = new DOMException("operator cancelled", "AbortError");
			const cancel = signal => { caller.abort(reason); signal.throwIfAborted(); };
			globalThis.fetch = async (_url, init) => ${stage === "request" ? "cancel(init.signal)" : "({ ok: true, status: 200, json: async () => cancel(init.signal) })"};
			const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
			try { await searchWithXai("cancelled search", { signal: caller.signal }); console.log(JSON.stringify({ ok: true })); }
			catch (error) { console.log(JSON.stringify({ sameReason: error === reason, name: error.name })); }
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), { sameReason: true, name: "AbortError" });
	}
});

test("xAI deadline expiry allows configured network fallback", async () => {
	const home = await createHome({
		xaiApiKey: "xai-key", tavilyApiKey: "tavily-key",
		searchRouting: { providers: ["xai", "tavily"], fallbackOn: ["network"] },
	});
	const child = runChild(`
		const deadline = new AbortController();
		let firstDeadline = true;
		AbortSignal.timeout = () => {
			if (!firstDeadline) return new AbortController().signal;
			firstDeadline = false;
			return deadline.signal;
		};
		const calls = [];
		globalThis.fetch = async (url, init) => {
			init.signal?.throwIfAborted();
			calls.push(new URL(url).hostname);
			if (new URL(url).hostname === "api.x.ai") {
				deadline.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
				throw deadline.signal.reason;
			}
			return new Response(JSON.stringify({ results: [{ title: "Fallback", url: "https://example.com", content: "Found" }] }), { status: 200 });
		};
		const { search } = await import(${JSON.stringify(searchModuleUrl)});
		try { const result = await search("slow primary", { provider: "auto" }); console.log(JSON.stringify({ provider: result.provider, calls })); }
		catch (error) { console.log(JSON.stringify({ error: error.message, calls })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { provider: "tavily", calls: ["api.x.ai", "api.tavily.com"] });
});

test("legacy registry and MCP gateway selectors require explicit configuration migration", async () => {
	for (const config of [
		{ xaiSearchProvider: "cpa" },
		{ mcp: { xai: { baseUrl: "https://old.example.test/v1", apiKey: "old-key" } } },
		{ xaiSearchProvider: "xai", xaiResponsesUrl: "https://new.example.test/v1/responses" },
	]) {
		const home = await createHome({ xaiApiKey: "must-not-use", ...config });
		const child = runChild(`
			let calls = 0, lookups = 0;
			globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
			const ctx = { modelRegistry: { find() { lookups++; throw new Error("must not resolve"); } } };
			const { isXaiSearchAvailable, searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
			const available = await isXaiSearchAvailable(ctx);
			try { await searchWithXai("legacy", {}, ctx); }
			catch (error) { console.log(JSON.stringify({ available, calls, lookups, error: error.message })); }
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const result = JSON.parse(child.stdout.trim());
		assert.equal(result.available, false);
		assert.equal(result.calls, 0);
		assert.equal(result.lookups, 0);
		assert.match(result.error, /must be replaced with xaiResponsesUrl, xaiApiKey/);
	}
});

test("native domain filters normalize and dedupe lists, but never truncate or combine them", async () => {
	const home = await createHome({ xaiApiKey: "xai-key", xaiSearchTools: ["web_search", "x_search"] });
	const child = runChild(`
		const requests = [];
		globalThis.fetch = async (_url, init) => { requests.push(JSON.parse(init.body)); return new Response(${JSON.stringify(successBody())}); };
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		for (const domainFilter of [
			["https://EXAMPLE.com/path", "example.com", " ", "invalid"],
			["-example.com", "-https://EXAMPLE.com/path"],
			["a.test", "b.test", "c.test", "d.test", "e.test"],
			["a.test", "b.test", "c.test", "d.test", "e.test", "f.test"],
			["example.com", "-blocked.test"], [], ["invalid"],
		]) await searchWithXai("domains", { domainFilter });
		console.log(JSON.stringify(requests));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const bodies = JSON.parse(child.stdout.trim());
	assert.deepEqual(bodies[0].tools[0], { type: "web_search", filters: { allowed_domains: ["example.com"] } });
	assert.deepEqual(bodies[1].tools[0], { type: "web_search", filters: { excluded_domains: ["example.com"] } });
	assert.equal(bodies[2].tools[0].filters.allowed_domains.length, 5);
	for (const body of bodies.slice(3)) assert.deepEqual(body.tools[0], { type: "web_search" });
	for (const body of bodies) assert.deepEqual(body.tools[1], { type: "x_search" });
	assert.match(bodies[3].input, /a\.test, b\.test, c\.test, d\.test, e\.test, f\.test/);
	assert.match(bodies[4].input, /Do not use sources from: blocked\.test/);
});

test("X-only requests do not receive web-only domain filter fields", async () => {
	const home = await createHome({ xaiApiKey: "xai-key", xaiSearchTools: ["x_search"] });
	const child = runChild(`
		let body;
		globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return new Response(${JSON.stringify(xSearchBody())}); };
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		await searchWithXai("X only", { domainFilter: ["example.com"] });
		console.log(JSON.stringify(body));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const body = JSON.parse(child.stdout.trim());
	assert.deepEqual(body.tools, [{ type: "x_search" }]);
	assert.match(body.input, /Only use sources from: example\.com/);
});

test("direct xAI redacts registry header secrets and overrides managed headers case-insensitively", async () => {
	const home = await createHome({});
	const child = runChild(`
		const ctx = { modelRegistry: {
			find() { return { id: "grok-4.5", baseUrl: "https://api.x.ai/v1" }; },
			async getApiKeyAndHeaders() { return { ok: true, apiKey: "api-secret", headers: { "X-Proxy-Key": "header-secret", authorization: "stale-secret", "content-type": "stale-type", "X-Removed": null } }; },
		} };
		let headers;
		globalThis.fetch = async (_url, init) => { headers = Object.fromEntries(init.headers); return new Response("denied api-secret header-secret", { status: 401 }); };
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		try { await searchWithXai("redact", {}, ctx); }
		catch (error) { console.log(JSON.stringify({ error: error.message, headers })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const { error, headers } = JSON.parse(child.stdout.trim());
	assert.match(error, /xAI API error 401/);
	assert.doesNotMatch(error, /api-secret|header-secret/);
	assert.equal(headers.authorization, "Bearer api-secret");
	assert.equal(headers["content-type"], "application/json");
	assert.equal(headers["x-removed"], undefined);
});

test("direct xAI rejects custom model/auth URLs before sending registry credentials", async () => {
	for (const [baseUrl, authBaseUrl] of [
		["https://proxy.example.test/v1", undefined],
		["https://api.x.ai/v1", "https://proxy.example.test/v1"],
		["https://api.x.ai/v1", "https://api.x.ai/other"],
		["https://api.x.ai/v1", "http://127.0.0.1:8317/v1"],
		["https://api.x.ai/v1", "https://secret:password@proxy.example.test/v1"],
	]) {
		const home = await createHome({ xaiSearchModel: "grok-4.7", xaiApiKey: "must-not-fallback" });
		const child = runChild(`
			const ctx = { modelRegistry: {
				find(_provider, id) { return { id, baseUrl: ${JSON.stringify(baseUrl)} }; },
				async getApiKeyAndHeaders() { return { ok: true, apiKey: "gateway-key", headers: { "X-Proxy-Key": "gateway-header" }, baseUrl: ${JSON.stringify(authBaseUrl)} }; },
			} };
			let calls = 0;
			globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
			const { searchWithXai, isXaiSearchAvailable } = await import(${JSON.stringify(xaiModuleUrl)});
			const available = await isXaiSearchAvailable(ctx);
			try { await searchWithXai("wrong endpoint", {}, ctx); }
			catch (error) { console.log(JSON.stringify({ available, calls, error: error.message })); }
		`, { PI_CODING_AGENT_DIR: home, XAI_API_KEY: "must-not-fallback-env" });
		assert.equal(child.status, 0, child.stderr);
		const result = JSON.parse(child.stdout.trim());
		assert.equal(result.available, false);
		assert.equal(result.calls, 0);
		assert.match(result.error, /xaiResponsesUrl/);
		assert.doesNotMatch(result.error, /gateway-key|gateway-header|secret|password/);
	}
});

test("direct xAI custom model URLs block API-key fallback even when registry auth is unavailable", async () => {
	for (const failure of ["no-key", "unavailable", "throws"]) {
		const home = await createHome({ xaiSearchModel: "grok-4.7", xaiApiKey: "must-not-fallback" });
		const child = runChild(`
			const ctx = { modelRegistry: {
				find(_provider, id) { return { id, baseUrl: "https://proxy.example.test/v1" }; },
				async getApiKeyAndHeaders() {
					if (${JSON.stringify(failure)} === "throws") throw new Error("credential resolution failed");
					return { ok: ${JSON.stringify(failure)} === "no-key" };
				},
			} };
			let calls = 0;
			globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
			const { searchWithXai, isXaiSearchAvailable } = await import(${JSON.stringify(xaiModuleUrl)});
			const available = await isXaiSearchAvailable(ctx);
			try { await searchWithXai("no fallback", {}, ctx); }
			catch (error) { console.log(JSON.stringify({ available, calls, error: error.message })); }
		`, { PI_CODING_AGENT_DIR: home, XAI_API_KEY: "must-not-fallback-env" });
		assert.equal(child.status, 0, child.stderr);
		const result = JSON.parse(child.stdout.trim());
		assert.equal(result.available, false);
		assert.equal(result.calls, 0);
		assert.match(result.error, /Direct xAI registry credentials require the official/);
	}
});

test("direct xAI uses official model and request-time auth URLs without changing the endpoint", async () => {
	for (const [baseUrl, authBaseUrl] of [
		["https://api.x.ai/v1/", undefined],
		["https://proxy.example.test/v1", "https://api.x.ai/v1"],
	]) {
		const home = await createHome({ xaiSearchModel: "grok-4.7" });
		const child = runChild(`
			const ctx = { modelRegistry: {
				find(_provider, id) { return { id, baseUrl: ${JSON.stringify(baseUrl)} }; },
				async getApiKeyAndHeaders() { return { ok: true, apiKey: "official-key", baseUrl: ${JSON.stringify(authBaseUrl)} }; },
			} };
			const { resolveXaiAuth, isXaiSearchAvailable } = await import(${JSON.stringify(xaiModuleUrl)});
			console.log(JSON.stringify({ available: await isXaiSearchAvailable(ctx), url: (await resolveXaiAuth(ctx)).responsesUrl }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		assert.deepEqual(JSON.parse(child.stdout.trim()), { available: true, url: "https://api.x.ai/v1/responses" });
	}
});

test("explicit gateway requests reject redirects instead of forwarding credentials", async () => {
	const home = await createHome({});
	const child = runChild(`
		const { createServer } = await import("node:http");
		let redirectHits = 0;
		const server = createServer((req, res) => {
			if (req.url === "/redirect-target") redirectHits++;
			res.writeHead(307, { Location: "/redirect-target" }); res.end();
		});
		await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
		const { writeFileSync } = await import("node:fs");
		writeFileSync(process.env.PI_CODING_AGENT_DIR + "/web-search.json", JSON.stringify({
			xaiResponsesUrl: "http://127.0.0.1:" + server.address().port + "/v1/responses", xaiApiKey: "gateway-key",
		}));
		try {
			const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
			try { await searchWithXai("no redirect"); }
			catch (error) { console.log(JSON.stringify({ failed: true, redirectHits })); }
		} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), { failed: true, redirectHits: 0 });
});

test("curator page exposes xAI as a manual provider", async () => {
	const { generateCuratorPage } = await import(curatorPageModuleUrl);
	const page = generateCuratorPage(
		["query"],
		"token",
		20,
		{
			all: false,
			openai: false,
			brave: false,
			parallel: false,
			tinyfish: false,
			search1api: false,
			searchinfinity: false,
			querit: false,
			tavily: false,
			serpdive: false,
			searxng: false,
			perplexity: false,
			exa: false,
			gemini: false,
			kimi: false,
			anysearch: false,
			xai: true,
		},
		"xai",
		"xai",
		[],
		null,
	);

	assert.match(page, />xAI<\/button>/);
	assert.match(page, /"xai":true/);
});

test("xAI answers with no answer text and no sources fail loudly", async () => {
	const home = await createHome({ xaiApiKey: "xai-key" });
	const child = runChild(`
		globalThis.fetch = async () => new Response(JSON.stringify({ output: [] }), { status: 200 });
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		try { await searchWithXai("empty"); console.log(JSON.stringify({ ok: true })); }
		catch (error) { console.log(JSON.stringify({ ok: false, error: String(error) })); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.ok, false);
	assert.match(output.error, /returned no answer or sources/);
});

// A fake Pi registry that would hand out a Grok subscription token. With a
// custom endpoint that token must never be read or sent.
const piRegistryCtx = `
	const registryCalls = [];
	const ctx = { modelRegistry: {
		find: (provider, id) => ({ provider, id }),
		getApiKeyAndHeaders: async (model) => { registryCalls.push(model.id); return { ok: true, apiKey: "pi-oauth-token", headers: { "x-pi": "1" } }; },
	} };
`;

test("xaiResponsesUrl sends the configured key and unchanged body to the custom endpoint, never Pi credentials", async () => {
	const home = await createHome({ xaiApiKey: "gateway-key", xaiResponsesUrl: "http://127.0.0.1:8317/v1/responses", xaiSearchModel: "grok/grok-4.7" });
	const child = runChild(`
		${piRegistryCtx}
		let captured;
		globalThis.fetch = async (url, init) => {
			captured = { url: String(url), headers: Object.fromEntries(new Headers(init.headers)), body: JSON.parse(init.body) };
			return new Response(${JSON.stringify(successBody())}, { status: 200 });
		};
		const { searchWithXai, isXaiSearchAvailable } = await import(${JSON.stringify(xaiModuleUrl)});
		const available = await isXaiSearchAvailable(ctx);
		await searchWithXai("gateway", {}, ctx);
		console.log(JSON.stringify({ available, captured, registryCalls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const { available, captured, registryCalls } = JSON.parse(child.stdout.trim());
	assert.equal(available, true);
	assert.equal(captured.url, "http://127.0.0.1:8317/v1/responses");
	assert.equal(captured.headers.authorization, "Bearer gateway-key");
	assert.equal(captured.headers["x-pi"], undefined);
	assert.deepEqual(Object.keys(captured.body).sort(), ["input", "model", "tools"]);
	assert.equal(captured.body.model, "grok/grok-4.7");
	assert.deepEqual(registryCalls, []);
});

test("xaiResponsesUrl without an xAI key leaves xAI unavailable even when Pi is signed in", async () => {
	const home = await createHome({ xaiResponsesUrl: "https://gateway.example.com/v1/responses" });
	const child = runChild(`
		${piRegistryCtx}
		const calls = [];
		globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("must not reach the network"); };
		const { searchWithXai, isXaiSearchAvailable } = await import(${JSON.stringify(xaiModuleUrl)});
		const available = await isXaiSearchAvailable(ctx);
		let error;
		try { await searchWithXai("no key", {}, ctx); } catch (err) { error = String(err); }
		console.log(JSON.stringify({ available, error, calls, registryCalls }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const output = JSON.parse(child.stdout.trim());
	assert.equal(output.available, false);
	assert.match(output.error, /xaiResponsesUrl is set/);
	assert.match(output.error, /xaiApiKey/);
	assert.deepEqual(output.calls, []);
	assert.deepEqual(output.registryCalls, []);
});

test("without xaiResponsesUrl, Pi's xAI sign-in still wins on api.x.ai", async () => {
	const home = await createHome({ xaiApiKey: "xai-key" });
	const child = runChild(`
		${piRegistryCtx}
		let captured;
		globalThis.fetch = async (url, init) => { captured = { url: String(url), headers: Object.fromEntries(new Headers(init.headers)) }; return new Response(${JSON.stringify(successBody())}, { status: 200 }); };
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		await searchWithXai("default", {}, ctx);
		console.log(JSON.stringify(captured));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const captured = JSON.parse(child.stdout.trim());
	assert.equal(captured.url, "https://api.x.ai/v1/responses");
	assert.equal(captured.headers.authorization, "Bearer pi-oauth-token");
});

test("invalid timeouts fail before Pi credential resolution for web and dedicated X calls", async () => {
	const home = await createHome({ xaiSearchTimeoutMs: 0 });
	const child = runChild(`
		let lookups=0, requests=0;
		const ctx={modelRegistry:{find(){lookups++;throw new Error("must not resolve");}}};
		globalThis.fetch=async()=>{requests++;throw new Error("must not fetch");};
		const {searchWithXai,searchX}=await import(${JSON.stringify(xaiModuleUrl)});
		const errors=[];
		for(const call of [()=>searchWithXai("q",{},ctx),()=>searchX({query:"q"},undefined,ctx)]){
			try{await call();}catch(error){errors.push(error.message);}
		}
		console.log(JSON.stringify({lookups,requests,errors}));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const result=JSON.parse(child.stdout.trim());
	assert.equal(result.lookups, 0);
	assert.equal(result.requests, 0);
	assert.equal(result.errors.length, 2);
	for(const error of result.errors) assert.match(error, /xaiSearchTimeoutMs .* positive integer/);
});

test("explicit official xaiResponsesUrl still bypasses Pi credentials", async () => {
	const home=await createHome({xaiResponsesUrl:"https://api.x.ai/v1/responses",xaiApiKey:"explicit-key"});
	const child=runChild(`
		${piRegistryCtx}
		let authorization;
		globalThis.fetch=async(_url,init)=>{authorization=new Headers(init.headers).get("authorization");return new Response(${JSON.stringify(successBody())});};
		const {searchWithXai}=await import(${JSON.stringify(xaiModuleUrl)});
		await searchWithXai("q",{},ctx);
		console.log(JSON.stringify({authorization,registryCalls}));
	`,{PI_CODING_AGENT_DIR:home});
	assert.equal(child.status,0,child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()),{authorization:"Bearer explicit-key",registryCalls:[]});
});

test("xaiResponsesUrl rejects embedded credentials before auth, fetch or activity logging", async () => {
	for (const url of [
		"https://alice:url-secret@gateway.example.test/v1/responses",
		"https://alice@gateway.example.test/v1/responses",
		"http://:url-secret@127.0.0.1:8317/v1/responses",
		"https://ali%63e:url%2Dsecret@gateway.example.test/v1/responses",
	]) for (const key of ["explicit-test-key", "!must-not-run"]) {
		const home = await createHome({ xaiResponsesUrl: url, xaiApiKey: key, tools: { xSearch: { enabled: true } } });
		const child = runChild(`
			let lookups = 0, requests = 0;
			const ctx = { modelRegistry: { find() { lookups++; throw new Error("must not resolve Pi"); } } };
			globalThis.fetch = async (url) => { requests++; throw new TypeError("Request cannot include URL credentials: " + url); };
			const { searchWithXai, searchX, resolveXaiAuth, isXaiSearchAvailable } = await import(${JSON.stringify(xaiModuleUrl)});
			const { activityMonitor } = await import(${JSON.stringify(new URL("../activity.ts", import.meta.url).href)});
			const available = [await isXaiSearchAvailable(ctx), await isXaiSearchAvailable()];
			const errors = [];
			for (const call of [
				() => resolveXaiAuth(ctx), () => resolveXaiAuth(),
				() => searchWithXai("q", {}, ctx), () => searchWithXai("q"),
				() => searchX({ query: "q" }, undefined, ctx), () => searchX({ query: "q" }),
			]) { try { await call(); errors.push(null); } catch (error) { errors.push(error.message); } }
			const { createStandaloneWebToolCore } = await import(${JSON.stringify(new URL("../web-tool-core.ts", import.meta.url).href)});
			const mcpResult = await createStandaloneWebToolCore().xSearch({ query: "q" });
			console.log(JSON.stringify({ available, lookups, requests, errors, mcpResult, activity: activityMonitor.getEntries() }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const output = JSON.parse(child.stdout.trim());
		assert.deepEqual(output.available, [false, false]);
		assert.equal(output.lookups, 0);
		assert.equal(output.requests, 0);
		assert.equal(output.errors.length, 6);
		for (const error of output.errors) assert.match(error, /xaiResponsesUrl .* must not contain URL credentials/);
		assert.equal(output.mcpResult.isError, true);
		assert.match(JSON.stringify(output.mcpResult), /must not contain URL credentials/);
		assert.deepEqual(output.activity, []);
		assert.doesNotMatch(child.stdout + child.stderr, /alice|ali%63e|url-secret|url%2Dsecret|explicit-test-key/);
	}
});

test("invalid xaiResponsesUrl or xaiSearchTimeoutMs is a config error", async () => {
	const cases = [
		[{ xaiResponsesUrl: "gateway.example.com/v1/responses" }, /xaiResponsesUrl .* absolute http\(s\) URL/],
		[{ xaiResponsesUrl: "ftp://gateway.example.com/v1/responses" }, /xaiResponsesUrl .* must use http or https/],
		[{ xaiSearchTimeoutMs: 0 }, /xaiSearchTimeoutMs .* positive integer/],
		[{ xaiSearchTimeoutMs: "120000" }, /xaiSearchTimeoutMs .* positive integer/],
		[{ xaiSearchTimeoutMs: 1.5 }, /xaiSearchTimeoutMs .* positive integer/],
	];
	for (const [config, pattern] of cases) {
		const home = await createHome({ xaiApiKey: "xai-key", ...config });
		const child = runChild(`
			globalThis.fetch = async () => { throw new Error("must not reach the network"); };
			const { searchWithXai, isXaiSearchAvailable } = await import(${JSON.stringify(xaiModuleUrl)});
			const available = await isXaiSearchAvailable();
			let error;
			try { await searchWithXai("bad config"); } catch (err) { error = err.message; }
			console.log(JSON.stringify({ available, error }));
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const { available, error } = JSON.parse(child.stdout.trim());
		assert.equal(available, false, JSON.stringify(config));
		assert.match(error ?? "", pattern, JSON.stringify(config));
	}
});

test("xaiSearchTimeoutMs bounds the xAI request", async () => {
	const home = await createHome({ xaiApiKey: "xai-key", xaiSearchTimeoutMs: 50 });
	const child = runChild(`
		globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
			init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
		});
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		let timer;
		const outcome = await Promise.race([
			searchWithXai("slow").then(() => "resolved", (err) => err.message),
			new Promise((resolve) => { timer = setTimeout(() => resolve("still-waiting"), 2000); }),
		]);
		clearTimeout(timer);
		console.log(JSON.stringify({ outcome }));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout.trim()).outcome, "xAI search timed out after 0.05 seconds");
});
