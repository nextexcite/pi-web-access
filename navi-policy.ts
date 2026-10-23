/** Experimental host-neutral planning contract. Not wired into live search yet. */
export type NaviMode = "off" | "shadow" | "on";
export type ResearchDepth = "quick" | "standard" | "deep";
export type RetrievalCapability = "keyword" | "semantic" | "fresh";

export interface TaskSignals {
	depth: ResearchDepth;
	intent: "lookup" | "discovery" | "comparison";
	freshness: "any" | "recent";
}

/** Adapters validate their remote response before returning task signals.
 * Credentials, Pi state and vendor protocols stay outside this interface. */
export interface DecisionEngine {
	readonly id: string;
	classify(input: { query: string; signal: AbortSignal }): Promise<TaskSignals>;
}

export interface ProviderCapability {
	id: string;
	capabilities: readonly RetrievalCapability[];
	/** Operational readiness, supplied by the host; not a benchmark quality label. */
	available: boolean;
}

export interface ExecutionLimits {
	maxSearchCalls: number;
	maxContentFetches: number;
	deadlineMs: number;
}

export interface PolicyInput {
	mode: NaviMode;
	/** Resolved explicit/configured provider selection. Omit for automatic selection.
	 * Host adapters must resolve reserved upstream values such as all/auto first. */
	requestedProviders?: readonly string[];
	/** Candidate order is the deterministic tie-breaker; no vendor is privileged. */
	providers: readonly ProviderCapability[];
	allowedProviders: readonly string[];
	limits: ExecutionLimits;
	/** Omit after a decision failure to use deterministic fallback. */
	signals?: TaskSignals;
}

export interface SearchProposal {
	providers: string[];
	strategy: "fast" | "balanced" | "investigate";
	basis: "explicit" | "signals" | "rules";
	limits: ExecutionLimits;
}

export type PolicyResult =
	| { execution: "existing"; reason: "off" }
	| { execution: "existing"; reason: "shadow"; proposal: SearchProposal }
	| { execution: "planned"; proposal: SearchProposal };

export function validateTaskSignals(value: unknown): TaskSignals {
	if (!value || typeof value !== "object") throw new Error("Invalid Navi task signals");
	const v = value as Record<string, unknown>;
	if (!["quick", "standard", "deep"].includes(v.depth as string)
		|| !["lookup", "discovery", "comparison"].includes(v.intent as string)
		|| !["any", "recent"].includes(v.freshness as string)) {
		throw new Error("Invalid Navi task signals");
	}
	// Do not carry vendor text or extra fields into the policy boundary.
	return { depth: v.depth as ResearchDepth, intent: v.intent as TaskSignals["intent"], freshness: v.freshness as TaskSignals["freshness"] };
}

function validateLimits(limits: ExecutionLimits): void {
	for (const [key, minimum] of [["maxSearchCalls", 1], ["maxContentFetches", 0], ["deadlineMs", 1]] as const) {
		if (!Number.isSafeInteger(limits[key]) || limits[key] < minimum) {
			throw new Error(`Invalid Navi limit: ${key}`);
		}
	}
}

/** Pure first-round planner: no networking, credentials, timers or hidden loops.
 * The executor must enforce the returned limits across all queries and retries.
 * Shadow proposals must never be dispatched. Planning errors in shadow mode
 * must be recorded by the host without interrupting its existing execution. */
export function compileSearchPolicy(input: PolicyInput): PolicyResult {
	if (input.mode === "off") return { execution: "existing", reason: "off" };
	if (input.mode !== "shadow" && input.mode !== "on") throw new Error("Invalid Navi mode");
	validateLimits(input.limits);
	const allowed = new Set(input.allowedProviders);
	const seen = new Set<string>();
	for (const provider of input.providers) {
		if (!provider.id || provider.id === "auto" || provider.id === "all" || seen.has(provider.id)) {
			throw new Error("Invalid Navi provider registry");
		}
		seen.add(provider.id);
	}
	const eligible = input.providers.filter(p => p.available && allowed.has(p.id));
	let proposal: SearchProposal;
	if (input.requestedProviders !== undefined) {
		const requested = [...new Set(input.requestedProviders)];
		if (requested.length === 0) throw new Error("Empty explicit Navi provider selection");
		if (requested.some(id => !eligible.some(p => p.id === id))) {
			// Do not echo arbitrary identifiers or silently replace an explicit request.
			throw new Error("Explicit Navi provider is unavailable or disallowed");
		}
		if (requested.length > input.limits.maxSearchCalls) throw new Error("Explicit Navi selection exceeds search budget");
		proposal = { providers: requested, strategy: requested.length === 1 ? "fast" : "balanced", basis: "explicit", limits: { ...input.limits } };
	} else {
		if (eligible.length === 0) throw new Error("No eligible Navi search providers");
		const signals = input.signals === undefined ? undefined : validateTaskSignals(input.signals);
		const strategy = signals?.depth === "quick" ? "fast" : signals?.depth === "deep" ? "investigate" : "balanced";
		const preferred: RetrievalCapability = signals?.freshness === "recent" ? "fresh" : signals?.intent === "lookup" ? "keyword" : "semantic";
		const ranked = eligible.map((provider, order) => ({ provider, order }))
			.sort((a, b) => Number(b.provider.capabilities.includes(preferred)) - Number(a.provider.capabilities.includes(preferred)) || a.order - b.order);
		const selected = [ranked[0].provider];
		const count = Math.min(strategy === "fast" ? 1 : 2, input.limits.maxSearchCalls, ranked.length);
		if (count > 1) {
			// Capability diversity is only a selection heuristic, not proof of independent indexes.
			const rest = ranked.slice(1).map(item => item.provider);
			selected.push(rest.find(p => p.capabilities.some(c => !selected[0].capabilities.includes(c))) ?? rest[0]);
		}
		proposal = { providers: selected.map(p => p.id), strategy, basis: signals ? "signals" : "rules", limits: { ...input.limits } };
	}
	return input.mode === "shadow"
		? { execution: "existing", reason: "shadow", proposal }
		: { execution: "planned", proposal };
}
