/**
 * AST-aware code chunking via web-tree-sitter — port of upstream
 * `indexer/chunker.py` (MIT). Grammars are prebuilt WASM (tree-sitter-wasms),
 * so no C toolchain is needed on user machines.
 */
import { createRequire } from "node:module";
import { sha256Hex } from "../utils.js";
import { makeChunk, type Chunk, type ChunkType } from "../types.js";

// web-tree-sitter is CJS; loaded through require so the same code path works
// under jiti (pi) and vitest.
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Parser: any = require("web-tree-sitter");

const FUNCTION_TYPES = new Set([
	"function_definition", "function_declaration", "generator_function_declaration",
	"method_definition", "method_declaration", "generator_method",
	"arrow_function", "function_expression",
	"function_item", "local_function_statement",
	// Constructors: a Java/C# class's constructor is a definition users search
	// for by name; missing it left holes exactly like the generator gap.
	"constructor_declaration", "compact_constructor_declaration",
]);
const CLASS_TYPES = new Set([
	"class_definition", "class_declaration",
	"struct_declaration", "interface_declaration",
	"record_declaration", "enum_declaration",
	"type_declaration",
	"struct_item", "impl_item", "enum_item",
]);
const IMPORT_TYPES = new Set([
	"import_statement", "import_from_statement",
	"import_declaration",
	"use_declaration",
	"using_directive",
]);

/** Child node types that carry a symbol name (any language we parse). */
const NAME_TYPES = new Set([
	"identifier", "property_identifier", "type_identifier",
	"field_identifier", "name",
]);

/** tree-sitter-wasms file stems, keyed by our language id. */
const WASM_BY_LANGUAGE: Record<string, string> = {
	python: "tree-sitter-python",
	javascript: "tree-sitter-javascript",
	typescript: "tree-sitter-typescript",
	tsx: "tree-sitter-tsx",
	php: "tree-sitter-php",
	go: "tree-sitter-go",
	rust: "tree-sitter-rust",
	java: "tree-sitter-java",
	csharp: "tree-sitter-c_sharp",
};

interface TsNode {
	type: string;
	startIndex: number;
	endIndex: number;
	startPosition: { row: number; column: number };
	endPosition: { row: number; column: number };
	children: TsNode[];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	child(i: number): any;
	namedChildCount: number;
	text: string;
}

/** Budget for the R6 module chunk: embed/FTS cap is 5000 chars, leave room for the header. */
const MODULE_CHUNK_BUDGET_CHARS = 3000;

/** R12: default non-whitespace budget per ast-density chunk (cAST-style ~1200). */
export const DEFAULT_CHUNK_BUDGET_CHARS = 1200;

export interface ChunkingOptions {
	/** R12: `legacy` (default) walks function/class nodes; `ast-density` tiles the file into budgeted, self-contained chunks. */
	chunking?: "legacy" | "ast-density";
	/** R12: non-whitespace char budget for `ast-density`. */
	budgetChars?: number;
}

/** Internal build unit for ast-density tiling. */
interface DensityUnit {
	start: number;
	end: number;
	text: string;
	kind: ChunkType;
	unit: string | null;
	parent: string | null;
	segment: number;
}

let parserInitPromise: Promise<void> | undefined;
const languageCache = new Map<string, Promise<unknown>>();

function ensureParserInit(): Promise<void> {
	parserInitPromise ??= Parser.init().then(() => undefined);
	return parserInitPromise as Promise<void>;
}

function loadLanguage(language: string): Promise<unknown> | null {
	const stem = WASM_BY_LANGUAGE[language];
	if (!stem) return null;
	let p = languageCache.get(language);
	if (!p) {
		p = (async () => {
			await ensureParserInit();
			const wasmPath = require.resolve(`tree-sitter-wasms/out/${stem}.wasm`);
			return Parser.Language.load(wasmPath);
		})();
		languageCache.set(language, p);
	}
	return p;
}

