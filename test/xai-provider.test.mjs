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

test("CPA-backed Grok uses the selected Pi provider's model, endpoint and headers", async () => {
	for (const modelOverride of [undefined, "grok-custom-alias"]) {
		const home = await createHome({ xaiSearchProvider: " cpa ", xaiSearchModel: modelOverride, xaiApiKey: "must-not-use-xai-key" });
		const child = runChild(`
			const lookups = [];
			const ctx = { modelRegistry: {
				find(provider, id) { lookups.push([provider, id]); return { id, api: "openai-responses", baseUrl: "https://cpa.example.test/prefix/v1///" }; },
				async getApiKeyAndHeaders() { return { ok: true, apiKey: "cpa-key", headers: { "X-Proxy-Token": "proxy-token", "X-Removed": null, authorization: "stale-token", "content-type": "stale-type" } }; },
			} };
			let captured;
			globalThis.fetch = async (url, init) => {
				captured = { url: String(url), body: JSON.parse(init.body), headers: Object.fromEntries(new Headers(init.headers)), redirect: init.redirect };
				return new Response(${JSON.stringify(successBody())}, { status: 200 });
			};
			const { isXaiSearchAvailable } = await import(${JSON.stringify(xaiModuleUrl)});
			const { search } = await import(${JSON.stringify(searchModuleUrl)});
			const available = await isXaiSearchAvailable(ctx);
			const result = await search("CPA search", { provider: "xai", extensionContext: ctx });
			console.log(JSON.stringify({ available, captured, lookups, provider: result.provider, resultCount: result.results.length }));
		`, { PI_CODING_AGENT_DIR: home, XAI_API_KEY: "must-not-use-env-key" });
		assert.equal(child.status, 0, child.stderr);
		const { available, captured, lookups, provider, resultCount } = JSON.parse(child.stdout.trim());
		assert.equal(available, true);
		assert.equal(provider, "xai");
		assert.equal(resultCount, 3);
		assert.equal(captured.url, "https://cpa.example.test/prefix/v1/responses");
		assert.equal(captured.body.model, modelOverride ?? "grok-4.7");
		assert.deepEqual(captured.body.tools, [{ type: "web_search" }]);
		assert.equal(captured.headers.authorization, "Bearer cpa-key");
		assert.equal(captured.headers["x-proxy-token"], "proxy-token");
		assert.equal(captured.headers["x-removed"], undefined);
		assert.equal(captured.headers["content-type"], "application/json");
		assert.equal(captured.redirect, "error");
		assert.ok(lookups.every(([p, id]) => p === "cpa" && id === (modelOverride ?? "grok-4.7")));
	}
});

