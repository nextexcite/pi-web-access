import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const coreUrl = new URL("../web-tool-core.ts", import.meta.url).href;
const piUrl = new URL("../index.ts", import.meta.url).href;
function child(config, body, env = {}) {
	const dir = mkdtempSync(join(tmpdir(), "navi-core-"));
	try {
		writeFileSync(join(dir, "web-search.json"), JSON.stringify(config));
		const result = spawnSync(process.execPath, ["--input-type=module"], { encoding: "utf8", timeout: 30000,
			env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_WEB_ACCESS_CACHE_ROOT: join(dir, "cache"), BRAVE_API_KEY: "fixture", TAVILY_API_KEY: "fixture", ...env },
			input: `const requests = []; let tavilyCalls = 0, braveCalls = 0;
			globalThis.fetch = async (input, init) => {
			 const url = String(input); requests.push(url);
			 if (url === "https://api.typesafe.ai/v1/systemone") return Response.json({ answers: { depth: { type: "choice", choice: "quick" }, intent: { type: "choice", choice: "lookup" }, freshness: { type: "choice", choice: "any" } } });
			 if (url.includes("api.search.brave.com")) { braveCalls++; ${config.testBraveRedirect ? 'return new Response("private redirect", { status: 307, headers: { location: "https://private.example.test" } });' : ''} ${config.testBraveRetry ? 'if (braveCalls === 1) return new Response("retry", { status: 429, headers: { "retry-after": "0" } });' : ''} return Response.json({ web: { results: [{ title: "Brave", url: "http://93.184.216.34/a", description: "snippet" }, { title: "Other", url: "http://93.184.216.34/b", description: "snippet" }] } }); }
			 if (url === "https://api.tavily.com/search") { tavilyCalls++; ${config.testTavilyRetry ? 'if (tavilyCalls < 3) return new Response("private remote failure", { status: 401 });' : ''} return Response.json({ results: [{ title: "Tavily", url: "http://93.184.216.34/t", content: "snippet" }] }); }
			 if (url.startsWith("https://api.exa.ai/")) return Response.json({ results: [{ title: "Exa", url: "http://93.184.216.34/e", text: "snippet" }] });
			 if (url.startsWith("https://mcp.exa.ai/")) return new Response("advanced unavailable", { status: 500 });
			 if (url.startsWith("http://93.184.216.34/")) return new Response("<html><head><title>Article</title></head><body><article>" + "An offline article about retrieval and reliable request budgets. ".repeat(100) + "</article></body></html>", { headers: { "content-type": "text/html" } });
			 throw new Error("Unexpected network request");
			};
			const { createStandaloneWebToolCore, createWebToolCore, DEFAULT_TOOL_NAMES } = await import(${JSON.stringify(coreUrl)});
			const out = await (async () => { ${body} })(); console.log(JSON.stringify({ out, requests, tavilyCalls, braveCalls }));`,
		});
		assert.equal(result.status, 0, result.stderr);
		return JSON.parse(result.stdout.trim().split("\n").at(-1));
	} finally { rmSync(dir, { recursive: true, force: true }); }
}
const base = { webSearch: { allowedProviders: ["brave", "exa", "tavily"] }, exaApiKey: "fixture" };

test("off ignores decision settings and preserves the existing configured route", () => {
	const { out, requests } = child({ ...base, searchProvider: "brave", navi: { mode: "off", limits: "invalid", decision: { engine: "jev", apiKey: "!must-not-run" } } }, `return await createStandaloneWebToolCore().webSearch({ query: "q" });`);
	assert.equal(out.details.navi, undefined);
	assert.deepEqual(out.details.queryProviders[0].providers, ["brave"]);
	assert.equal(requests.length, 1);
});

test("shadow produces a Jev proposal while executing the same legacy route", () => {
	const { out, requests } = child({ ...base, webSearch: { allowedProviders: ["exa", "brave"] }, navi: { mode: "shadow", decision: { engine: "jev", apiKey: "fixture" } } }, `return await createStandaloneWebToolCore().webSearch({ query: "q" });`);
	assert.equal(out.details.navi.status, "shadow");
	assert.deepEqual(out.details.navi.plans[0].providers, ["brave"]);
	assert.deepEqual(out.details.queryProviders[0].providers, ["exa"]);
	assert.equal(requests.filter(url => url.includes("api.typesafe.ai")).length, 1);
	assert.equal(requests.filter(url => url.includes("api.search.brave.com")).length, 0);
	const bad = child({ ...base, searchProvider: "brave", navi: { mode: "shadow", limits: "bad" } }, `return await createStandaloneWebToolCore().webSearch({ query: "q" });`);
	assert.equal(bad.out.details.navi.status, "shadow-error");
	assert.equal(bad.requests.length, 1);
});

test("on applies one search budget across multiple queries and exposes partial results", () => {
	const { out, requests } = child({ ...base, navi: { mode: "on", providers: ["brave"], limits: { maxSearchCalls: 1 } } }, `return await createStandaloneWebToolCore().webSearch({ queries: ["a", "b"] });`);
	assert.equal(requests.length, 1);
	assert.equal(out.details.navi.searchAttempts, 1);
	assert.equal(out.details.successfulQueries, 1);
	assert.equal(out.details.navi.partial, true);
	assert.ok(out.structuredContent.queries[1].error);
});

