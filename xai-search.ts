import { existsSync, readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activityMonitor } from "./activity.ts";
import { awaitWithAbort } from "./abortable.ts";
import { normalizeDomain } from "./domain-filter-normalization.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.ts";
import type { XSearchCallParams, XSearchTrace } from "./web-tool-contract.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import { getWebSearchConfigPath } from "./utils.ts";

// xAI's Agent Tools API: hosted `web_search` and opt-in `x_search` tools on an
// OpenAI-compatible Responses endpoint. Direct xAI API billing is separate from
// Grok website subscriptions. Gateways use an explicit search endpoint and key;
// a registered Grok model does not establish hosted search capability.
//
// Note for anyone extending this: xAI's older Live Search (`search_parameters`
// on /v1/chat/completions) is GONE. It now answers 410 with "Live search is
// deprecated. Please switch to the Agent Tools API". Do not add it back.
//
// The request body is deliberately minimal — model, input, tools — matching the
// documented Responses API shape. `stream`, `include`, `tool_choice` and
// `parallel_tool_calls` are not sent. Responses API inline citations are enabled
// by default; sources may also come back in a search call's `action.sources`.

const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
const CONFIG_PATH = getWebSearchConfigPath();
const DEFAULT_SEARCH_TIMEOUT_MS = 60_000;
const MAX_SEARCH_TIMEOUT_MS = 600_000;

// Ordered best-first. pi's builtin xai catalog is small and xAI retires models
// briskly, so this is a preference list, not an assumption: the first one the
// registry actually knows wins, and an unknown id is skipped rather than sent.
// Preserve the existing defaults and fallback order. A configured model is
// tried first for auth below, including models newer than this candidate list.
const WEB_SEARCH_AUTH_MODEL_CANDIDATES = ["grok-4.5", "grok-4.3", "grok-build-0.1"] as const;
const X_SEARCH_AUTH_MODEL_CANDIDATES = ["grok-4.6", ...WEB_SEARCH_AUTH_MODEL_CANDIDATES] as const;

type XaiSearchTool = "web_search" | "x_search";
const DEFAULT_XAI_SEARCH_TOOLS = ["web_search"] as const satisfies readonly XaiSearchTool[];

interface WebSearchConfig {
	xaiApiKey?: unknown;
	xaiResponsesUrl?: unknown;
	xaiSearchHeaders?: unknown;
	xaiSearchModel?: unknown;
	xaiSearchTimeoutMs?: unknown;
	xaiSearchTools?: unknown;
	// Migration guards only; these removed settings never select a route.
	xaiSearchProvider?: unknown;
	mcp?: unknown;
}

type ProviderHeaders = Record<string, string | null>;

interface XaiAuth {
	apiKey: string;
	model: string;
	headers: ProviderHeaders;
	responsesUrl: string;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function resolveDirectResponsesUrl(baseUrl: string): string {
	try {
		const url = new URL(baseUrl);
		const responsesUrl = `${url.href.replace(/\/+$/, "")}/responses`;
		if (responsesUrl !== XAI_RESPONSES_URL || url.username || url.password || url.href.includes("?") || url.href.includes("#")) {
			throw new Error("Unexpected registry URL");
		}
		return responsesUrl;
	} catch {
		throw new Error("Direct xAI registry credentials require the official https://api.x.ai/v1 base URL; configure xaiResponsesUrl and xaiApiKey for a gateway instead");
	}
}

function resolveConfiguredSearchHeaders(value: unknown): ProviderHeaders {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("xaiSearchHeaders must be an object");
	const headers: ProviderHeaders = {};
	for (const [name, source] of Object.entries(value)) {
		if (source !== null && typeof source !== "string") throw new Error("xaiSearchHeaders values must be credential-source strings or null");
		try { new Headers({ [name]: "check" }); } catch { throw new Error("xaiSearchHeaders contains an invalid header name"); }
		headers[name] = source;
	}
	return headers;
}

function resolveConfiguredSearchModel(value: unknown): string | undefined {
	if (value == null) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`xaiSearchModel in ${CONFIG_PATH} must be a non-empty string`);
	}
	return value.trim();
}

