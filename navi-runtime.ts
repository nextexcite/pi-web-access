import { awaitWithAbort } from "./abortable.ts";
import { isBraveAvailable } from "./brave.ts";
import { isExaAvailable } from "./exa.ts";
import { isTavilyAvailable } from "./tavily.ts";
import { resolveCredential } from "./credential-source.ts";
import { classifyWithFallback } from "./navi-decision.ts";
import { createJevDecisionEngine } from "./navi-jev.ts";
import { compileSearchPolicy, type DecisionEngine, type ExecutionLimits, type ProviderCapability } from "./navi-policy.ts";
import type { FullSearchOptions, AttributedSearchResponse, SearchProviderSelection } from "./gemini-search.ts";
import type { QueryResultData } from "./storage.ts";
import type { ExtractedContent } from "./extract.ts";

const PROVIDERS = ["brave", "exa", "tavily"] as const;
type NaviProvider = typeof PROVIDERS[number];
export interface NaviConfig {
	mode: "shadow" | "on";
	providers: NaviProvider[];
	limits: ExecutionLimits;
	decision: { engine: "rules" | "jev"; timeoutMs: number; apiKey?: unknown; endpoint?: string; model?: string };
}
export interface NaviTrace {
	version: 1;
	mode: "shadow" | "on";
	status: "shadow" | "shadow-error" | "executed";
	plans: Array<{ ordinal: number; providers: string[]; basis: string; decision: string }>;
	searchAttempts: number;
	contentFetches: number;
	limits: ExecutionLimits;
	deadlineReached: boolean;
	partial: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown, fallback: number, minimum: number, maximum: number): number {
	const result = value === undefined ? fallback : value;
	if (!Number.isSafeInteger(result) || (result as number) < minimum || (result as number) > maximum) throw new Error("Invalid Navi configuration");
	return result as number;
}
export function naviMode(value: unknown): "off" | "shadow" | "on" {
	if (value === undefined) return "off";
	if (!object(value) || ![undefined, "off", "shadow", "on"].includes(value.mode as string)) throw new Error("Invalid Navi mode");
	return (value.mode ?? "off") as "off" | "shadow" | "on";
}
export function parseNaviConfig(value: unknown): NaviConfig | undefined {
	const mode = naviMode(value);
	if (mode === "off") return undefined;
	const raw = value as Record<string, unknown>;
	const providers = raw.providers ?? [...PROVIDERS];
	if (!Array.isArray(providers) || !providers.length || providers.some(id => !PROVIDERS.includes(id)) || new Set(providers).size !== providers.length) throw new Error("Invalid Navi providers; supported: brave, exa, tavily");
	if (raw.limits !== undefined && !object(raw.limits) || raw.decision !== undefined && !object(raw.decision)) throw new Error("Invalid Navi configuration");
	const limits = (raw.limits ?? {}) as Record<string, unknown>;
	const decision = (raw.decision ?? {}) as Record<string, unknown>;
	const engine = decision.engine ?? "rules";
	if (engine !== "rules" && engine !== "jev") throw new Error("Invalid Navi decision engine");
	for (const key of ["endpoint", "model"]) if (decision[key] !== undefined && (typeof decision[key] !== "string" || !(decision[key] as string).trim())) throw new Error("Invalid Navi decision configuration");
	return {
		mode, providers: [...providers],
		limits: {
			maxSearchCalls: integer(limits.maxSearchCalls, 4, 1, 100),
			maxContentFetches: integer(limits.maxContentFetches, 2, 0, 20),
			deadlineMs: integer(limits.deadlineMs, 15000, 1, 120000),
		},
		decision: { engine, timeoutMs: integer(decision.timeoutMs, 1500, 1, 60000), apiKey: decision.apiKey, endpoint: decision.endpoint as string | undefined, model: decision.model as string | undefined },
	};
}

export function configuredNaviEngine(config: NaviConfig): DecisionEngine | undefined {
	if (config.decision.engine !== "jev") return undefined;
	return createJevDecisionEngine({
		endpoint: config.decision.endpoint, model: config.decision.model, timeoutMs: config.decision.timeoutMs,
		getApiKey: signal => resolveCredential({ provider: "Navi Jev", configuredValue: config.decision.apiKey, signal }),
	});
}