export class Chunker {
	private parserPool: unknown[] = [];

	private acquireParser(): unknown {
		// Parsers are single-use-per-parse but reusable afterwards; keep a
		// small pool. tree-sitter wasm parsers are not safe to share across
		// concurrent parses, and ours are strictly synchronous, so one is
		// enough — the pool exists for future parallel workers.
		return this.parserPool.pop() ?? new Parser();
	}

	private releaseParser(p: unknown): void {
		this.parserPool.push(p);
	}

	/** Parse + chunk. Returns [] when the language is unsupported (caller falls back). */
	chunk(source: string, filePath: string, language: string): Chunk[] {
		const langPromise = loadLanguage(language);
		if (!langPromise) return [];
		// Languages are cached promises, but chunk() is sync. The caller
		// (pipeline) awaits `warmup(language)` on first use, so by the time
		// chunk() runs the Language object is in the sync cache below.
		const lang = syncLanguageCache.get(language);
		if (!lang) {
			throw new Error(`language ${language} not warmed up — call await warmupLanguages() first`);
		}

		const parser = this.acquireParser();
		try {
			(parser as { setLanguage(l: unknown): void }).setLanguage(lang);
			// Parse the JS string (not bytes): web-tree-sitter 0.22 rejects a
			// Uint8Array here, and `node.text` slices UTF-8 correctly, so chunk
			// content stays intact across multi-byte characters.
			const tree = (parser as { parse(s: string): { rootNode: TsNode } }).parse(source);
			const found: Chunk[] = [];
			this.walk(tree.rootNode, source, filePath, language, found);
			return dedupeSpans(found);
		} finally {
			this.releaseParser(parser);
		}
	}

	chunkWithImports(
		source: string,
		filePath: string,
		language: string,
		options: ChunkingOptions = {},
	): { chunks: Chunk[]; imports: string[]; importSpecs: string[] } {
		const chunks =
			options.chunking === "ast-density"
				? this.chunkAstDensity(source, filePath, language, options.budgetChars ?? DEFAULT_CHUNK_BUDGET_CHARS)
				: this.chunk(source, filePath, language);
		const extracted = this.extractImports(source, language);
		const imports = extracted.imports;
		const importSpecs = extracted.rawSpecs;
		// Always attempt the module chunk, even with zero children: a file of
		// pure top-level code (config tables, scripts) still needs a chunk, and
		// this makes the pipeline's whole-file fallback a rare safety net.
		const moduleChunk = this.buildModuleChunk(source, filePath, language, chunks);
		if (moduleChunk) chunks.push(moduleChunk);
		return { chunks, imports, importSpecs };
	}

	/**
	 * R6: one `module` chunk per AST file covering what the function/class walk
	 * leaves out — imports, top-level consts, type declarations, comments.
	 *
	 * Without it, module-level content (`DEFAULT_IGNORE = [...]`, config keys,
	 * prompt strings) was retrievable by NO path: eval queries about defaults
	 * scored exactly zero. Chunks carry `chunkType: "module"` which doubles as
	 * the parent marker: the retriever exempts module chunks from overlap
	 * dedupe (their span covers the whole file) and serves them as the
	 * small-to-big parent context of a hit.
	 */
	private buildModuleChunk(source: string, filePath: string, language: string, children: Chunk[]): Chunk | null {
		const lines = source.split("\n");
		const covered = new Array<boolean>(lines.length).fill(false);
		for (const c of children) {
			for (let i = Math.max(0, c.startLine - 1); i < Math.min(lines.length, c.endLine); i++) covered[i] = true;
		}
		const uncovered = lines
			.map((line, i) => ({ line, i }))
			.filter(({ line, i }) => !covered[i] && line.trim().length > 0)
			.map(({ line }) => line);

		const defines = children
			.map((c) => (typeof c.metadata["unit"] === "string" ? (c.metadata["unit"] as string) : null))
			.filter((u): u is string => !!u && !u.includes("."));
		const parts = [...uncovered];
		if (defines.length > 0) parts.push(`defines: ${[...new Set(defines)].slice(0, 30).join(", ")}`);
		if (parts.length === 0) return null;

		let body = parts.join("\n");
		if (body.length > MODULE_CHUNK_BUDGET_CHARS) {
			// Keep the head: imports and first declarations carry the module shape.
			let cut = 0;
			let used = 0;
			for (const part of parts) {
				if (used + part.length + 1 > MODULE_CHUNK_BUDGET_CHARS) break;
				used += part.length + 1;
				cut++;
			}
			body = `${parts.slice(0, Math.max(1, cut)).join("\n")}\n…[module context truncated]`;
		}

		const endLine = Math.max(1, lines.length - (lines[lines.length - 1] === "" ? 1 : 0));
		const id = sha256Hex(`${filePath}:module`).slice(0, 16);
		const base = filePath.split("/").pop()!.replace(/\.[^.]+$/, "");
		return makeChunk({
			id,
			content: body,
			chunkType: "module",
			filePath,
			startLine: 1,
			endLine,
			language,
			metadata: { unit: base, tier: "parent" },
		});
	}