// A custom endpoint (for example a gateway relaying to a Grok subscription)
// only ever receives the configured xAI API key, never Pi's xAI sign-in.
function resolveConfiguredResponsesUrl(config: WebSearchConfig): string | undefined {
	if (config.xaiSearchProvider !== undefined || (config.mcp as { xai?: unknown } | undefined)?.xai !== undefined) {
		throw new Error(`Legacy xaiSearchProvider/mcp.xai settings in ${CONFIG_PATH} must be replaced with xaiResponsesUrl, xaiApiKey and optional xaiSearchHeaders`);
	}
	const value = config.xaiResponsesUrl;
	if (value === undefined) {
		if (config.xaiSearchHeaders !== undefined) throw new Error("xaiSearchHeaders requires an explicit xaiResponsesUrl");
		return undefined;
	}
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`xaiResponsesUrl in ${CONFIG_PATH} must be an absolute http(s) URL`);
	}
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error(`xaiResponsesUrl in ${CONFIG_PATH} must be an absolute http(s) URL`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`xaiResponsesUrl in ${CONFIG_PATH} must use http or https`);
	}
	if (url.username || url.password) {
		throw new Error(`xaiResponsesUrl in ${CONFIG_PATH} must not contain URL credentials`);
	}
	return url.toString();
}

function resolveConfiguredSearchTimeoutMs(value: unknown): number {
	if (value === undefined) return DEFAULT_SEARCH_TIMEOUT_MS;
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error(`xaiSearchTimeoutMs in ${CONFIG_PATH} must be a positive integer`);
	}
	return Math.min(value, MAX_SEARCH_TIMEOUT_MS);
}

function resolveConfiguredSearchTools(value: unknown): XaiSearchTool[] {
	if (value === undefined) return [...DEFAULT_XAI_SEARCH_TOOLS];
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`xaiSearchTools in ${CONFIG_PATH} must be a non-empty array containing only web_search or x_search`);
	}

	const tools: XaiSearchTool[] = [];
	for (const tool of value) {
		if (tool !== "web_search" && tool !== "x_search") {
			throw new Error(`xaiSearchTools in ${CONFIG_PATH} may only contain web_search or x_search`);
		}
		if (tools.includes(tool)) {
			throw new Error(`xaiSearchTools in ${CONFIG_PATH} must not contain duplicates: ${tool}`);
		}
		tools.push(tool);
	}
	return tools;
}

function modelCandidatesForTools(tools: readonly XaiSearchTool[]): readonly string[] {
	return tools.includes("x_search") ? X_SEARCH_AUTH_MODEL_CANDIDATES : WEB_SEARCH_AUTH_MODEL_CANDIDATES;
}

function toRequestHeaders(headers: ProviderHeaders): Record<string, string> {
	const requestHeaders: Record<string, string> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value !== null) requestHeaders[name] = value;
	}
	return requestHeaders;
}

/** Resolve xAI developer API credentials from Pi's registry before explicit API keys. */
async function resolvePiAuth(
	ctx: ExtensionContext,
	modelOverride: string | undefined,
	tools: readonly XaiSearchTool[],
	signal?: AbortSignal,
): Promise<XaiAuth | undefined> {
	const defaults = modelCandidatesForTools(tools);
	const candidates = modelOverride ? [modelOverride, ...defaults.filter(id => id !== modelOverride)] : defaults;
	for (const modelId of candidates) {
		signal?.throwIfAborted();
		let model;
		let resolved;
		try {
			model = ctx.modelRegistry.find("xai", modelId);
			if (model) resolved = await awaitWithAbort(ctx.modelRegistry.getApiKeyAndHeaders(model), signal);
		} catch {
			signal?.throwIfAborted();
			// Auth can fail, but a known custom model URL must still block API-key fallback.
		}
		signal?.throwIfAborted();
		if (!model) continue;
		const responsesUrl = resolveDirectResponsesUrl((resolved?.ok ? resolved.baseUrl : undefined) ?? model.baseUrl ?? "https://api.x.ai/v1");
		if (resolved?.ok && resolved.apiKey) {
			return { apiKey: resolved.apiKey, model: modelOverride ?? modelId, headers: resolved.headers ?? {}, responsesUrl };
		}
	}
	return undefined;
}