class NaviStop extends Error {
	constructor(code: "deadline" | "search-budget" | "content-budget") { super(`Navi ${code} reached`); }
}
class NaviRequestError extends Error {}
class RequestBudget {
	searchAttempts = 0;
	contentFetches = 0;
	readonly signal: AbortSignal;
	private readonly controller = new AbortController();
	private readonly endsAt: number;
	private readonly timer: ReturnType<typeof setTimeout>;
	readonly limits: ExecutionLimits;
	readonly caller: AbortSignal;
	constructor(limits: ExecutionLimits, caller: AbortSignal) {
		this.limits = limits;
		this.caller = caller;
		this.endsAt = Date.now() + limits.deadlineMs;
		this.signal = AbortSignal.any([caller, this.controller.signal]);
		this.timer = setTimeout(() => this.controller.abort(), limits.deadlineMs);
	}
	get deadlineReached(): boolean { return Date.now() >= this.endsAt || this.controller.signal.aborted; }
	check(): void {
		if (this.caller.aborted) throw new DOMException("Navi request cancelled", "AbortError");
		if (this.deadlineReached) throw new NaviStop("deadline");
	}
	reserveSearch = (): void => {
		this.check();
		if (this.searchAttempts >= this.limits.maxSearchCalls) throw new NaviStop("search-budget");
		this.searchAttempts++;
	};
	reserveContent(): void {
		this.check();
		if (this.contentFetches >= this.limits.maxContentFetches) throw new NaviStop("content-budget");
		this.contentFetches++;
	}
	async run<T>(work: () => Promise<T>): Promise<T> {
		this.check();
		const result = await awaitWithAbort(Promise.resolve().then(() => { this.check(); return work(); }), this.signal);
		this.check();
		return result;
	}
	dispose(): void { clearTimeout(this.timer); this.controller.abort(); }
}

function providerRegistry(): ProviderCapability[] {
	return PROVIDERS.map(id => {
		let available = false;
		try { available = id === "brave" ? isBraveAvailable() : id === "exa" ? isExaAvailable() : isTavilyAvailable(); } catch { /* No raw configuration errors in diagnostics. */ }
		return { id, capabilities: id === "exa" ? ["semantic", "fresh"] : ["keyword", "fresh"], available };
	});
}

export interface NaviDependencies {
	search(query: string, options: FullSearchOptions): Promise<AttributedSearchResponse>;
	fetchPages(urls: string[], signal: AbortSignal): Promise<ExtractedContent[]>;
	/** Tests/other hosts may inject a decision engine; omitted uses configured Jev/rules. */
	engine?: (config: NaviConfig) => DecisionEngine | undefined;
	registry?: () => ProviderCapability[];
}
export interface NaviRun {
	trace: NaviTrace;
	results: QueryResultData[];
	urls: string[];
	content?: ExtractedContent[];
}

/** One request budget spans all queries, provider retries and awaited extraction jobs.
 * Only the audited portfolio is executable; explicit selections are never substituted. */