test("CPA routing honors a request-time registry base URL", async () => {
	const home = await createHome({ xaiSearchProvider: "cpa" });
	const child = runChild(`
		const ctx = { modelRegistry: {
			find() { return { id: "grok-4.7", api: "openai-responses", baseUrl: "https://unused.example.test/v1" }; },
			async getApiKeyAndHeaders() { return { ok: true, apiKey: "cpa-key", baseUrl: "http://127.0.0.1:8317/v1/" }; },
		} };
		const { resolveXaiAuth } = await import(${JSON.stringify(xaiModuleUrl)});
		console.log(JSON.stringify((await resolveXaiAuth(ctx)).responsesUrl));
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout.trim()), "http://127.0.0.1:8317/v1/responses");
});

test("CPA routing fails closed instead of falling back to xAI credentials or another model", async () => {
	for (const failure of ["no-context", "missing-model", "wrong-api", "missing-key", "key-error", "bad-url"]) {
		const home = await createHome({ xaiSearchProvider: "cpa", xaiApiKey: "must-not-use-xai-key" });
		const child = runChild(`
			const failure = ${JSON.stringify(failure)};
			const lookups = [];
			const ctx = failure === "no-context" ? undefined : { modelRegistry: {
				find(provider, id) {
					lookups.push([provider, id]);
					return failure === "missing-model" ? undefined : { id, api: failure === "wrong-api" ? "openai-completions" : "openai-responses", baseUrl: failure === "bad-url" ? "http://remote.example.test/v1" : "https://cpa.example.test/v1" };
				},
				async getApiKeyAndHeaders() {
					if (failure === "key-error") throw new Error("secret from credential command");
					return failure === "missing-key" ? { ok: false } : { ok: true, apiKey: "cpa-key" };
				},
			} };
			let calls = 0;
			globalThis.fetch = async () => { calls++; throw new Error("must not fetch"); };
			const { isXaiSearchAvailable, searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
			const available = await isXaiSearchAvailable(ctx);
			try { await searchWithXai("fail closed", {}, ctx); }
			catch (error) { console.log(JSON.stringify({ available, calls, lookups, error: error.message })); }
		`, { PI_CODING_AGENT_DIR: home, XAI_API_KEY: "must-not-use-env-key" });
		assert.equal(child.status, 0, child.stderr);
		const result = JSON.parse(child.stdout.trim());
		assert.equal(result.available, false, failure);
		assert.equal(result.calls, 0, failure);
		assert.match(result.error, /xaiSearchProvider/);
		assert.doesNotMatch(result.error, /secret from credential command/);
		assert.ok(result.lookups.every(([p, id]) => p === "cpa" && id === "grok-4.7"));
	}
});

test("CPA endpoint validation rejects malformed URLs without leaking their contents", async () => {
	for (const baseUrl of [undefined, "invalid-url", "file:///tmp/v1", "https://secret:password@cpa.example.test/v1", "https://cpa.example.test/v1?key=secret", "https://cpa.example.test/v1#secret", "https://cpa.example.test/v1?", "https://cpa.example.test/v1#"]) {
		const home = await createHome({ xaiSearchProvider: "cpa" });
		const child = runChild(`
			const ctx = { modelRegistry: {
				find() { return { id: "grok-4.7", api: "openai-responses", baseUrl: ${JSON.stringify(baseUrl)} }; },
				async getApiKeyAndHeaders() { return { ok: true, apiKey: "cpa-key" }; },
			} };
			const { resolveXaiAuth } = await import(${JSON.stringify(xaiModuleUrl)});
			try { await resolveXaiAuth(ctx); }
			catch (error) { console.log(JSON.stringify(error.message)); }
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const error = JSON.parse(child.stdout.trim());
		assert.match(error, /base URL/);
		assert.doesNotMatch(error, /secret|password/);
	}
});

test("invalid xaiSearchProvider values are unavailable and rejected explicitly", async () => {
	for (const value of [null, 42, " ", []]) {
		const home = await createHome({ xaiSearchProvider: value, xaiApiKey: "xai-key" });
		const child = runChild(`
			const { isXaiSearchAvailable, resolveXaiAuth } = await import(${JSON.stringify(xaiModuleUrl)});
			const available = await isXaiSearchAvailable();
			try { await resolveXaiAuth(); }
			catch (error) { console.log(JSON.stringify({ available, error: error.message })); }
		`, { PI_CODING_AGENT_DIR: home });
		assert.equal(child.status, 0, child.stderr);
		const result = JSON.parse(child.stdout.trim());
		assert.equal(result.available, false);
		assert.match(result.error, /xaiSearchProvider .*non-empty Pi provider name/);
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

test("CPA error responses redact both API keys and provider header values", async () => {
	const home = await createHome({ xaiSearchProvider: "cpa" });
	const child = runChild(`
		const ctx = { modelRegistry: {
			find() { return { id: "grok-4.7", api: "openai-responses", baseUrl: "https://cpa.example.test/v1" }; },
			async getApiKeyAndHeaders() { return { ok: true, apiKey: "cpa-secret", headers: { "X-Proxy-Key": "header-secret" } }; },
		} };
		globalThis.fetch = async () => new Response("denied cpa-secret header-secret", { status: 401 });
		const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
		try { await searchWithXai("redact", {}, ctx); }
		catch (error) { console.log(JSON.stringify(error.message)); }
	`, { PI_CODING_AGENT_DIR: home });
	assert.equal(child.status, 0, child.stderr);
	const error = JSON.parse(child.stdout.trim());
	assert.match(error, /xAI API error 401/);
	assert.doesNotMatch(error, /cpa-secret|header-secret/);
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
		assert.match(result.error, /xaiSearchProvider/);
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
		const home = await createHome({ xaiSearchProvider: "xai", xaiSearchModel: "grok-4.7" });
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

test("CPA requests reject redirects instead of forwarding provider credentials", async () => {
	const home = await createHome({ xaiSearchProvider: "cpa" });
	const child = runChild(`
		const { createServer } = await import("node:http");
		let redirectHits = 0;
		const server = createServer((req, res) => {
			if (req.url === "/redirect-target") redirectHits++;
			res.writeHead(307, { Location: "/redirect-target" }); res.end();
		});
		await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
		const ctx = { modelRegistry: {
			find() { return { id: "grok-4.7", api: "openai-responses", baseUrl: "http://127.0.0.1:" + server.address().port + "/v1" }; },
			async getApiKeyAndHeaders() { return { ok: true, apiKey: "cpa-key", headers: { "X-Proxy-Key": "proxy-key" } }; },
		} };
		try {
			const { searchWithXai } = await import(${JSON.stringify(xaiModuleUrl)});
			try { await searchWithXai("no redirect", {}, ctx); }
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
