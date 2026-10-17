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
	"function_definition", "function_declaration",
	"method_definition", "method_declaration",
	"arrow_function",
	"function_item",
	"local_function_statement",
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

	chunkWithImports(source: string, filePath: string, language: string): { chunks: Chunk[]; imports: string[] } {
		const chunks = this.chunk(source, filePath, language);
		const imports = this.extractImports(source, language);
		return { chunks, imports };
	}

	private walk(node: TsNode, source: string, filePath: string, language: string, chunks: Chunk[]): void {
		if (FUNCTION_TYPES.has(node.type)) {
			chunks.push(this.nodeToChunk(node, source, filePath, language, "function"));
		} else if (CLASS_TYPES.has(node.type)) {
			chunks.push(this.nodeToChunk(node, source, filePath, language, "class"));
		}
		for (const child of node.children) {
			this.walk(child, source, filePath, language, chunks);
		}
	}

	private nodeToChunk(node: TsNode, source: string, filePath: string, language: string, chunkType: ChunkType): Chunk {
		// node.text is sliced correctly by the binding (UTF-8 aware).
		void source;
		const content = node.text;
		const startLine = node.startPosition.row + 1;
		const endLine = node.endPosition.row + 1;
		const id = sha256Hex(`${filePath}:${startLine}:${endLine}:${content.slice(0, 100)}`).slice(0, 16);
		return makeChunk({ id, content, chunkType, filePath, startLine, endLine, language });
	}

	private extractImports(source: string, language: string): string[] {
		const lang = syncLanguageCache.get(language);
		if (!lang) return [];
		const parser = this.acquireParser();
		try {
			(parser as { setLanguage(l: unknown): void }).setLanguage(lang);
			const tree = (parser as { parse(s: string): { rootNode: TsNode } }).parse(source);
			const imports: string[] = [];
			this.walkImports(tree.rootNode, language, imports);
			return [...new Set(imports)];
		} finally {
			this.releaseParser(parser);
		}
	}

	private walkImports(node: TsNode, language: string, imports: string[]): void {
		if (IMPORT_TYPES.has(node.type)) {
			const module = parseImportModule(node, language);
			if (module) imports.push(module);
		}
		for (const child of node.children) {
			this.walkImports(child, language, imports);
		}
	}
}

function firstChildOfType(node: TsNode, types: string[]): TsNode | null {
	for (const child of node.children) {
		if (types.includes(child.type)) return child;
	}
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
