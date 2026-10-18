import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveGeminiWebGenerationConfig, GeminiWebConfigurationError } from "../gemini-web-config.ts";
import { queryWithCookies, setGeminiFetchOverrideForTests } from "../gemini-web.ts";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/gemini-web-generation.json", import.meta.url), "utf8"));
const searchUrl = new URL("../gemini-search.ts", import.meta.url).href;
const webUrl = new URL("../gemini-web.ts", import.meta.url).href;
const configUrl = new URL("../gemini-web-config.ts", import.meta.url).href;

test("website configuration validates model name syntax and default thinking before discovery", () => {
	assert.deepEqual(resolveGeminiWebGenerationConfig(), { model: "gemini-3.1-pro", thinking: "default" });
	for (const model of Object.keys(fixture.headers)) {
		assert.deepEqual(resolveGeminiWebGenerationConfig(model, "default"), { model, thinking: "default" });
		for (const thinking of ["standard", "extended", "off", "low", "medium", "high", true, false, 0, null, {}, [], "", " default "]) {
			assert.throws(() => resolveGeminiWebGenerationConfig(model, thinking), GeminiWebConfigurationError);
		}
	}
	for (const model of [null, true, 3, {}, [], "", "gemini--pro", " gemini-3.1-pro", "toString", "__proto__"]) {
		assert.throws(() => resolveGeminiWebGenerationConfig(model), GeminiWebConfigurationError);
	}
});

async function withTransport(response, fn) {
	const calls = [];
	setGeminiFetchOverrideForTests(async (url, init) => {
		calls.push({ url: String(url), init });
		if (String(url) === "https://gemini.google.com/app") return new Response('"SNlM0e":"synthetic-test-value"');
		if (String(url).includes("batchexecute")) return new Response(JSON.stringify(fixture.catalogResponse));
		return new Response(typeof response === "string" ? response : JSON.stringify(response));
	});
	try { await fn(calls); } finally { setGeminiFetchOverrideForTests(null); }
}

test("every advertised fixture model uses account-specific selection and default request construction", async () => {
	for (const [model, header] of Object.entries(fixture.headers)) {
		await withTransport(fixture.response, async (calls) => {
			assert.equal(await queryWithCookies(fixture.prompt, {}, { model, thinking: "default" }), fixture.expectedAnswer);
			assert.equal(calls.length, 3);
			const request = calls[2].init;
			assert.equal(JSON.parse(request.headers["x-goog-ext-525001261-jspb"])[4], header);
			const inner = JSON.parse(JSON.parse(new URLSearchParams(request.body).get("f.req"))[1]);
			assert.deepEqual(inner[0], fixture.promptPayload);
			assert.equal(inner[79], fixture.modelNumbers[model]);
			assert.equal(inner[80], 1);
			assert.equal(request.redirect, "error");
		});
	}
});

test("unsupported direct options reject before transport or upload I/O", async () => {
	await withTransport(fixture.response, async (calls) => {
		for (const options of [{ model: "toString" }, { thinking: "extended" }, { model: null }, { thinking: false }]) {
			await assert.rejects(queryWithCookies("fixture", {}, { ...options, files: [{ path: "/not-a-real-fixture", mimeType: "text/plain" }] }), GeminiWebConfigurationError);
		}
		assert.equal(calls.length, 0);
	});
});

test("parser keeps the latest nonempty candidate and rejects empty responses", async () => {
	const first = JSON.parse(JSON.stringify(fixture.response[0]));
	first[2] = JSON.stringify([null, null, null, null, [["candidate", ["Earlier answer"]]]]);
	const empty = ["wrb.fr", null, JSON.stringify([null, null, null, null, [["candidate", [""]]]])];
	await withTransport([first, ...fixture.response, empty], async () => {
		assert.equal(await queryWithCookies("fixture", {}), fixture.expectedAnswer);
	});
	await withTransport([empty], async () => { await assert.rejects(queryWithCookies("fixture", {}), /empty response/); });
});

test("model rejection in a later stream part cannot be mistaken for successful partial text", async () => {
	const error = ["er", null, null, null, null, [null, null, [[null, [1052]]]]];
	await withTransport([...fixture.response, error], async (calls) => {
		await assert.rejects(queryWithCookies("fixture", {}), /code 1052.*No alternate model/);
		assert.equal(calls.length, 3);
	});
});

function child(config, script, { api = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "gemini-web-generation-"));
	writeFileSync(join(dir, "web-search.json"), JSON.stringify(config));
	// A minimal environment prevents inherited credentials, cookie opt-ins and ADC discovery.
	const env = { PATH: process.env.PATH, HOME: dir, USERPROFILE: dir, PI_CODING_AGENT_DIR: dir, METADATA_SERVER_DETECTION: "none" };
	if (api) env.GEMINI_API_KEY = "synthetic-test-value";
	const prelude = `
		import { registerHooks } from 'node:module';
		globalThis.cookieSelections = [];
		registerHooks({ load(url, context, nextLoad) {
			if (url.endsWith('/chrome-cookies.ts')) return { format: 'module', shortCircuit: true, source: \`
				export const getLastGoogleCookieDiagnostic = () => null;
				export const getLastGoogleCookieDiagnosticDetails = () => null;
				export const getLastBrowserCookieDiagnostic = () => null;
				export const getBrowserCookiesForHosts = () => { throw new Error('unexpected cookie lookup'); };
				export const getGoogleCookies = async (selection) => { globalThis.cookieSelections.push(selection); return {cookies: {}}; };
			\` };
			return nextLoad(url, context);
		}});
		globalThis.fetch = async () => { throw new Error('unexpected network'); };
	`;
	try {
		return spawnSync(process.execPath, ["--input-type=module"], { input: prelude + script, encoding: "utf8", env, timeout: 20000 });
	} finally { rmSync(dir, { recursive: true, force: true }); }
}

