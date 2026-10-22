import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const searchModuleUrl = new URL("../gemini-search.ts", import.meta.url).href;

test("KeyPool configuration preserves Exa, Tavily and Firecrawl paths and caller-token auth", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-web-access-keypool-"));
	try {
		const config = {};
		for (const provider of ["exa", "tavily", "firecrawl"]) {
			config[`${provider}BaseUrl`] = `https://gateway.example.com/v1/${provider}`;
			config[`${provider}ApiKey`] = "$KEYPOOL_TEST_TOKEN";
		}
		await writeFile(join(home, "web-search.json"), JSON.stringify(config));
		const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: home, KEYPOOL_TEST_TOKEN: "fixture-caller-token" };
		for (const key of Object.keys(env)) if (/^(EXA_|TAVILY_|FIRECRAWL_)/.test(key)) delete env[key];
		const child = spawnSync(process.execPath, ["--input-type=module"], {
			env,
			encoding: "utf8",
			timeout: 15_000,
			input: `
				import assert from "node:assert/strict";
				const calls = [];
				globalThis.fetch = async (url, init) => {
					const target = new URL(url);
					const provider = target.pathname.split("/")[2];
					const headers = new Headers(init.headers);
					assert.equal(init.method, "POST");
					assert.equal(target.origin, "https://gateway.example.com");
					assert.equal(target.search, "");
					assert.equal(headers.get(provider === "exa" ? "x-api-key" : "authorization"), provider === "exa" ? "fixture-caller-token" : "Bearer fixture-caller-token");
					calls.push(target.pathname);
					const item = { title: "Fixture", url: "https://example.com/fixture", content: "snippet", description: "snippet", text: "# Fixture", raw_content: "# Fixture", markdown: "# Fixture" };
					return Response.json(provider === "firecrawl" ? { success: true, data: { web: [item] } } : { results: [item] });
				};
				const { search } = await import(${JSON.stringify(searchModuleUrl)});
				for (const provider of ["exa", "tavily", "firecrawl"]) {
					const result = await search("fixture", { provider, numResults: 1, includeContent: true, lookup: async () => [{ address: "93.184.216.34", family: 4 }] });
					assert.equal(result.provider, provider);
					assert.equal(result.results.length, 1);
					assert.equal(result.inlineContent[0].content, "# Fixture");
				}
				assert.deepEqual(calls, ["/v1/exa/search", "/v1/tavily/search", "/v1/firecrawl/v2/search"]);
			`,
		});
		assert.equal(child.status, 0, child.stderr || child.error?.message);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
