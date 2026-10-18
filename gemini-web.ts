import { randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { getLastGoogleCookieDiagnostic, getLastGoogleCookieDiagnosticDetails, type BrowserCookieDiagnosticDetails, type CookieMap, getGoogleCookies } from "./chrome-cookies.ts";
import { GeminiWebConfigurationError, resolveGeminiWebGenerationConfig, getBrowserCookieSelectionFromConfig, isBrowserCookieAccessAllowed, normalizeChromeProfile } from "./gemini-web-config.ts";

const GEMINI_APP_URL = "https://gemini.google.com/app";
const GEMINI_STREAM_GENERATE_URL =
	"https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const GEMINI_UPLOAD_URL = "https://content-push.googleapis.com/upload";
const GEMINI_UPLOAD_PUSH_ID = "feeds/mcudyrk2a4khkz";
const GOOGLE_LIST_ACCOUNTS_URL =
	"https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&laf=b64bin&json=standard";

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MODEL_HEADER_NAME = "x-goog-ext-525001261-jspb";
export { DEFAULT_GEMINI_WEB_MODEL } from "./gemini-web-config.ts";
const GEMINI_BATCH_URL = "https://gemini.google.com/_/BardChatUi/data/batchexecute?rpcids=otAQ7b";

interface WebsiteModel {
	id: string;
	number: number;
	capacity: number;
}

const REQUIRED_COOKIES = ["__Secure-1PSID", "__Secure-1PSIDTS"];

// Gemini Web talks to Google's frontend inside the host agent (pi), whose
// global undici dispatcher runs HTTP/1.1 with undici's default 16 KiB
// maxHeaderSize. Google's gemini.google.com /app response headers routinely
// exceed that budget over HTTP/1.1, so cookie-bearing requests fail with
// UND_ERR_HEADERS_OVERFLOW surfaced as "fetch failed". Route these requests
// through a dedicated undici Agent with a larger header budget instead; fall
// back to the ambient global fetch when undici is not resolvable (e.g.
// standalone test environments).
let geminiFetchImpl: typeof fetch | null = null;

// Test-only hook: lets tests inject a simulated transport instead of patching
// globalThis.fetch. Gemini Web deliberately bypasses the ambient global fetch
// (inside the pi host agent it is constrained to undici's 16 KiB
// maxHeaderSize and cannot serve Google's /app page over HTTP/1.1), so
// globalThis.fetch patching is no longer a reliable way to intercept these
// requests.
export function setGeminiFetchOverrideForTests(fetchImpl: typeof fetch | null): void {
	geminiFetchOverride = fetchImpl;
}

let geminiFetchOverride: typeof fetch | null = null;

// The header budget Gemini Web needs for Google frontend responses.
// Google's /app page exceeds undici's default 16 KiB maxHeaderSize when
// served over HTTP/1.1, which is how pi's global dispatcher operates.
export const GEMINI_MAX_HEADER_SIZE = 4 * 1024 * 1024;

// Build a fetch that routes through a dedicated undici Agent with a larger
// header budget than the host agent's global dispatcher allows. Exported for
// tests so the agent configuration can be asserted without network access.
export function createGeminiFetch(undiciImpl: typeof import("undici")): typeof fetch {
	const agent = new undiciImpl.EnvHttpProxyAgent({
		allowH2: false,
		connectTimeout: 30_000,
		maxHeaderSize: GEMINI_MAX_HEADER_SIZE,
		pipelining: 1,
	});
	type UndiciFetch = typeof undiciImpl.fetch;
	// SAFETY: Internal callers pass URL strings and standard init fields; the response fields used here are shared, while Undici v8 and DOM declarations differ on unused Request/Headers members.
	return (input, init) =>
		undiciImpl.fetch(
			input as unknown as Parameters<UndiciFetch>[0],
			{ ...init, dispatcher: agent } as unknown as Parameters<UndiciFetch>[1],
		) as unknown as Promise<Response>;
}

export async function resolveGeminiFetch(): Promise<typeof fetch> {
	if (geminiFetchOverride) return geminiFetchOverride;
	if (geminiFetchImpl) return geminiFetchImpl;

	let undici: typeof import("undici");
	try {
		undici = await import("undici");
	} catch {
		geminiFetchImpl = fetch;
		return geminiFetchImpl;
	}

	geminiFetchImpl = createGeminiFetch(undici);
	return geminiFetchImpl;
}

export interface GeminiWebOptions {
	youtubeUrl?: string;
	model?: string;
	/** Only "default" is supported; explicit thinking overrides fail before any I/O. */
	thinking?: string;
	files?: GeminiWebFile[];
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface GeminiWebFile {
	path: string;
	mimeType: string;
}

export async function isGeminiWebAvailable(chromeProfile?: string): Promise<CookieMap | null> {
	if (!isBrowserCookieAccessAllowed()) return null;

	const configured = getBrowserCookieSelectionFromConfig();
	const result = await getGoogleCookies({
		browser: configured.browser,
		profile: normalizeChromeProfile(chromeProfile) ?? configured.profile,
		requiredCookies: REQUIRED_COOKIES,
	});
	if (!result) return null;
	return result.cookies;
}

export function getGeminiWebAvailabilityDiagnostic(): string | null {
	return isBrowserCookieAccessAllowed() ? getLastGoogleCookieDiagnostic() : null;
}

export function getGeminiWebAvailabilityDiagnosticDetails(): BrowserCookieDiagnosticDetails | null {
	return isBrowserCookieAccessAllowed() ? getLastGoogleCookieDiagnosticDetails() : null;
}

export async function getActiveGoogleEmail(cookies: CookieMap): Promise<string | null> {
	const cookieHeader = buildCookieHeader(cookies);
	if (!cookieHeader) return null;

	try {
		const html = await fetchWithCookieRedirects(
			GEMINI_APP_URL,
			cookieHeader,
			10,
			AbortSignal.timeout(10000),
		);
		const email = extractEmailFromGeminiHtml(html);
		if (email) return email;
	} catch {
		// Try the account-list endpoint when the Gemini page does not expose the account.
	}

	try {
		const response = await fetchWithCookieRedirects(
			GOOGLE_LIST_ACCOUNTS_URL,
			cookieHeader,
			10,
			AbortSignal.timeout(10000),
		);
		return extractEmailFromListAccounts(response);
	} catch {
		return null;
	}
}

export async function queryWithCookies(
	prompt: string,
	cookieMap: CookieMap,
	options: GeminiWebOptions = {},
): Promise<string> {
	const { model } = resolveGeminiWebGenerationConfig(options.model, options.thinking);
	const timeoutMs = options.timeoutMs ?? 120000;

	let fullPrompt = prompt;
	if (options.youtubeUrl) {
		fullPrompt = `${fullPrompt}\n\nYouTube video: ${options.youtubeUrl}`;
	}

	const result = await runGeminiWebOnce(fullPrompt, cookieMap, model, options.files, timeoutMs, options.signal);

	if (result.errorCode) throw new Error(`Gemini Web rejected the request (code ${result.errorCode}); the selected model may be unavailable or the website protocol may have changed. No alternate model was requested.`);
	if (result.errorMessage) throw new Error(result.errorMessage);
	if (!result.text) throw new Error("Gemini Web returned empty response");
	return result.text;
}

interface GeminiWebResult {
	text: string;
	errorCode?: number;
	errorMessage?: string;
}

async function runGeminiWebOnce(
	prompt: string,
	cookieMap: CookieMap,
	model: string,
	files: GeminiWebFile[] | undefined,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<GeminiWebResult> {
	const effectiveSignal = withTimeout(signal, timeoutMs);
	const cookieHeader = buildCookieHeader(cookieMap);
	const accessToken = await fetchAccessToken(cookieHeader, effectiveSignal);
	const selected = await discoverWebsiteModel(model, cookieHeader, accessToken, effectiveSignal);
	const requestId = randomUUID().toUpperCase();
	const modelHeader = [1, null, null, null, selected.id, null, null, 0, [4, 5, 6, 8], null, null, selected.capacity, null, null, selected.number, 1, randomUUID().toUpperCase()];

	const uploaded: Array<{ id: string; name: string }> = [];
	if (files) {
		for (const file of files) {
			uploaded.push(await uploadFile(file, cookieHeader, effectiveSignal));
		}
	}

	const fReq = buildFReqPayload(prompt, uploaded, selected.number, requestId);
	const params = new URLSearchParams();
	params.set("at", accessToken);
	params.set("f.req", fReq);

	const res = await (await resolveGeminiFetch())(`${GEMINI_STREAM_GENERATE_URL}?hl=en&_reqid=${randomInt(10000, 100000)}&rt=c`, {
		method: "POST",
		redirect: "error",
		headers: {
			"content-type": "application/x-www-form-urlencoded;charset=utf-8",
			host: "gemini.google.com",
			origin: "https://gemini.google.com",
			referer: "https://gemini.google.com/",
			"x-same-domain": "1",
			"user-agent": USER_AGENT,
			cookie: cookieHeader,
			[MODEL_HEADER_NAME]: JSON.stringify(modelHeader),
			"x-goog-ext-73010989-jspb": "[0]",
			"x-goog-ext-73010990-jspb": "[0,0,0]",
			"x-goog-ext-525005358-jspb": JSON.stringify([requestId, 1]),
		},
		body: params.toString(),
		signal: effectiveSignal,
	});

	const rawText = await res.text();

	if (!res.ok) {
		return { text: "", errorMessage: `Gemini Web HTTP ${res.status}` };
	}

	try {
		return parseStreamGenerateResponse(rawText);
	} catch (err) {
		let errorCode: number | undefined;
		try {
			const json = parseResponseParts(rawText);
			errorCode = extractErrorCode(json);
		} catch {
			// Keep the original sanitized parse error if framing prevents a second code scan.
		}
		return {
			text: "",
			errorCode,
			errorMessage: err instanceof Error ? err.message : String(err),
		};
	}
}

async function discoverWebsiteModel(name: string, cookieHeader: string, accessToken: string, signal: AbortSignal): Promise<WebsiteModel> {
	const response = await (await resolveGeminiFetch())(GEMINI_BATCH_URL, {
		method: "POST", redirect: "error", signal,
		headers: {
			cookie: cookieHeader, "user-agent": USER_AGENT,
			origin: "https://gemini.google.com", referer: "https://gemini.google.com/",
			"content-type": "application/x-www-form-urlencoded;charset=utf-8", "x-same-domain": "1",
			[MODEL_HEADER_NAME]: "[1,null,null,null,null,null,null,null,[4,5,6,8],null,null,null,null,null,null,null]",
			"x-goog-ext-73010989-jspb": "[0]",
		},
		body: new URLSearchParams({ at: accessToken, "f.req": JSON.stringify([[["otAQ7b", "[]", null, "generic"]]]) }).toString(),
	});
	if (!response.ok) throw new Error(`Gemini Web model discovery HTTP ${response.status}`);
	for (const part of parseResponseParts(await response.text())) {
		if (getNestedValue(part, [1]) !== "otAQ7b") continue;
		let data: unknown;
		try { data = JSON.parse(String(getNestedValue(part, [2]))); }
		catch { throw new Error("Gemini Web invalid response: malformed model catalog"); }
		const models = getNestedValue(data, [15]);
		const tierFlags = getNestedValue(data, [16]);
		const capabilityFlags = getNestedValue(data, [17]);
		if (!Array.isArray(models) || !Array.isArray(tierFlags) || !Array.isArray(capabilityFlags) || !tierFlags.every(Number.isSafeInteger) || !capabilityFlags.every(Number.isSafeInteger)) break;
		// Account-derived capacity follows the pinned public reference; unobserved sparse tiers fail closed.
		if (tierFlags.includes(21) || tierFlags.includes(22)) throw new Error("Gemini Web model catalog uses an unsupported account capacity format");
		let capacity = 1;
		if (capabilityFlags.includes(115)) capacity = 4;
		else if (tierFlags.includes(16) || capabilityFlags.includes(106)) capacity = 3;
		else if (tierFlags.includes(8) || capabilityFlags.includes(19)) capacity = 2;
		const available: string[] = [];
		const numbersById = new Map<string, number>();
		let selected: WebsiteModel | undefined;
		let ambiguous = false;
		for (const entry of models) {
			const id = getNestedValue(entry, [0]);
			const number = getNestedValue(entry, [17]) ?? getNestedValue(entry, [9]);
			if (typeof id !== "string" || !/^[a-f0-9]{16}$/.test(id) || typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) continue;
			if (numbersById.has(id) && numbersById.get(id) !== number) throw new Error("Gemini Web invalid response: conflicting model metadata");
			numbersById.set(id, number);
			const aliases = [getNestedValue(entry, [1]), getNestedValue(entry, [10]), getNestedValue(entry, [11]), getNestedValue(entry, [19])]
				.filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= 100)
				.map(value => `gemini-${value.trim().toLowerCase().replace(/\s+/g, "-")}`)
				.filter(value => /^gemini-[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value));
			available.push(...aliases);
			if (aliases.includes(name)) {
				if (selected && (selected.id !== id || selected.number !== number || selected.capacity !== capacity)) ambiguous = true;
				else selected = { id, number, capacity };
			}
		}
		if (ambiguous) throw new GeminiWebConfigurationError(`Gemini Web model configuration: ${name} is ambiguous for this account; choose an exact versioned display name. No alternate model was requested.`);
		if (selected) return selected;
		if (available.length === 0) break;
		throw new GeminiWebConfigurationError(`Gemini Web model configuration: ${name} is not available for the selected account. Available names: ${[...new Set(available)].join(", ")}. No alternate model was requested.`);
	}
	throw new Error("Gemini Web invalid response: missing model catalog");
}

async function fetchAccessToken(
	cookieHeader: string,
	signal: AbortSignal,
): Promise<string> {
	const html = await fetchWithCookieRedirects(GEMINI_APP_URL, cookieHeader, 10, signal);

	for (const key of ["SNlM0e", "thykhd"]) {
		const match = html.match(new RegExp(`"${key}":"(.*?)"`));
		if (match?.[1]) return match[1];
	}

	throw new Error("Unable to authenticate with Gemini. Make sure you're signed into gemini.google.com in a supported Chromium-based browser.");
}

async function fetchWithCookieRedirects(
	url: string,
	cookieHeader: string,
	maxRedirects: number,
	signal: AbortSignal,
): Promise<string> {
	let current = url;
	const allowedOrigin = new URL(url).origin;
	for (let i = 0; i <= maxRedirects; i++) {
		const res = await (await resolveGeminiFetch())(current, {
			headers: { "user-agent": USER_AGENT, cookie: cookieHeader },
			redirect: "manual",
			signal,
		});
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			if (location) {
				const next = new URL(location, current);
				if (next.origin !== allowedOrigin) {
					throw new Error(`Refusing to send Google cookies across origins: ${allowedOrigin} -> ${next.origin}`);
				}
				current = next.toString();
				continue;
			}
		}
		return await res.text();
	}
	throw new Error(`Too many redirects (>${maxRedirects})`);
}

function extractEmailFromGeminiHtml(html: string): string | null {
	const patterns = [
		// Gemini bootstraps the active account in oPEP7c. Prefer it over generic
		// feature/config entries that may contain other signed-in Google accounts.
		/"oPEP7c"\s*:\s*"([^"]+)"/,
		// The Google account menu aria-label is rendered for the active account.
		/aria-label="Google Account:[^"]*?\(([^)]+)\)"/,
		/"displayEmail"\s*:\s*"([^"]+)"/,
		/"defaultEmail"\s*:\s*"([^"]+)"/,
		/"email"\s*:\s*"([^"]+)"/,
		/"identifier"\s*:\s*"([^"]+)"/,
		/"gaiaIdentifier"\s*:\s*"([^"]+)"/,
	];

	for (const pattern of patterns) {
		const match = html.match(pattern);
		const email = normalizeEmail(match?.[1]);
		if (email) return email;
	}

	return findFirstEmail(html);
}