export async function resolveXaiAuth(ctx?: ExtensionContext, signal?: AbortSignal, effectiveTools?: readonly XaiSearchTool[]): Promise<XaiAuth | undefined> {
	signal?.throwIfAborted();
	const config = loadConfig();
	const customUrl = resolveConfiguredResponsesUrl(config);
	const headerSources = resolveConfiguredSearchHeaders(config.xaiSearchHeaders);
	const modelOverride = resolveConfiguredSearchModel(config.xaiSearchModel);
	const tools = effectiveTools ?? resolveConfiguredSearchTools(config.xaiSearchTools);
	if (ctx && customUrl === undefined) {
		const auth = await resolvePiAuth(ctx, modelOverride, tools, signal);
		signal?.throwIfAborted();
		if (auth) return auth;
	}

	const hasSource = hasCredentialSource({
		provider: "xAI",
		configuredValue: config.xaiApiKey,
		environmentValue: process.env.XAI_API_KEY,
	});
	if (!hasSource) return undefined;
	const apiKey = await resolveCredential({
		provider: "xAI",
		configuredValue: config.xaiApiKey,
		environmentValue: process.env.XAI_API_KEY,
		signal,
	});
	signal?.throwIfAborted();
	if (!apiKey) return undefined;
	try { new Headers({ Authorization: `Bearer ${apiKey}` }); } catch { throw new Error("xaiApiKey resolved an invalid HTTP credential"); }
	const headers: ProviderHeaders = {};
	for (const [name, source] of Object.entries(headerSources)) {
		if (source === null) { headers[name] = null; continue; }
		const header = await resolveCredential({ provider: "xAI header", configuredValue: source, signal });
		signal?.throwIfAborted();
		if (!header) throw new Error("xaiSearchHeaders did not resolve a value");
		try { new Headers({ [name]: header }); } catch { throw new Error("xaiSearchHeaders resolved an invalid HTTP value"); }
		headers[name] = header;
	}
	return { apiKey, model: modelOverride ?? modelCandidatesForTools(tools)[0], headers, responsesUrl: customUrl ?? XAI_RESPONSES_URL };
}

export async function isXaiSearchAvailable(ctx?: ExtensionContext): Promise<boolean> {
	let config: WebSearchConfig;
	let tools: XaiSearchTool[];
	let modelOverride: string | undefined;
	let customUrl: string | undefined;
	try {
		config = loadConfig();
		customUrl = resolveConfiguredResponsesUrl(config);
		resolveConfiguredSearchHeaders(config.xaiSearchHeaders);
		modelOverride = resolveConfiguredSearchModel(config.xaiSearchModel);
		tools = resolveConfiguredSearchTools(config.xaiSearchTools);
		resolveConfiguredSearchTimeoutMs(config.xaiSearchTimeoutMs);
		if (ctx && customUrl === undefined && await resolvePiAuth(ctx, modelOverride, tools)) return true;
	} catch {
		return false;
	}
	return hasCredentialSource({
		provider: "xAI",
		configuredValue: config.xaiApiKey,
		environmentValue: process.env.XAI_API_KEY,
	});
}

function splitDomains(domainFilter: string[] = []): { allowed: string[]; blocked: string[] } {
	const allowed: string[] = [];
	const blocked: string[] = [];
	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? blocked : allowed;
		if (!target.includes(domain)) target.push(domain);
	}
	return { allowed, blocked };
}

function buildSearchTools(tools: readonly XaiSearchTool[], domains: ReturnType<typeof splitDomains>) {
	const { allowed, blocked } = domains;
	// shortcut: mixed or >5-domain filters stay prompt-only until the API supports them.
	let filters: { allowed_domains?: string[]; excluded_domains?: string[] } | undefined;
	if (allowed.length > 0 && allowed.length <= 5 && blocked.length === 0) filters = { allowed_domains: allowed };
	else if (blocked.length > 0 && blocked.length <= 5 && allowed.length === 0) filters = { excluded_domains: blocked };
	return tools.map(type => type === "web_search" && filters ? { type, filters } : { type });
}

