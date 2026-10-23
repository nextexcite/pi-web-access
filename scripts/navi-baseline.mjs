import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { compileSearchPolicy, validateTaskSignals } from "../navi-policy.ts";
import { JEV_QUESTION_VERSION } from "../navi-jev.ts";

export const corpusPath = new URL("../eval/navi/corpus-v1.json", import.meta.url);
const config = {
	mode: "on",
	providers: [
		{ id: "fixture-keyword", capabilities: ["keyword", "fresh"], available: true },
		{ id: "fixture-semantic", capabilities: ["semantic"], available: true },
		{ id: "fixture-unavailable", capabilities: ["fresh"], available: false },
	],
	allowedProviders: ["fixture-keyword", "fixture-semantic", "fixture-unavailable"],
	limits: { maxSearchCalls: 2, maxContentFetches: 2, deadlineMs: 10000 },
};

export function validateCorpus(corpus) {
	if (corpus?.version !== "navi-corpus-v1" || !Array.isArray(corpus.cases) || !corpus.cases.length) throw new Error("Invalid Navi corpus");
	const ids = new Set();
	const pairs = new Map();
	for (const item of corpus.cases) {
		if (typeof item.id !== "string" || !item.id || ids.has(item.id) || typeof item.pair !== "string" || !item.pair
			|| !["en", "zh"].includes(item.language) || !["stable", "fresh"].includes(item.lane)
			|| !["development", "holdout"].includes(item.split) || typeof item.query !== "string" || !item.query.trim()
			|| !Array.isArray(item.requiredEvidence) || item.requiredEvidence.length === 0
			|| !item.requiredEvidence.every(value => typeof value === "string" && value.trim())
			|| !Array.isArray(item.rubric) || item.rubric.length === 0 || !item.rubric.every(value => typeof value === "string" && value.trim())) {
			throw new Error("Invalid Navi corpus case");
		}
		validateTaskSignals(item.expectedSignals);
		ids.add(item.id);
		const pair = pairs.get(item.pair) ?? [];
		pair.push(item);
		pairs.set(item.pair, pair);
	}
	for (const pair of pairs.values()) {
		if (pair.length !== 2 || new Set(pair.map(item => item.language)).size !== 2
			|| pair[0].lane !== pair[1].lane || pair[0].split !== pair[1].split
			|| JSON.stringify(validateTaskSignals(pair[0].expectedSignals)) !== JSON.stringify(validateTaskSignals(pair[1].expectedSignals))) {
			throw new Error("Invalid Navi bilingual pair or split leakage");
		}
	}
	return corpus;
}

/** Offline planner baseline only. Labels are an oracle control, never model predictions. */
export function runBaseline(corpus, { split = "development", lane = "all", now = new Date().toISOString() } = {}) {
	validateCorpus(corpus);
	if (!["development", "holdout"].includes(split) || !["all", "stable", "fresh"].includes(lane)) throw new Error("Invalid Navi baseline selection");
	const selected = corpus.cases.filter(item => item.split === split && (lane === "all" || item.lane === lane));
	return {
		schemaVersion: "navi-baseline-v1",
		mode: "offline-planning",
		corpusVersion: corpus.version,
		corpusSha256: createHash("sha256").update(JSON.stringify(corpus)).digest("hex"),
		questionVersion: JEV_QUESTION_VERSION,
		runAt: now,
		selection: { split, lane },
		config,
		measuredRetrieval: false,
		results: selected.map(item => ({
			caseId: item.id, language: item.language, lane: item.lane,
			plans: {
				rules: compileSearchPolicy(config).proposal,
				fixed: compileSearchPolicy({ ...config, requestedProviders: ["fixture-keyword", "fixture-semantic"] }).proposal,
				oracleSignals: compileSearchPolicy({ ...config, signals: item.expectedSignals }).proposal,
			},
			upstream: { status: "skipped", reason: "live-execution-not-enabled" },
			jev: { status: "skipped", reason: "live-execution-not-enabled" },
			ranks: null, provenance: null, retrievalScore: null, answerScore: null, latencyMs: null, costUsd: null,
		})),
	};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = process.argv.slice(2);
		let split = "development", lane = "all";
		for (let i = 0; i < args.length; i += 2) {
			if (args[i] === "--split") split = args[i + 1];
			else if (args[i] === "--lane") lane = args[i + 1];
			else throw new Error("Invalid option");
			if (!args[i + 1]) throw new Error("Missing option value");
		}
		console.log(JSON.stringify(runBaseline(JSON.parse(readFileSync(corpusPath, "utf8")), { split, lane }), null, 2));
	} catch {
		console.error("Navi baseline failed. Usage: node scripts/navi-baseline.mjs [--split development|holdout] [--lane all|stable|fresh]");
		process.exitCode = 1;
	}
}