function extractEmailFromListAccounts(text: string): string | null {
	const trimmed = text.replace(/^\)\]\}'\s*/, "");
	try {
		return findEmailInValue(JSON.parse(trimmed)) ?? findFirstEmail(trimmed);
	} catch {
		return findFirstEmail(trimmed);
	}
}

function findEmailInValue(value: unknown): string | null {
	if (typeof value === "string") return normalizeEmail(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			const email = findEmailInValue(item);
			if (email) return email;
		}
		return null;
	}
	if (value && typeof value === "object") {
		for (const item of Object.values(value as Record<string, unknown>)) {
			const email = findEmailInValue(item);
			if (email) return email;
		}
	}
	return null;
}

function findFirstEmail(text: string): string | null {
	const normalized = decodeEmailEscapes(text);
	const match = normalized.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
	return match?.[0] ?? null;
}

function normalizeEmail(value: string | undefined): string | null {
	if (!value) return null;
	const normalized = decodeEmailEscapes(value.trim());
	return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(normalized) ? normalized : null;
}

function decodeEmailEscapes(value: string): string {
	return value
		.replace(/\\u0040/gi, "@")
		.replace(/\\x40/gi, "@")
		.replace(/&#64;/gi, "@")
		.replace(/&commat;/gi, "@")
		.replace(/\\"/g, "\"")
		.replace(/\\\\/g, "\\");
}

async function uploadFile(
	file: GeminiWebFile,
	cookieHeader: string,
	signal: AbortSignal,
): Promise<{ id: string; name: string }> {
	const data = readFileSync(file.path);
	const fileName = basename(file.path);
	const boundary = "----FormBoundary" + Math.random().toString(36).slice(2);
	const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${file.mimeType}\r\n\r\n`;
	const footer = `\r\n--${boundary}--\r\n`;

	const body = Buffer.concat([
		Buffer.from(header, "utf-8"),
		data,
		Buffer.from(footer, "utf-8"),
	]);

	const res = await (await resolveGeminiFetch())(GEMINI_UPLOAD_URL, {
		method: "POST",
		redirect: "error",
		headers: {
			"content-type": `multipart/form-data; boundary=${boundary}`,
			"push-id": GEMINI_UPLOAD_PUSH_ID,
			"user-agent": USER_AGENT,
			cookie: cookieHeader,
		},
		body,
		signal,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`File upload failed: ${res.status} (${text.slice(0, 200)})`);
	}

	return { id: await res.text(), name: fileName };
}

function buildFReqPayload(
	prompt: string,
	uploaded: Array<{ id: string; name: string }>,
	modelNumber: number,
	requestId: string,
): string {
	const promptPayload = [prompt, 0, null, uploaded.length > 0 ? uploaded.map((file) => [[file.id, 1], file.name]) : null, null, null, 0];
	const innerList: unknown[] = Array(81).fill(null);
	innerList[0] = promptPayload;
	innerList[1] = ["en"];
	innerList[2] = ["", "", "", null, null, null, null, null, null, ""];
	for (const [index, value] of [[6, [1]], [7, 1], [10, 1], [11, 0], [17, [[0]]], [18, 0], [27, 1], [30, [4]], [41, [1]], [53, 0], [59, requestId], [61, []], [68, 1], [79, modelNumber], [80, 1]] as const) innerList[index] = value;
	return JSON.stringify([null, JSON.stringify(innerList)]);
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function buildCookieHeader(cookieMap: CookieMap): string {
	return Object.entries(cookieMap)
		.filter(([, value]) => typeof value === "string" && value.length > 0)
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

function getNestedValue(value: unknown, pathParts: number[]): unknown {
	let current: unknown = value;
	for (const part of pathParts) {
		if (current == null) return undefined;
		if (!Array.isArray(current)) return undefined;
		current = (current as unknown[])[part];
	}
	return current;
}

function parseResponseParts(text: string): unknown[] {
	const payload = text.replace(/^\)\]\}'/, "");
	try {
		const json: unknown = JSON.parse(payload);
		if (Array.isArray(json)) return json;
	} catch { /* Length-prefixed website responses contain multiple compact JSON frames. */ }

	const parts: unknown[] = [];
	let position = 0;
	let foundFrame = false;
	while (position < payload.length) {
		while (position < payload.length && /\s/.test(payload[position])) position++;
		if (position === payload.length) break;

		const markerEnd = payload.indexOf("\n", position);
		if (markerEnd === -1) {
			if (/^\d+$/.test(payload.slice(position))) throw new Error("Gemini Web returned an incomplete response frame");
			if (foundFrame) throw new Error("Gemini Web returned invalid JSON response framing");
			break;
		}
		let marker = payload.slice(position, markerEnd);
		if (marker.endsWith("\r")) marker = marker.slice(0, -1);
		if (!/^\d+$/.test(marker)) {
			if (foundFrame) throw new Error("Gemini Web returned invalid JSON response framing");
			break;
		}

		const length = Number(marker);
		if (!Number.isSafeInteger(length)) throw new Error("Gemini Web returned invalid response frame length");
		foundFrame = true;
		// The pinned protocol counts the separator newline as the first UTF-16 frame unit.
		const frameStart = markerEnd - (payload[markerEnd - 1] === "\r" ? 1 : 0);
		const frameEnd = frameStart + length;
		if (frameEnd > payload.length) throw new Error("Gemini Web returned an incomplete response frame");

		let frame: unknown;
		try { frame = JSON.parse(payload.slice(frameStart, frameEnd)); }
		catch { throw new Error("Gemini Web returned invalid JSON response framing"); }
		if (!Array.isArray(frame)) throw new Error("Gemini Web returned invalid JSON response framing");
		parts.push(...frame);
		position = frameEnd;
	}
	if (foundFrame) {
		if (parts.length === 0) throw new Error("Gemini Web returned an incomplete response frame");
		return parts;
	}

	for (const line of payload.split(/\r?\n/).map(value => value.trim()).filter(Boolean)) {
		let frame: unknown;
		try { frame = JSON.parse(line); }
		catch { throw new Error("Gemini Web returned invalid JSON response framing"); }
		if (!Array.isArray(frame)) throw new Error("Gemini Web returned invalid JSON response framing");
		parts.push(...frame);
	}
	if (parts.length === 0) throw new Error("Gemini Web returned an incomplete response frame");
	return parts;
}

function extractErrorCode(responseJson: unknown): number | undefined {
	const code = getNestedValue(responseJson, [0, 5, 2, 0, 1, 0]);
	return typeof code === "number" && code >= 0 ? code : undefined;
}

function extractCandidateText(candidate: unknown): string {
	const textRaw = getNestedValue(candidate, [1, 0]);
	let text = typeof textRaw === "string" ? textRaw : "";

	if (/^http:\/\/googleusercontent\.com\/card_content\/\d+/.test(text)) {
		const alt = getNestedValue(candidate, [22, 0]);
		if (typeof alt === "string" && alt.length > 0) text = alt;
	}

	return text;
}

function parseStreamGenerateResponse(rawText: string): GeminiWebResult {
	const responseJson = parseResponseParts(rawText);
	let errorCode = extractErrorCode(responseJson);

	const parts = Array.isArray(responseJson) ? responseJson : [];
	let firstCandidateSeen: unknown = undefined;
	let latestNonEmptyText = "";
	let invalidCandidate = false;

	for (let i = 0; i < parts.length; i++) {
		const partError = extractErrorCode([parts[i]]);
		if (partError !== undefined) errorCode = partError;
		const partBody = getNestedValue(parts[i], [2]);
		if (!partBody || typeof partBody !== "string") continue;
		try {
			const parsed = JSON.parse(partBody);
			const candidateList = getNestedValue(parsed, [4]);
			if (!Array.isArray(candidateList) || candidateList.length === 0) continue;

			const firstCandidate = (candidateList as unknown[])[0];
			if (firstCandidateSeen === undefined) firstCandidateSeen = firstCandidate;

			const text = extractCandidateText(firstCandidate);
			if (text.length > 0) latestNonEmptyText = text;
		} catch {
			invalidCandidate = true;
		}
	}

	const text = latestNonEmptyText.length > 0
		? latestNonEmptyText
		: extractCandidateText(firstCandidateSeen);

	return {
		text,
		...(errorCode !== undefined ? { errorCode } : {}),
		...(invalidCandidate ? { errorMessage: "Gemini Web returned invalid candidate JSON" } : {}),
	};
}