function buildInput(query: string, options: SearchOptions, tools: readonly XaiSearchTool[], domains: ReturnType<typeof splitDomains>): string {
	let searchInstruction: string;
	if (tools.includes("x_search") && tools.includes("web_search")) {
		searchInstruction = "Search the web and X and answer using only what the search results say.";
	} else if (tools.includes("x_search")) {
		searchInstruction = "Search X and answer using only what the X results say.";
	} else {
		searchInstruction = "Search the web and answer using only what the web results say.";
	}
	const lines = [
		searchInstruction,
		"Cite your sources inline.",
	];

	if (options.recencyFilter) {
		const labels: Record<string, string> = {
			day: "past 24 hours",
			week: "past week",
			month: "past month",
			year: "past year",
		};
		lines.push(`Prefer sources from the ${labels[options.recencyFilter]}.`);
	}

	if (typeof options.numResults === "number" && Number.isFinite(options.numResults) && options.numResults > 0) {
		lines.push(`Prefer around ${Math.min(Math.floor(options.numResults), 20)} distinct sources.`);
	}

	const { allowed, blocked } = domains;
	if (allowed.length > 0) lines.push(`Only use sources from: ${allowed.slice(0, 100).join(", ")}.`);
	if (blocked.length > 0) lines.push(`Do not use sources from: ${blocked.slice(0, 100).join(", ")}.`);

	return `${lines.join(" ")}\n\n${query}`;
}

function addResult(results: SearchResult[], seen: Set<string>, url: unknown, title: unknown, snippet = ""): void {
	if (typeof url !== "string" || url.trim().length === 0) return;
	if (seen.has(url)) return;
	seen.add(url);
	results.push({
		title: typeof title === "string" && title.trim().length > 0 ? title : url,
		url,
		snippet,
	});
}

function addSource(results: SearchResult[], seen: Set<string>, source: unknown): void {
	if (typeof source === "string") {
		addResult(results, seen, source, undefined);
		return;
	}
	if (!source || typeof source !== "object") return;
	const record = source as Record<string, unknown>;
	addResult(results, seen, record.url ?? record.source_website_url, record.title ?? record.caption);
}

function addSources(results: SearchResult[], seen: Set<string>, sources: unknown): void {
	if (!Array.isArray(sources)) return;
	for (const source of sources) addSource(results, seen, source);
}

function extractSnippetAround(text: string, start: unknown, end: unknown): string {
	if (typeof start !== "number" || typeof end !== "number" || !text) return "";
	const before = Math.max(0, start - 100);
	const after = Math.min(text.length, end + 100);
	const snippet = text.slice(before, after).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").trim();
	return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

function extractAnswer(output: unknown[]): string {
	const parts: string[] = [];
	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string" && text.trim().length > 0) parts.push(text);
		}
	}
	return parts.join("\n").trim();
}

/**
 * Keep annotation sources first because they carry titles and offsets and must
 * win URL deduplication. Raw source lists from web/X search calls are next,
 * followed by xAI's response-level `citations` URL list. The latter is usually
 * strings, but object entries are tolerated when a compatible gateway adds
 * metadata.
 */
function extractSearchResults(output: unknown[], citations: unknown, numResults: number | undefined): SearchResult[] {
	const results: SearchResult[] = [];
	const seenUrls = new Set<string>();

	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
			const annotations = (part as { annotations?: unknown }).annotations;
			if (!Array.isArray(annotations)) continue;
			for (const annotation of annotations) {
				if (!annotation || typeof annotation !== "object") continue;
				if ((annotation as { type?: unknown }).type !== "url_citation") continue;
				addResult(
					results,
					seenUrls,
					(annotation as { url?: unknown }).url,
					(annotation as { title?: unknown }).title,
					extractSnippetAround(text, (annotation as { start_index?: unknown }).start_index, (annotation as { end_index?: unknown }).end_index),
				);
			}
		}
	}

	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		const type = (item as { type?: unknown }).type;
		if (type !== "web_search_call" && type !== "x_search_call") continue;
		const value = item as { action?: unknown; sources?: unknown; results?: unknown };
		const actionSources = value.action && typeof value.action === "object"
			? (value.action as { sources?: unknown }).sources
			: undefined;
		for (const group of [actionSources, value.sources, value.results]) addSources(results, seenUrls, group);
	}

	addSources(results, seenUrls, citations);

	if (typeof numResults === "number" && Number.isFinite(numResults) && numResults > 0) {
		return results.slice(0, Math.min(Math.floor(numResults), 20));
	}
	return results;
}