	private walk(node: TsNode, source: string, filePath: string, language: string, chunks: Chunk[], ancestors: string[] = []): void {
		let unit: string | null = null;
		if (FUNCTION_TYPES.has(node.type)) {
			unit = nodeUnit(node, ancestors);
			chunks.push(this.nodeToChunk(node, source, filePath, language, "function", unit));
		} else if (CLASS_TYPES.has(node.type)) {
			unit = nodeUnit(node, ancestors);
			chunks.push(this.nodeToChunk(node, source, filePath, language, "class", unit));
		}
		// Descendants inherit the enclosing chain: `PaymentGateway.refund`.
		const name = unit?.split(".").pop();
		const chain = name ? [...ancestors, name] : ancestors;
		for (const child of node.children) {
			this.walk(child, source, filePath, language, chunks, chain);
		}
	}

	private nodeToChunk(node: TsNode, source: string, filePath: string, language: string, chunkType: ChunkType, unit: string | null = null): Chunk {
		// node.text is sliced correctly by the binding (UTF-8 aware).
		void source;
		const content = node.text;
		const startLine = node.startPosition.row + 1;
		const endLine = node.endPosition.row + 1;
		const id = sha256Hex(`${filePath}:${startLine}:${endLine}:${content.slice(0, 100)}`).slice(0, 16);
		return makeChunk({ id, content, chunkType, filePath, startLine, endLine, language, metadata: unit ? { unit } : {} });
	}

	/**
	 * R12: cAST-style split-merge. Tiles the file into top-level segments,
	 * splits oversized ones at syntactic children (line windows only at
	 * leaves), then greedily merges small adjacent siblings up to the budget.
	 * Concatenating the returned chunks in order (excluding the module chunk)
	 * reproduces the source byte-for-byte.
	 */
	private chunkAstDensity(source: string, filePath: string, language: string, budget: number): Chunk[] {
		const lang = syncLanguageCache.get(language);
		if (!lang) {
			throw new Error(`language ${language} not warmed up — call await warmupLanguages() first`);
		}
		const parser = this.acquireParser();
		try {
			(parser as { setLanguage(l: unknown): void }).setLanguage(lang);
			const tree = (parser as { parse(s: string): { rootNode: TsNode } }).parse(source);
			const units = splitNode(tree.rootNode, source, budget, 0, source.length, null);
			const merged = mergeUnits(units, source, budget);
			const chunks: Chunk[] = merged.map((u, i) => {
				const startLine = offsetToLine(source, u.start);
				const endLine = offsetToLine(source, Math.max(u.start, u.end - 1));
				const id = sha256Hex(`${filePath}:${u.start}:${u.end}:${i}:${u.text.slice(0, 100)}`).slice(0, 16);
				const metadata: Record<string, unknown> = {};
				if (u.unit) metadata["unit"] = u.unit;
				if (u.parent) metadata["parent"] = u.parent;
				if (u.segment > 0) metadata["segment"] = String(u.segment);
				return makeChunk({ id, content: u.text, chunkType: u.kind, filePath, startLine, endLine, language, metadata });
			});
			return dedupeSpans(chunks);
		} finally {
			this.releaseParser(parser);
		}
	}