test("search wires website settings while preserving explicit Brave profile and source parsing", () => {
	const result = child(fixture.config, `
		const {setGeminiFetchOverrideForTests} = await import(${JSON.stringify(webUrl)});
		let header;
		setGeminiFetchOverrideForTests(async (url, init) => {
			if (String(url).endsWith('/app')) return new Response('"SNlM0e":"synthetic-test-value"');
			if (String(url).includes('batchexecute')) return new Response(${JSON.stringify(JSON.stringify(fixture.catalogResponse))});
			header = init.headers['x-goog-ext-525001261-jspb'];
			return new Response(${JSON.stringify(JSON.stringify(fixture.response))});
		});
		const {search} = await import(${JSON.stringify(searchUrl)});
		const response = await search('fixture question', {provider: 'gemini'});
		console.log(JSON.stringify({response, header, selections: cookieSelections}));
	`);
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout);
	assert.equal(JSON.parse(output.header)[4], fixture.headers[fixture.config.geminiWebModel]);
	assert.equal(output.response.answer, fixture.expectedAnswer);
	assert.equal(output.response.results[0].url, "https://example.com/");
	assert.equal(output.selections[0].browser, "brave");
	assert.equal(output.selections[0].profile, "Profile 2");
});

test("website fallback rejects explicit thinking after API failure and before cookie lookup", () => {
	const result = child({ ...fixture.config, geminiWebThinking: "extended" }, `
		let apiCalls = 0;
		globalThis.fetch = async () => { apiCalls++; throw new Error('synthetic API failure'); };
		const {search} = await import(${JSON.stringify(searchUrl)});
		try { await search('fixture question', {provider: 'gemini'}); throw new Error('unexpected success'); }
		catch (error) { console.log(JSON.stringify({name: error.name, message: error.message, apiCalls, selections: cookieSelections})); }
	`, { api: true });
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout);
	assert.equal(output.name, "GeminiWebConfigurationError");
	assert.match(output.message, /only supports "default"/);
	assert.equal(output.apiCalls, 1);
	assert.deepEqual(output.selections, []);
});

test("API searchModel stays independent of a valid website selection", () => {
	const result = child(fixture.config, `
		let requestedUrl;
		globalThis.fetch = async (url) => { requestedUrl = String(url); return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'API fixture answer'}]}}]})); };
		const {search} = await import(${JSON.stringify(searchUrl)});
		const response = await search('fixture question', {provider:'gemini'});
		console.log(JSON.stringify({requestedUrl, answer:response.answer, selections:cookieSelections}));
	`, { api: true });
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout);
	assert.match(output.requestedUrl, /models\/gemini-api-fixture-model:generateContent/);
	assert.equal(output.answer, "API fixture answer");
	assert.deepEqual(output.selections, []);
});

test("configuration reader rejects non-object input without echoing contents", () => {
	for (const config of [null, [], "sensitive-looking-fixture"]) {
		const result = child(config, `
			const {getGeminiWebGenerationConfigFromConfig} = await import(${JSON.stringify(configUrl)});
			try { getGeminiWebGenerationConfigFromConfig(); } catch(error) { console.log(error.message); }
		`);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /must be a JSON object/);
		assert.doesNotMatch(result.stdout, /sensitive-looking/);
	}
});

test("auto availability rejects unsupported thinking before cookie access", () => {
	const result = child({ ...fixture.config, webSearch: { allowedProviders: ["gemini"] }, geminiWebThinking: "standard" }, `
		const {search} = await import(${JSON.stringify(searchUrl)});
		try { await search('fixture question', {provider:'auto'}); throw new Error('unexpected success'); }
		catch (error) { console.log(JSON.stringify({name:error.name, selections:cookieSelections})); }
	`);
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout);
	assert.equal(output.name, "GeminiWebConfigurationError");
	assert.deepEqual(output.selections, []);
});

test("website configuration alone never opts into browser cookies", () => {
	const result = child({ ...fixture.config, allowBrowserCookies: false }, `
		const {search} = await import(${JSON.stringify(searchUrl)});
		try { await search('fixture question', {provider:'gemini'}); throw new Error('unexpected success'); }
		catch (error) { console.log(JSON.stringify({message:error.message, selections:cookieSelections})); }
	`);
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout);
	assert.match(output.message, /Gemini search unavailable/);
	assert.deepEqual(output.selections, []);
});


test("valid API search ignores invalid unused website settings, including with cookie access disabled", () => {
	for (const allowBrowserCookies of [false, true]) {
		for (const invalid of [{ geminiWebModel: "not-a-website-model" }, { geminiWebThinking: "extended" }]) {
			const result = child({ ...fixture.config, allowBrowserCookies, ...invalid }, `
				let apiCalls = 0;
				globalThis.fetch = async () => { apiCalls++; return new Response(JSON.stringify({candidates:[{content:{parts:[{text:'API fixture answer'}]}}]})); };
				const {search} = await import(${JSON.stringify(searchUrl)});
				const response = await search('fixture question', {provider:'gemini'});
				console.log(JSON.stringify({answer:response.answer, apiCalls, selections:cookieSelections}));
			`, { api: true });
			assert.equal(result.status, 0, result.stderr);
			assert.deepEqual(JSON.parse(result.stdout), { answer: "API fixture answer", apiCalls: 1, selections: [] });
		}
	}
});