export async function runNaviSearch(input: {
	config: NaviConfig; queries: string[]; requested: SearchProviderSelection; allowed: readonly string[];
	options: FullSearchOptions; includeContent: boolean; signal?: AbortSignal;
}, deps: NaviDependencies): Promise<NaviRun> {
	const { config } = input;
	const caller = input.signal ?? new AbortController().signal;
	const budget = new RequestBudget(config.limits, caller);
	const trace: NaviTrace = { version: 1, mode: config.mode, status: config.mode === "on" ? "executed" : "shadow", plans: [], searchAttempts: 0, contentFetches: 0, limits: { ...config.limits }, deadlineReached: false, partial: false };
	const results: QueryResultData[] = [];
	const urls: string[] = [];
	const content: ExtractedContent[] = [];
	let plannedCalls = 0;
	try {
		budget.check();
		const explicit = input.requested !== "auto";
		if (input.requested === "all") throw new NaviRequestError("Navi on/shadow planning does not support provider all; use off or an explicit supported selection");
		const requested = explicit ? Array.isArray(input.requested) ? [...new Set(input.requested)] : [input.requested] : undefined;
		if (requested?.some(id => !(PROVIDERS as readonly string[]).includes(id))) throw new NaviRequestError("Navi executable providers: brave, exa, tavily; use off for other explicit providers");
		if (requested && requested.length * input.queries.length > config.limits.maxSearchCalls) throw new NaviRequestError("Navi explicit selection exceeds request search budget");
		const registry = (deps.registry ?? providerRegistry)();
		const allowed = explicit ? input.allowed : input.allowed.filter(id => config.providers.includes(id as NaviProvider));
		// Do not instantiate or resolve decision credentials for explicit routes.
		let engine: DecisionEngine | undefined;
		if (!explicit) {
			try { engine = (deps.engine ?? configuredNaviEngine)(config); } catch { /* Deterministic rules on adapter setup failure. */ }
		}
		for (const [index, query] of input.queries.entries()) {
			let plan: string[] = [];
			try {
				budget.check();
				const remaining = config.limits.maxSearchCalls - (config.mode === "shadow" ? plannedCalls : budget.searchAttempts);
				if (remaining <= 0) throw new NaviStop("search-budget");
				const outcome = explicit ? undefined : await budget.run(() => classifyWithFallback({ engine, query, signal: budget.signal, timeoutMs: config.decision.timeoutMs }));
				const signals = outcome?.status === "classified" ? outcome.signals : undefined;
				const policy = compileSearchPolicy({ mode: "on", providers: registry, allowedProviders: [...allowed], requestedProviders: requested,
					limits: { ...config.limits, maxSearchCalls: remaining }, signals: signals && input.options.recencyFilter ? { ...signals, freshness: "recent" } : signals });
				if (policy.execution !== "planned") throw new Error("Navi planning failed");
				plan = policy.proposal.providers;
				plannedCalls += plan.length;
				trace.plans.push({ ordinal: index, providers: plan, basis: policy.proposal.basis, decision: explicit ? "bypassed-explicit" : outcome?.status === "classified" ? "classified" : "rules" });
				if (config.mode === "shadow") continue;
				const responses: AttributedSearchResponse[] = [];
				let failures = 0;
				for (const provider of plan) {
					try {
						responses.push(await budget.run(() => deps.search(query, { ...input.options, provider: provider as NaviProvider, providerFromConfig: false,
							includeContent: false, signal: budget.signal, beforeSearchRequest: budget.reserveSearch })));
					} catch {
						if (caller.aborted) throw new DOMException("Navi request cancelled", "AbortError");
						failures++;
					}
				}
				if (!responses.length) throw new Error("Navi search failed or request limit reached");
				if (failures) trace.partial = true;
				const sources = responses.flatMap(response => response.results).filter((source, i, all) => all.findIndex(other => other.url === source.url) === i);
				for (const source of sources) if (!urls.includes(source.url)) urls.push(source.url);
				results.push({ query, answer: responses.map(response => response.answer).filter(Boolean).join("\n\n") + (failures ? "\n\nNavi: some planned providers failed or reached the request limit." : ""), results: sources,
					error: null, provider: responses.length === 1 ? responses[0].provider : "all", providers: responses.map(response => response.provider) });
			} catch (error) {
				if (caller.aborted) throw new DOMException("Navi request cancelled", "AbortError");
				trace.partial = true;
				if (config.mode === "shadow") { trace.status = "shadow-error"; break; }
				results.push({ query, answer: "", results: [], error: error instanceof NaviStop ? error.message : "Navi search unavailable or request limit reached", providers: [] });
			}
		}
		if (config.mode === "on" && input.includeContent) {
			for (const url of urls) {
				try {
					budget.reserveContent();
					const fetched = await budget.run(() => deps.fetchPages([url], budget.signal));
					content.push(fetched[0] ?? { url, title: "", content: "", error: "Navi content unavailable" });
				} catch {
					if (caller.aborted) throw new DOMException("Navi request cancelled", "AbortError");
					content.push({ url, title: "", content: "", error: "Navi content unavailable or request limit reached" });
				}
			}
			if (content.some(page => page.error)) trace.partial = true;
		}
	} catch (error) {
		if (caller.aborted) throw new DOMException("Navi request cancelled", "AbortError");
		trace.partial = true;
		if (config.mode === "shadow") trace.status = "shadow-error";
		else for (const query of input.queries) results.push({ query, answer: "", results: [], error: error instanceof NaviRequestError || error instanceof NaviStop ? error.message : "Navi request failed", providers: [] });
	} finally {
		trace.searchAttempts = budget.searchAttempts;
		trace.contentFetches = budget.contentFetches;
		trace.deadlineReached = budget.deadlineReached;
		budget.dispose();
	}
	return { trace, results, urls, ...(input.includeContent && config.mode === "on" ? { content } : {}) };
}