test("configured provider arrays bypass Jev and do not fall through to searchRouting", () => {
	const { out, requests } = child({ ...base, searchProvider: ["brave", "tavily"], searchRouting: { providers: ["exa"], fallbackOn: ["transient"] }, navi: { mode: "on", decision: { engine: "jev", apiKey: "!must-not-run" } } }, `return await createStandaloneWebToolCore().webSearch({ query: "q" });`);
	assert.deepEqual(out.details.queryProviders[0].providers, ["brave", "tavily"]);
	assert.equal(requests.length, 2);
	assert.equal(out.details.navi.plans[0].decision, "bypassed-explicit");
});

test("Tavily key failover and Brave retry cannot exceed the request budget", () => {
	const retryConfig = { ...base, testTavilyRetry: true, navi: { mode: "on", limits: { maxSearchCalls: 1 } } };
	const env = { TAVILY_API_KEY_1: "fixture-1", TAVILY_API_KEY_2: "fixture-2", TAVILY_API_KEY_3: "fixture-3" };
	const one = child(retryConfig, `return await createStandaloneWebToolCore().webSearch({ query: "q", provider: "tavily" });`, env);
	assert.equal(one.tavilyCalls, 1);
	assert.equal(one.out.details.navi.searchAttempts, 1);
	assert.equal(one.out.isError, true);
	assert.doesNotMatch(JSON.stringify(one.out), /private remote failure|fixture-1/);
	const three = child({ ...retryConfig, navi: { mode: "on", limits: { maxSearchCalls: 3 } } }, `return await createStandaloneWebToolCore().webSearch({ query: "q", provider: "tavily" });`, env);
	assert.equal(three.tavilyCalls, 3);
	assert.equal(three.out.isError, undefined);
	const brave = child({ ...base, testBraveRetry: true, navi: { mode: "on", limits: { maxSearchCalls: 1 } } }, `return await createStandaloneWebToolCore().webSearch({ query: "q", provider: "brave" });`);
	assert.equal(brave.braveCalls, 1);
	assert.equal(brave.out.details.navi.searchAttempts, 1);
});

test("Exa MCP advanced/basic fallback shares the same search budget", () => {
	const { out, requests } = child({ webSearch: { allowedProviders: ["exa"] }, navi: { mode: "on", limits: { maxSearchCalls: 1 } } }, `return await createStandaloneWebToolCore().webSearch({ query: "q", recencyFilter: "week" });`, { EXA_API_KEY: "" });
	assert.equal(requests.length, 1);
	assert.equal(out.details.navi.searchAttempts, 1);
	assert.equal(out.isError, true);
});

test("audited search transports reject redirects without forwarding credentials or exposing locations", () => {
	const { out, requests } = child({ ...base, testBraveRedirect: true, navi: { mode: "on" } }, `return await createStandaloneWebToolCore().webSearch({ query: "q", provider: "brave" });`);
	assert.equal(requests.length, 1);
	assert.equal(out.isError, true);
	assert.doesNotMatch(JSON.stringify(out), /private redirect|private.example.test/);
});

test("content fetch cap is awaited in Pi-style hosts without launching background work", () => {
	const { out, requests } = child({ ...base, navi: { mode: "on", limits: { maxContentFetches: 1 } } }, `
	 let background = 0; const stored = [];
	 const core = createWebToolCore({ settings: { toolNames: DEFAULT_TOOL_NAMES, enabledTools: { webSearch: true, fetchContent: true, getSearchContent: true, sourceCheck: true, xSearch: false }, maxInlineContentChars: 12000, fetchModes: { defaultMode: "readable", allowedModes: ["readable"] } }, storeFetchedContent: (_id, data) => stored.push(data), startBackgroundFetch() { background++; return "wrong"; } });
	 const result = await core.webSearch({ query: "q", provider: "brave", includeContent: true }); return { result, background, stored };
	`);
	assert.equal(out.background, 0);
	assert.equal(out.result.details.navi.contentFetches, 1);
	assert.equal(requests.filter(url => url.startsWith("http://93.")).length, 1);
	assert.equal(out.stored[0].urls.length, 2);
	assert.ok(out.stored[0].urls[1].error);
});

test("real Pi extension registration executes the shared Navi path and rejects separate workflows", () => {
	const { out, requests } = child({ ...base, navi: { mode: "on", providers: ["brave"] } }, `
	 const tools = []; (await import(${JSON.stringify(piUrl)})).default({ registerTool(t) { tools.push(t); }, registerCommand() {}, registerShortcut() {}, on() {}, appendEntry() {} });
	 const tool = tools.find(t => t.name === "web_search");
	 const ctx = { hasUI: false, modelRegistry: { getAvailable() { return []; }, find() {} }, isProjectTrusted() { return true; } };
	 const result = await tool.execute("fixture", { query: "q", workflow: "none" }, new AbortController().signal, undefined, ctx);
	 const rejected = await tool.execute("fixture2", { query: "q", workflow: "auto-summary" }, new AbortController().signal, undefined, ctx);
	 return { result, rejected };
	`);
	assert.equal(out.result.details.navi.mode, "on");
	assert.equal(out.rejected.isError, true);
	assert.equal(requests.length, 1);
});