	private extractImports(source: string, language: string): { imports: string[]; rawSpecs: string[] } {
		const lang = syncLanguageCache.get(language);
		if (!lang) return { imports: [], rawSpecs: [] };
		const parser = this.acquireParser();
		try {
			(parser as { setLanguage(l: unknown): void }).setLanguage(lang);
			const tree = (parser as { parse(s: string): { rootNode: TsNode } }).parse(source);
			const imports: string[] = [];
			const rawSpecs: string[] = [];
			this.walkImports(tree.rootNode, language, imports, rawSpecs);
			return { imports: [...new Set(imports)], rawSpecs: [...new Set(rawSpecs)] };
		} finally {
			this.releaseParser(parser);
		}
	}

	private walkImports(node: TsNode, language: string, imports: string[], rawSpecs: string[]): void {
		if (IMPORT_TYPES.has(node.type)) {
			const module = parseImportModule(node, language);
			if (module) imports.push(module);
			const raw = parseImportModuleRaw(node);
			if (raw) rawSpecs.push(raw);
		}
		for (const child of node.children) {
			this.walkImports(child, language, imports, rawSpecs);
		}
	}
}

function firstChildOfType(node: TsNode, types: string[]): TsNode | null {
	for (const child of node.children) {
		if (types.includes(child.type)) return child;
	}
	return null;
}

/**
 * `Class.method` / `functionName` for a chunk, from the first name-bearing
 * child plus the enclosing chain. Used by the R1 context header and by the
 * symbol path in retrieval (exact identifier hits rank by name, not vibes).
 *
 * The name child is picked by TYPE priority, not document order: for a Java
 * method with a reference-type return (`Result compute()`), the return type
 * is a `type_identifier` that appears BEFORE the method name — picking the
 * first name-bearing child mislabeled the unit as `Result` and broke exact
 * symbol lookup. Field/property identifiers win, plain identifiers come
 * next, type identifiers only as a last resort.
 */
const NAME_TYPE_PRIORITY: Record<string, number> = {
	field_identifier: 0,
	property_identifier: 0,
	identifier: 1,
	name: 1,
	type_identifier: 2,
};

function nodeUnit(node: TsNode, ancestors: string[]): string | null {
	let best: { name: string; priority: number } | null = null;
	for (const child of node.children) {
		const priority = NAME_TYPE_PRIORITY[child.type];
		if (priority === undefined) continue;
		const text = child.text?.trim();
		if (!text) continue;
		if (!best || priority < best.priority) best = { name: text, priority };
	}
	const name = best?.name;
	if (name && ancestors.length > 0) return [...ancestors, name].join(".");
	if (name) return name;
	if (ancestors.length > 0) return ancestors.join(".");
	return null;
}

function firstChild(node: TsNode): TsNode | null {
	return node.children[0] ?? null;
}

/** Drop chunks covering the exact same span twice (same id ⇒ same span). */
function dedupeSpans(chunks: Chunk[]): Chunk[] {
	const seen = new Set<string>();
	const out: Chunk[] = [];
	for (const chunk of chunks) {
		if (seen.has(chunk.id)) continue;
		seen.add(chunk.id);
		out.push(chunk);
	}
	return out;
}

// ── R12: ast-density helpers ─────────────────────────────────────────────────

function nonWsLength(text: string): number {
	let n = 0;
	for (const ch of text) if (!/\s/.test(ch)) n++;
	return n;
}

