/**
 * Model pricing for savings estimates — port of upstream `pricing.py` (MIT).
 * Static table for all providers; live Anthropic pricing is fetched and
 * cached for 7 days (opt-in, best-effort).
 */
import fs from "node:fs";
import path from "node:path";
import { PCE_HOME } from "./config.js";
import type { Config } from "./config.js";

export interface ModelPricing {
	input: number; // $/1M input tokens
	output: number; // $/1M output tokens
}

const CACHE_PATH = path.join(PCE_HOME, "pricing_cache.json");
const CACHE_TTL_SECONDS = 7 * 24 * 3600;
const DOCS_URL = "https://docs.anthropic.com/en/docs/about-claude/models";

const STATIC_PRICING: Record<string, ModelPricing> = {
	// OpenAI
	"gpt-4o": { input: 2.5, output: 10.0 },
	"gpt-4o-mini": { input: 0.15, output: 0.6 },
	"gpt-4.1": { input: 2.0, output: 8.0 },
	"gpt-4.1-mini": { input: 0.4, output: 1.6 },
	"gpt-4.1-nano": { input: 0.1, output: 0.4 },
	o3: { input: 2.0, output: 8.0 },
	"o3-mini": { input: 1.1, output: 4.4 },
	"o4-mini": { input: 1.1, output: 4.4 },
	"codex-mini": { input: 1.5, output: 6.0 },
	// Google
	"gemini-2.5-pro": { input: 1.25, output: 10.0 },
	"gemini-2.5-flash": { input: 0.15, output: 0.6 },
	"gemini-2.0-flash": { input: 0.1, output: 0.4 },
	// Anthropic
	opus: { input: 15.0, output: 75.0 },
	sonnet: { input: 3.0, output: 15.0 },
	haiku: { input: 0.8, output: 4.0 },
};

function parseAnthropicHtml(html: string): Record<string, ModelPricing> | null {
	const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
	const inputPricing: Record<string, number> = {};
	const outputPricing: Record<string, number> = {};
	let colFamilies: (string | null)[] = [];

	for (const rowHtml of rows) {
		const cells = (rowHtml.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) ?? []).map((c) =>
			c.replace(/<[^>]+>/g, " ").trim(),
		);
		const familiesInRow: (string | null)[] = [];
		let hasModel = false;
		for (const cell of cells) {
			const m = /Claude\s+(Opus|Sonnet|Haiku)/i.exec(cell);
			if (m) {
				familiesInRow.push(m[1]!.toLowerCase());
				hasModel = true;
			} else {
				familiesInRow.push(null);
			}
		}
		if (hasModel && familiesInRow.filter(Boolean).length >= 2) {
			colFamilies = familiesInRow;
			continue;
		}
		if (colFamilies.length === 0) continue;

		const isInput = cells.some((c) => /input/i.test(c) && /tok/i.test(c));
		const isOutput = cells.some((c) => /output/i.test(c) && /tok/i.test(c));
		let target: Record<string, number> | null = null;
		if (isInput && !isOutput) target = inputPricing;
		else if (isOutput && !isInput) target = outputPricing;
		if (!target) continue;

		cells.forEach((cell, i) => {
			const family = colFamilies[i];
			if (!family) return;
			const m = /\$(\d+(?:\.\d+)?)/.exec(cell);
			if (m && !(family in target!)) target![family] = Number(m[1]);
		});
		if (target === outputPricing) colFamilies = [];
	}

	if (Object.keys(inputPricing).length === 0) return null;
	const result: Record<string, ModelPricing> = {};
	for (const [family, input] of Object.entries(inputPricing)) {
		result[family] = { input, output: outputPricing[family] ?? input * 5 };
	}
	return result;
}

function loadCache(): Record<string, ModelPricing> | null {
	try {
		if (!fs.existsSync(CACHE_PATH)) return null;
		const data = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8")) as {
			ts?: number;
			pricing?: Record<string, ModelPricing>;
		};
		if (Date.now() / 1000 - (data.ts ?? 0) >= CACHE_TTL_SECONDS) return null;
		return data.pricing ?? null;
	} catch {
		return null;
	}
}

function saveCache(pricing: Record<string, ModelPricing>): void {
	try {
		fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
		fs.writeFileSync(CACHE_PATH, JSON.stringify({ ts: Math.floor(Date.now() / 1000), pricing }), "utf-8");
	} catch {
		// cache is best-effort
	}
}

async function fetchLive(): Promise<Record<string, ModelPricing> | null> {
	try {
		const resp = await fetch(DOCS_URL, { redirect: "follow", signal: AbortSignal.timeout(5000) });
		if (!resp.ok) return null;
		return parseAnthropicHtml(await resp.text());
	} catch {
		return null;
	}
}

export async function getModelPricing(fetchLivePricing = true): Promise<Record<string, ModelPricing>> {
	const result = { ...STATIC_PRICING };
	const cached = loadCache();
	if (cached) return { ...result, ...cached };
	if (fetchLivePricing) {
		const fetched = await fetchLive();
		if (fetched) {
			saveCache(fetched);
			return { ...result, ...fetched };
		}
	}
	return result;
}

export function listAvailableModels(): string[] {
	const result = { ...STATIC_PRICING, ...(loadCache() ?? {}) };
	return Object.keys(result).sort();
}

export async function resolvePricing(
	config: Config,
	fetchLivePricing = true,
): Promise<{ label: string; pricing: ModelPricing }> {
	const model = config.pricingModel.trim().toLowerCase();
	const all = await getModelPricing(fetchLivePricing);
	const base = all[model] ?? all["opus"] ?? { input: 15.0, output: 75.0 };
	const pricing: ModelPricing = {
		input: config.pricingInput ?? base.input,
		output: config.pricingOutput ?? base.output,
	};
	let label: string;
	if (config.pricingInput !== null || config.pricingOutput !== null) label = `${model} (custom)`;
	else if (!(model in all)) label = `opus (fallback from ${model})`;
	else label = model;
	return { label, pricing };
}