export const X_SEARCH_LIMITATIONS = "Handle/date bounds constrain native search, not guaranteed answer membership; thread fetches may fall outside them. Native subtool choice is model-driven; optional activity metadata is observation only. Sources are not independently verified.";

function validateXSearchParams(value: unknown): XSearchCallParams {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("x_search requires an object");
	const params = value as Record<string, unknown>;
	const keys = ["query", "allowed_x_handles", "excluded_x_handles", "from_date", "to_date", "enable_image_understanding", "enable_video_understanding"];
	for (const key of Object.keys(params)) {
		if (!keys.includes(key)) throw new Error(`x_search does not support ${key}`);
	}
	if (typeof params.query !== "string" || !params.query.trim()) throw new Error("x_search query must be a nonblank string");
	for (const key of ["allowed_x_handles", "excluded_x_handles"] as const) {
		const handles = params[key];
		if (handles === undefined) continue;
		if (!Array.isArray(handles) || handles.length < 1 || handles.length > 20 || handles.some(handle => typeof handle !== "string" || !/^[A-Za-z0-9_]{1,15}$/.test(handle))) {
			throw new Error(`x_search ${key} must contain 1–20 handles without @ (1–15 letters, digits or underscores each)`);
		}
		if (new Set(handles.map(handle => handle.toLowerCase())).size !== handles.length) throw new Error(`x_search ${key} must not contain duplicate handles`);
	}
	if (params.allowed_x_handles !== undefined && params.excluded_x_handles !== undefined) throw new Error("x_search allowed_x_handles and excluded_x_handles are mutually exclusive");
	for (const key of ["from_date", "to_date"] as const) {
		const date = params[key];
		if (date === undefined) continue;
		if (typeof date !== "string" || !/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
			throw new Error(`x_search ${key} must be a real YYYY-MM-DD UTC calendar date, not a datetime`);
		}
	}
	if (params.from_date !== undefined && params.to_date !== undefined && (params.to_date as string) <= (params.from_date as string)) throw new Error("x_search to_date must be after from_date (exclusive end)");
	for (const key of ["enable_image_understanding", "enable_video_understanding"] as const) {
		if (params[key] !== undefined && typeof params[key] !== "boolean") throw new Error(`x_search ${key} must be a boolean`);
	}
	return { ...params, query: params.query.trim(), enable_image_understanding: params.enable_image_understanding ?? false, enable_video_understanding: params.enable_video_understanding ?? false } as XSearchCallParams;
}

// Rebuild the allowlisted metadata: never pass through arguments, IDs or callable tools.
function readXSearchTrace(value: unknown): XSearchTrace | undefined {
	if (!value || typeof value !== "object") return undefined;
	const trace = value as Record<string, unknown>;
	const availability = trace.availability;
	if (trace.version !== 1 || trace.executable !== false || trace.observed_only !== true || typeof trace.truncated !== "boolean"
		|| (availability !== "observed" && availability !== "not_observed") || !Array.isArray(trace.activities) || trace.activities.length > 128) return undefined;
	const activities: XSearchTrace["activities"] = [];
	for (const item of trace.activities) {
		if (!item || typeof item !== "object") return undefined;
		const operation = (["x_keyword_search", "x_semantic_search", "x_user_search", "x_thread_fetch"] as const).find(name => name === item.operation);
		const status = (["in_progress", "completed", "incomplete", "failed", "cancelled", "unknown"] as const).find(name => name === item.status);
		if (!operation || !status || !Number.isSafeInteger(item.ordinal) || item.ordinal < 1) return undefined;
		activities.push({ ordinal: item.ordinal, operation, status });
	}
	if ((availability === "observed") !== (activities.length > 0)) return undefined;
	return { version: 1, executable: false, observed_only: true, availability, truncated: trace.truncated, activities };
}

type XSearchResponse = SearchResponse & { x_cpa_x_search_trace?: XSearchTrace };