function offsetToLine(source: string, offset: number): number {
	let line = 1;
	for (let i = 0; i < offset && i < source.length; i++) if (source[i] === "\n") line++;
	return line;
}

function classifyNode(node: TsNode): ChunkType {
	if (FUNCTION_TYPES.has(node.type)) return "function";
	if (CLASS_TYPES.has(node.type)) return "class";
	return "doc";
}

/**
 * Tile [rangeStart, rangeEnd) of `source` at node children boundaries: the
 * gap before each child is attached to that child (leading comments travel
 * with the declaration they precede), so the units cover the range with no
 * holes. Oversized children recurse; children without useful children fall
 * back to line windows. The cAST insight: syntax boundaries first, character
 * windows only where syntax runs out.
 */
function splitNode(node: TsNode, source: string, budget: number, rangeStart: number, rangeEnd: number, parentUnit: string | null): DensityUnit[] {
	const units: DensityUnit[] = [];
	const kids = node.children;
	if (kids.length === 0 || rangeEnd <= rangeStart) {
		return splitByLines(source, rangeStart, rangeEnd, budget, parentUnit);
	}
	for (let i = 0; i < kids.length; i++) {
		const kid = kids[i]!;
		const segStart = i === 0 ? rangeStart : kids[i - 1]!.endIndex;
		const segEnd = i === kids.length - 1 ? rangeEnd : kid.endIndex;
		if (segEnd <= segStart) continue;
		const text = source.slice(segStart, segEnd);
		if (nonWsLength(text) <= budget) {
			const unit = nodeUnit(kid, parentUnit ? [parentUnit] : []);
			units.push({ start: segStart, end: segEnd, text, kind: classifyNode(kid), unit, parent: parentUnit, segment: 0 });
		} else {
			const ownName = nodeUnit(kid, []) ?? parentUnit;
			units.push(...splitNode(kid, source, budget, segStart, segEnd, ownName));
		}
	}
	// Re-number segments within this range so ids stay unique on sibling spans.
	let seg = 0;
	for (const u of units) {
		if (u.parent === parentUnit) u.segment = seg++;
	}
	return units;
}

/** Leaf fallback: budget-sized line windows over [start, end). */
function splitByLines(source: string, start: number, end: number, budget: number, parentUnit: string | null): DensityUnit[] {
	const units: DensityUnit[] = [];
	let unitStart = start;
	let used = 0;
	let pos = start;
	while (pos < end) {
		let nl = source.indexOf("\n", pos);
		if (nl === -1 || nl >= end) nl = end - 1;
		const lineEnd = nl + 1;
		const line = source.slice(pos, lineEnd);
		const lineNw = nonWsLength(line);
		if (used > 0 && used + lineNw > budget) {
			units.push({ start: unitStart, end: pos, text: source.slice(unitStart, pos), kind: "doc", unit: parentUnit, parent: parentUnit, segment: units.length });
			unitStart = pos;
			used = 0;
		}
		used += lineNw;
		pos = lineEnd;
	}
	if (pos > unitStart) {
		units.push({ start: unitStart, end: pos, text: source.slice(unitStart, pos), kind: "doc", unit: parentUnit, parent: parentUnit, segment: units.length });
	}
	return units;
}

/** Greedy-merge adjacent TRIVIA units while the combination stays within budget. Named units (functions/classes) never merge with siblings: the eval showed that gluing a small function into a budget-sized blob costs the symbol signal (metadata.unit) and dilutes the hash-embedding — R@10 dropped .936 → .772. Trivia (imports, comments, top-level statements) is what needs gluing to become self-contained. */
function mergeUnits(units: DensityUnit[], source: string, budget: number): DensityUnit[] {
	const isTrivia = (u: DensityUnit) => u.unit === null && u.kind === "doc";
	const out: DensityUnit[] = [];
	for (const u of units) {
		const last = out[out.length - 1];
		if (
			last &&
			last.end === u.start &&
			isTrivia(last) &&
			isTrivia(u) &&
			nonWsLength(last.text) + nonWsLength(u.text) <= budget
		) {
			last.end = u.end;
			last.text = source.slice(last.start, last.end);
		} else {
			out.push({ ...u });
		}
	}
	return out;
}

