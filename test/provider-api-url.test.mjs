import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveProviderApiUrl } from "../utils.ts";

test("provider URL resolution keeps endpoint paths and derives multiword environment names", () => {
	const previous = process.env.MISTRAL_SEARCH_BASE_URL;
	try {
		delete process.env.MISTRAL_SEARCH_BASE_URL;
		assert.equal(resolveProviderApiUrl("mistralSearch", "https://api.mistral.ai/v1/conversations", "https://gateway.example.com/mistral///"),
			"https://gateway.example.com/mistral/v1/conversations");
		process.env.MISTRAL_SEARCH_BASE_URL = "http://localhost:8080/mistral/";
		assert.equal(resolveProviderApiUrl("mistralSearch", "https://api.mistral.ai/v1/conversations", "not-a-url"),
			"http://localhost:8080/mistral/v1/conversations");
		process.env.MISTRAL_SEARCH_BASE_URL = "";
		assert.throws(() => resolveProviderApiUrl("mistralSearch", "https://api.mistral.ai/v1/conversations", "https://gateway.example.com"),
			/MISTRAL_SEARCH_BASE_URL must be/);
	} finally {
		if (previous === undefined) delete process.env.MISTRAL_SEARCH_BASE_URL;
		else process.env.MISTRAL_SEARCH_BASE_URL = previous;
	}
});

test("provider URL resolution preserves root trailing slashes needed for path-based APIs", () => {
	const previous = process.env.JINA_SEARCH_BASE_URL;
	try {
		delete process.env.JINA_SEARCH_BASE_URL;
		assert.equal(resolveProviderApiUrl("jinaSearch", "https://s.jina.ai/", "https://gateway.example.com/jina/"),
			"https://gateway.example.com/jina/");
	} finally {
		if (previous === undefined) delete process.env.JINA_SEARCH_BASE_URL;
		else process.env.JINA_SEARCH_BASE_URL = previous;
	}
});
