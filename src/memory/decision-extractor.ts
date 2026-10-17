/**
 * Heuristic decision extractor — zero-LLM. Port of upstream
 * `memory/decision_extractor.py` (MIT). Requires an explicit reason clause
 * (because/since/so that/given that) to keep precision high.
 */

const SENT_SPLIT = /(?<=[.!?\n])\s+/;
const MIN_SENT_LEN = 20;
const REASON_CLAUSE = "(?:because(?:\\s+of)?|since|so\\s+that|given\\s+that)";
const REASON_KEYWORDS = ["because", "since", "so that", "given that"];
const MAX_FRAGMENT = 200;

const PATTERNS: RegExp[] = [
	new RegExp(`\\b(?:choos(?:e|ing|en)?|chose(?:n)?)\\s+(.+?)\\s+over\\s+\\S+(?:\\s+\\S+){0,4}\\s+${REASON_CLAUSE}\\s+(.+)`, "i"),
	new RegExp(`\\bdecided?\\s+to\\s+(.+?)\\s+${REASON_CLAUSE}\\s+(.+)`, "i"),
	new RegExp(`\\bwent\\s+with\\s+(.+?)\\s+${REASON_CLAUSE}\\s+(.+)`, "i"),
	new RegExp(`\\bgo(?:ing)?\\s+with\\s+(.+?)\\s+${REASON_CLAUSE}\\s+(.+)`, "i"),
	new RegExp(`\\b(?:use|using)\\s+(.+?)\\s+${REASON_CLAUSE}\\s+(.+)`, "i"),
	new RegExp(`\\b(.+?)\\s+instead\\s+of\\s+\\S+(?:\\s+\\S+){0,3}\\s+${REASON_CLAUSE}\\s+(.+)`, "i"),
	new RegExp(`\\bprefer(?:red|ring)?\\s+(.+?)\\s+${REASON_CLAUSE}\\s+(.+)`, "i"),
	new RegExp(`\\bswitched?\\s+to\\s+(.+?)\\s+${REASON_CLAUSE}\\s+(.+)`, "i"),
	new RegExp(`\\bwill\\s+(?:use|go\\s+with)\\s+(.+?)\\s+${REASON_CLAUSE}\\s+(.+)`, "i"),
	new RegExp(`\\bopted?\\s+for\\s+(.+?)\\s+${REASON_CLAUSE}\\s+(.+)`, "i"),
];

function clean(text: string): string {
	const normalized = text.trim().replace(/\s+/g, " ");
	return normalized.replace(/[\s.,;:]+$/, "").slice(0, MAX_FRAGMENT);
}

export function extractDecisions(text: string): { decision: string; reason: string }[] {
	const results: { decision: string; reason: string }[] = [];
	const seen = new Set<string>();
	for (const raw of text.split(SENT_SPLIT)) {
		const sentence = raw.trim();
		if (sentence.length < MIN_SENT_LEN) continue;
		const lower = sentence.toLowerCase();
		if (!REASON_KEYWORDS.some((kw) => lower.includes(kw))) continue;
		for (const pattern of PATTERNS) {
			const m = pattern.exec(sentence);
			if (!m) continue;
			const decision = clean(m[1]!);
			const reason = clean(m[2]!);
			if (!decision || !reason) break;
			const key = decision.toLowerCase();
			if (!seen.has(key)) {
				seen.add(key);
				results.push({ decision, reason });
			}
			break;
		}
	}
	return results;
}