/**
 * Normalize a JS/TS module specifier to a stable root segment.
 *
 * Handles relative specifiers (`./http.js`, `../lib/db`) which upstream's
 * raw `split("/")[0]` reduces to just `.` or `..` — useless for graph
 * expansion, and relative imports are the common case in JS/TS projects.
 */
function normalizeModuleSpecifier(raw: string): string {
	let spec = raw.trim();
	while (spec.startsWith("./") || spec.startsWith("../")) {
		spec = spec.startsWith("./") ? spec.slice(2) : spec.slice(3);
	}
	if (!spec) return raw;
	const segments = spec.split("/");
	if (spec.startsWith("@")) return segments.slice(0, 2).join("/");
	return segments[0]!;
}

/** Port of upstream `_parse_import_module`. */
/** Port of upstream `_parse_import_module`. */
function parseImportModule(node: TsNode, _language: string): string | null {
	const textOf = (n: TsNode) => n.text;
	if (node.type === "import_statement") {
		// Python "import os" / aliased; also JS "import X from 'mod'" (string child).
		const stringChild = firstChildOfType(node, ["string"]);
		if (stringChild) return normalizeModuleSpecifier(textOf(stringChild).replace(/^['"]|['"]$/g, ""));
		const dotted = firstChildOfType(node, ["dotted_name", "aliased_import"]);
		if (dotted) {
			const name = textOf(dotted).split(" as ")[0]!.trim();
			return name.split(".")[0]!;
		}
	} else if (node.type === "import_from_statement") {
		for (const child of node.children) {
			if (child.type === "dotted_name" || child.type === "relative_import") {
				const name = textOf(child).trim().replace(/^\.+/, "");
				if (name) return name.split(".")[0]!;
			}
		}
	} else if (node.type === "using_directive") {
		const child = firstChildOfType(node, ["qualified_name", "identifier"]);
		if (child) return textOf(child).trim().split(".")[0]!;
	} else if (node.type === "import_declaration") {
		const stringChild = firstChildOfType(node, ["string"]);
		if (stringChild) return normalizeModuleSpecifier(textOf(stringChild).replace(/^['"]|['"]$/g, ""));
	} else if (node.type === "use_declaration") {
		// Rust: use std::collections::HashMap; take the crate root.
		const child = firstChild(node);
		if (child) {
			const text = textOf(child).trim();
			const crateRoot = text.split("::")[0]!;
			return crateRoot.replace(/^crate::|^self::|^super::/, "") || null;
		}
	}
	return null;
}

/**
 * R7: the RAW specifier of a JS/TS string import (`./b.js`, not `b.js`).
 * Import resolution in the pipeline needs it; returns null for syntaxes
 * that carry no path-like specifier (Python dotted names, Rust paths).
 */
function parseImportModuleRaw(node: TsNode): string | null {
	if (node.type !== "import_statement" && node.type !== "import_declaration") return null;
	const stringChild = firstChildOfType(node, ["string"]);
	if (!stringChild) return null;
	return stringChild.text.replace(/^['"]|['"]$/g, "");
}

/** Sync cache of loaded Language objects (promises resolved during warmup). */
const syncLanguageCache = new Map<string, unknown>();

/** Await before first chunk so chunk() can stay synchronous. */
export async function warmupLanguages(languages: Iterable<string>): Promise<void> {
	for (const language of languages) {
		if (syncLanguageCache.has(language)) continue;
		const p = loadLanguage(language);
		if (p) syncLanguageCache.set(language, await p);
	}
}

export function isAstLanguage(language: string): boolean {
	return language in WASM_BY_LANGUAGE;
}
