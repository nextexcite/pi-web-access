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
const sourceNote = "Gemini Web: source URLs are unverified references parsed from the generated answer, not a verified native Google search-result list.";

test("website configuration validates model syntax and verified Flash thinking levels before discovery", () => {
	assert.deepEqual(resolveGeminiWebGenerationConfig(), { model: "gemini-3.1-pro", thinking: "default" });
	for (const model of Object.keys(fixture.headers)) {
		assert.deepEqual(resolveGeminiWebGenerationConfig(model, "default"), { model, thinking: "default" });
		for (const thinking of ["standard", "extended", "off", "LOW", true, false, 0, null, {}, [], "", " default ", "__proto__"]) {
			assert.throws(() => resolveGeminiWebGenerationConfig(model, thinking), GeminiWebConfigurationError);
		}
	}
	for (const model of ["gemini-flash", "gemini-flash-lite", "gemini-3.8-flash", "gemini-3.5-flash-lite"]) {
		for (const thinking of ["low", "medium", "high"]) assert.deepEqual(resolveGeminiWebGenerationConfig(model, thinking), { model, thinking });
	}
	for (const model of ["gemini-pro", "gemini-3.1-pro", "gemini-argon", "gemini-4-argon", "gemini-unknown"]) {
		for (const thinking of ["low", "medium", "high"]) assert.throws(() => resolveGeminiWebGenerationConfig(model, thinking), /verified only for Flash/);
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

test("Lite keeps the established request endpoints and follows same-origin bootstrap redirects", async () => {
	const calls = [];
	setGeminiFetchOverrideForTests(async (url, init) => {
		const address = String(url);
		calls.push({ url: address, init });
		if (address === "https://gemini.google.com/app") return new Response(null, { status: 302, headers: { location: "/u/3/app" } });
		if (address === "https://gemini.google.com/u/3/app") return new Response('"SNlM0e":"synthetic-test-value"');
		if (address === "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=otAQ7b") return new Response(JSON.stringify(fixture.catalogResponse));
		assert.ok(address.startsWith("https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?"));
		return new Response(JSON.stringify(fixture.response));
	});
	try {
		assert.equal(await queryWithCookies("fixture", {}, { model: "gemini-flash-lite", thinking: "low" }), fixture.expectedAnswer);
		assert.equal(calls.length, 4);
		assert.deepEqual(calls.slice(0, 2).map(call => call.url), ["https://gemini.google.com/app", "https://gemini.google.com/u/3/app"]);
		for (const call of calls) assert.equal(call.init.headers["x-goog-authuser"], undefined);
		for (const call of calls.slice(2)) assert.equal(call.init.headers.referer, "https://gemini.google.com/");
		const header = JSON.parse(calls[3].init.headers["x-goog-ext-525001261-jspb"]);
		assert.equal(header[4], fixture.headers["gemini-3.5-flash-lite"]);
		assert.equal(header[15], 1);
	} finally { setGeminiFetchOverrideForTests(null); }
});

test("every advertised fixture model uses account-specific selection and default request construction", async () => {
	for (const [model, header] of Object.entries(fixture.headers)) {
		await withTransport(fixture.response, async (calls) => {
			assert.equal(await queryWithCookies(fixture.prompt, {}, { model, thinking: "default" }), fixture.expectedAnswer);
			assert.equal(calls.length, 3);
			const request = calls[2].init;
			const selection = JSON.parse(request.headers["x-goog-ext-525001261-jspb"]);
			assert.equal(selection[4], header);
			assert.equal(selection[14], fixture.modelNumbers[model]);
			assert.equal(selection[15], 1);
			const inner = JSON.parse(JSON.parse(new URLSearchParams(request.body).get("f.req"))[1]);
			assert.deepEqual(inner[0], fixture.promptPayload);
			assert.equal(inner[79], fixture.modelNumbers[model]);
			assert.equal(inner[80], 1);
			assert.equal(request.redirect, "error");
		});
	}
});

test("Flash thinking controls use the observed nonsequential UI values in both selector and body", async () => {
	for (const model of ["gemini-flash", "gemini-flash-lite", "gemini-3.8-flash", "gemini-3.5-flash-lite"]) {
		for (const [thinking, expected] of [["default", 1], ["low", 1], ["medium", 4], ["high", 2]]) {
			await withTransport(fixture.response, async calls => {
				assert.equal(await queryWithCookies(fixture.prompt, {}, { model, thinking }), fixture.expectedAnswer);
				const request = calls[2].init;
				const header = JSON.parse(request.headers["x-goog-ext-525001261-jspb"]);
				const body = JSON.parse(JSON.parse(new URLSearchParams(request.body).get("f.req"))[1]);
				assert.equal(header[15], expected);
				assert.equal(body[80], expected);
				const version = model.includes("lite") ? "gemini-3.5-flash-lite" : "gemini-3.8-flash";
				assert.equal(header[4], fixture.headers[version]);
				assert.equal(header[14], fixture.modelNumbers[version]);
				assert.equal(body[79], fixture.modelNumbers[version]);
			});
		}
	}
});

test("unsupported direct options reject before transport or upload I/O", async () => {
	await withTransport(fixture.response, async (calls) => {
		for (const options of [{ model: "toString" }, { thinking: "extended" }, { model: null }, { thinking: false }, { model: "gemini-pro", thinking: "high" }, { model: "gemini-4-argon", thinking: "low" }]) {
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

test("search preserves website selection and labels generated source references without claiming native search results", () => {
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
	assert.equal(output.response.answer, fixture.expectedAnswer + "\n\n" + sourceNote);
	assert.equal(output.response.results[0].url, "https://example.com/");
	assert.equal(output.selections[0].browser, "brave");
	assert.equal(output.selections[0].profile, "Profile 2");
});

test("configured Flash thinking levels reach the website search request without changing profile selection", () => {
	for (const [thinking, expected] of [["low", 1], ["medium", 4], ["high", 2]]) {
		const result = child({ ...fixture.config, geminiWebThinking: thinking }, `
			const {setGeminiFetchOverrideForTests} = await import(${JSON.stringify(webUrl)});
			let header, body;
			setGeminiFetchOverrideForTests(async (url, init) => {
				if (String(url).endsWith('/app')) return new Response('"SNlM0e":"synthetic-test-value"');
				if (String(url).includes('batchexecute')) return new Response(${JSON.stringify(JSON.stringify(fixture.catalogResponse))});
				header = JSON.parse(init.headers['x-goog-ext-525001261-jspb']);
				body = JSON.parse(JSON.parse(new URLSearchParams(init.body).get('f.req'))[1]);
				return new Response(${JSON.stringify(JSON.stringify(fixture.response))});
			});
			const {search} = await import(${JSON.stringify(searchUrl)});
			const response = await search('fixture question', {provider:'gemini'});
			console.log(JSON.stringify({thinkingHeader:header[15],thinkingBody:body[80],answer:response.answer,selections:cookieSelections}));
		`);
		assert.equal(result.status, 0, result.stderr);
		const output = JSON.parse(result.stdout);
		assert.equal(output.thinkingHeader, expected);
		assert.equal(output.thinkingBody, expected);
		assert.equal(output.answer, fixture.expectedAnswer + "\n\n" + sourceNote);
		assert.equal(output.selections[0].browser, "brave");
		assert.equal(output.selections[0].profile, "Profile 2");
	}
});

test("website search normalizes and caps unique structured sources, not answer links", () => {
	const sourceText = Array.from({ length: 22 }, (_, i) => `[Source ${i}](https://example.com/${i})`).join("\n");
	const response = [["wrb.fr", null, JSON.stringify([null, null, null, null, [["candidate", [sourceText + "\n" + sourceText]]]])]];
	const result = child(fixture.config, `
		const {setGeminiFetchOverrideForTests} = await import(${JSON.stringify(webUrl)});
		const prompts = [];
		setGeminiFetchOverrideForTests(async (url, init) => {
			if (String(url).endsWith('/app')) return new Response('"SNlM0e":"synthetic-test-value"');
			if (String(url).includes('batchexecute')) return new Response(${JSON.stringify(JSON.stringify(fixture.catalogResponse))});
			prompts.push(JSON.parse(JSON.parse(new URLSearchParams(init.body).get('f.req'))[1])[0][0]);
			return new Response(${JSON.stringify(JSON.stringify(response))});
		});
		const {search} = await import(${JSON.stringify(searchUrl)});
		const outputs = [];
		for (const count of [undefined, 2, 0, 2.9, 99]) {
			const response = await search('fixture question', {provider:'gemini', numResults:count});
			outputs.push({count:response.results.length, urls:response.results.map(x=>x.url), answer:response.answer});
		}
		console.log(JSON.stringify({outputs, prompts}));
	`);
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout);
	assert.deepEqual(output.outputs.map(x => x.count), [5, 2, 1, 2, 20]);
	for (const [index, count] of [5, 2, 1, 2, 20].entries()) {
		assert.match(output.prompts[index], new RegExp('at most ' + count + ' cited sources'));
		assert.equal(new Set(output.outputs[index].urls).size, count);
		assert.match(output.outputs[index].answer, /https:\/\/example.com\/21/);
	}
});

test("website search keeps domain/recency as qualified guidance and returns fewer sources when necessary", () => {
	const result = child(fixture.config, `
		const {setGeminiFetchOverrideForTests} = await import(${JSON.stringify(webUrl)});
		let prompt;
		setGeminiFetchOverrideForTests(async (url, init) => {
			if (String(url).endsWith('/app')) return new Response('"SNlM0e":"synthetic-test-value"');
			if (String(url).includes('batchexecute')) return new Response(${JSON.stringify(JSON.stringify(fixture.catalogResponse))});
			prompt = JSON.parse(JSON.parse(new URLSearchParams(init.body).get('f.req'))[1])[0][0];
			return new Response(${JSON.stringify(JSON.stringify(fixture.response))});
		});
		const {search} = await import(${JSON.stringify(searchUrl)});
		const response = await search('fixture question', {provider:'gemini', numResults:5, domainFilter:['example.org','-excluded.example'], recencyFilter:'week'});
		console.log(JSON.stringify({response, prompt}));
	`);
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout);
	assert.match(output.prompt, /Only cite sources from: example\.org/);
	assert.match(output.prompt, /Do not cite sources from: excluded\.example/);
	assert.match(output.prompt, /Only include results from the past week/);
	assert.ok(output.response.answer.includes(sourceNote));
	assert.match(output.response.answer, /Gemini Web.*best-effort.*not enforced/);
	assert.equal(output.response.results.length, 1);
	assert.equal(output.response.results[0].url, "https://example.com/");
});

test("website search removes only observed UI artifacts without changing direct extraction output", () => {
	const text = 'Useful text <em>keep ordinary HTML</em>.\n[Video](https://www.youtube.com/watch?v=public-fixture)\nhttp://googleusercontent.com/youtube_content/1\n<FollowUp label="More?" query="Public follow-up"/>';
	const response = [["wrb.fr", null, JSON.stringify([null, null, null, null, [["candidate", [text]]]])]];
	const result = child(fixture.config, `
		const {queryWithCookies, setGeminiFetchOverrideForTests} = await import(${JSON.stringify(webUrl)});
		setGeminiFetchOverrideForTests(async (url) => {
			if (String(url).endsWith('/app')) return new Response('"SNlM0e":"synthetic-test-value"');
			if (String(url).includes('batchexecute')) return new Response(${JSON.stringify(JSON.stringify(fixture.catalogResponse))});
			return new Response(${JSON.stringify(JSON.stringify(response))});
		});
		const {search} = await import(${JSON.stringify(searchUrl)});
		const response = await search('fixture question', {provider:'gemini'});
		const direct = await queryWithCookies('fixture', {}, {model:'gemini-flash'});
		console.log(JSON.stringify({response, direct}));
	`);
	assert.equal(result.status, 0, result.stderr);
	const output = JSON.parse(result.stdout);
	assert.doesNotMatch(output.response.answer, /FollowUp|googleusercontent/);
	assert.match(output.response.answer, /<em>keep ordinary HTML<\/em>/);
	assert.match(output.response.answer, /https:\/\/www.youtube.com\/watch/);
	assert.equal(output.response.results.length, 1);
	assert.equal(output.direct, text);
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
	assert.match(output.message, /supports default, low, medium, high/);
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