export async function searchX(params: XSearchCallParams, signal?: AbortSignal, ctx?: ExtensionContext): Promise<XSearchResponse> {
	signal?.throwIfAborted();
	const { query, ...nativeX } = validateXSearchParams(params);
	return executeXaiSearch(query, { signal }, ctx, ["x_search"], nativeX);
}

export async function searchWithXai(query: string, options: SearchOptions = {}, ctx?: ExtensionContext): Promise<SearchResponse> {
	return executeXaiSearch(query, options, ctx, resolveConfiguredSearchTools(loadConfig().xaiSearchTools));
}

async function executeXaiSearch(
	query: string,
	options: SearchOptions,
	ctx: ExtensionContext | undefined,
	tools: readonly XaiSearchTool[],
	nativeX?: Omit<XSearchCallParams, "query">,
): Promise<XSearchResponse> {
	options.signal?.throwIfAborted();
	const config = loadConfig();
	const customUrl = resolveConfiguredResponsesUrl(config);
	const timeoutMs = resolveConfiguredSearchTimeoutMs(config.xaiSearchTimeoutMs);
	const auth = await resolveXaiAuth(ctx, options.signal, tools);
	options.signal?.throwIfAborted();
	if (!auth) {
		if (customUrl) {
			throw new Error(
				`xAI search unavailable: xaiResponsesUrl is set, so Pi's xAI sign-in is not used. ` +
				`Set xaiApiKey in ${CONFIG_PATH} or the XAI_API_KEY environment variable to the key for that endpoint.`,
			);
		}
		throw new Error(
			"xAI search requires xAI developer API credentials. Pi's xAI registry credentials, xaiApiKey, or XAI_API_KEY may be used; Grok website access alone does not authenticate API requests, and subscription/API billing is separate.",
		);
	}

	const domains = splitDomains(options.domainFilter);
	const redactError = (message: string) => {
		for (const credential of [auth.apiKey, ...Object.values(auth.headers)]) {
			if (credential) message = redactCredential(message, credential);
		}
		return message;
	};
	const activityId = activityMonitor.logStart({ type: "api", query });
	const deadline = AbortSignal.timeout(timeoutMs);
	try {
		const headers = new Headers(toRequestHeaders(auth.headers));
		headers.set("Authorization", `Bearer ${auth.apiKey}`);
		headers.set("Content-Type", "application/json");
		const response = await fetch(auth.responsesUrl, {
			// Provider headers may contain secrets; never forward them to a redirect target.
			redirect: "error",
			method: "POST",
			headers,
			body: JSON.stringify({
				model: auth.model,
				input: buildInput(query, options, tools, domains),
				tools: nativeX ? [{ type: "x_search", ...nativeX }] : buildSearchTools(tools, domains),
			}),
			signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline,
		});

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = redactError(await response.text());
			throw new Error(`xAI API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		let parsed: Record<string, unknown>;
		try {
			parsed = await response.json() as Record<string, unknown>;
		} catch (err) {
			if (deadline.aborted || options.signal?.aborted) throw err;
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`xAI API returned invalid JSON: ${message}`);
		}
		if (nativeX && (!parsed || parsed.status !== "completed" || parsed.error)) throw new Error("xAI X search did not return a completed response");
		const output = Array.isArray(parsed.output) ? parsed.output : [];
		const answer = extractAnswer(output);
		const results = extractSearchResults(output, parsed.citations, options.numResults);

		if (!answer && results.length === 0) {
			throw new Error(`xAI ${tools.join("+")} returned no answer or sources`);
		}

		activityMonitor.logComplete(activityId, response.status);
		const trace = nativeX ? readXSearchTrace(parsed.x_cpa_x_search_trace) : undefined;
		return { answer, results, ...(trace ? { x_cpa_x_search_trace: trace } : {}) };
	} catch (err) {
		if (deadline.aborted && !options.signal?.aborted) {
			const message = `xAI search timed out after ${timeoutMs / 1000} seconds`;
			activityMonitor.logError(activityId, message);
			throw new Error(message);
		}
		const message = err instanceof Error ? err.message : String(err);
		const redactedMessage = redactError(message);
		if (redactedMessage.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, redactedMessage);
		}
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
}
