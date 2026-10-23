import { awaitWithAbort } from "./abortable.ts";
import { DecisionEngineError, validateTaskSignals, type DecisionEngine, type TaskSignals } from "./navi-policy.ts";

export type DecisionOutcome =
	| { status: "classified"; signals: TaskSignals }
	| { status: "rules"; reason: "unavailable" | "failed" | "timeout" };

/** Optional, bounded classification. Caller cancellation must never start fallback work.
 * The host must bypass this entirely for mode=off and explicit provider selections. */
export async function classifyWithFallback(input: {
	engine?: DecisionEngine;
	query: string;
	signal: AbortSignal;
	timeoutMs: number;
}): Promise<DecisionOutcome> {
	const cancelled = () => new DOMException("Navi decision cancelled", "AbortError");
	if (input.signal.aborted) throw cancelled();
	if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 60_000) {
		throw new Error("Invalid Navi decision timeout");
	}
	if (!input.engine) return { status: "rules", reason: "unavailable" };
	const timeout = new AbortController();
	const timer = setTimeout(() => timeout.abort(), input.timeoutMs);
	const signal = AbortSignal.any([input.signal, timeout.signal]);
	try {
		const raw = await awaitWithAbort(Promise.resolve().then(() => input.engine!.classify({ query: input.query, signal })), signal);
		return { status: "classified", signals: validateTaskSignals(raw) };
	} catch (error) {
		if (input.signal.aborted) throw cancelled();
		return { status: "rules", reason: timeout.signal.aborted ? "timeout" : error instanceof DecisionEngineError ? error.reason : "failed" };
	} finally { clearTimeout(timer); }
}
