/**
 * Environment smoke test — verifies the two native capabilities the package
 * depends on, without touching the network:
 *
 *   1. web-tree-sitter + tree-sitter-wasms ABI compatibility
 *   2. better-sqlite3 + the sqlite-vec extension (vec0 + FTS5)
 *
 *   node scripts/smoke-env.mjs
 */
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const require = createRequire(import.meta.url);
const failures = [];

// ── 1. tree-sitter ─────────────────────────────────────────────────────────
const Parser = require("web-tree-sitter");
await Parser.init();

const grammars = [
	["tree-sitter-python", "def foo():\n    return 1\n"],
	["tree-sitter-javascript", "export function f() { return 1; }\n"],
	["tree-sitter-typescript", "export function f(): number { return 1; }\n"],
	["tree-sitter-tsx", "export const C = () => <div />;\n"],
	["tree-sitter-go", "package main\nfunc f() int { return 1 }\n"],
	["tree-sitter-rust", "fn f() -> i32 { 1 }\n"],
	["tree-sitter-java", "class A { int f() { return 1; } }\n"],
	["tree-sitter-php", "<?php function f() { return 1; }\n"],
	["tree-sitter-c_sharp", "class A { int F() { return 1; } }\n"],
];
for (const [name, source] of grammars) {
	try {
		const wasm = require.resolve(`tree-sitter-wasms/out/${name}.wasm`);
		const lang = await Parser.Language.load(wasm);
		const parser = new Parser();
		parser.setLanguage(lang);
		const root = parser.parse(source).rootNode;
		parser.delete();
		if (!root) throw new Error("no root node");
	} catch (err) {
		failures.push(`grammar ${name}: ${err.message}`);
	}
}

// ── 2. sqlite + sqlite-vec ─────────────────────────────────────────────────
const Database = require("better-sqlite3");
const sqliteVec = require("sqlite-vec");
const dbFile = path.join(os.tmpdir(), `pce-smoke-${Date.now()}.db`);
try {
	const db = new Database(dbFile);
	db.pragma("journal_mode = WAL");
	db.loadExtension(sqliteVec.getLoadablePath());

	db.exec("CREATE VIRTUAL TABLE v USING vec0(embedding float[4] distance_metric=cosine)");
	const buf = (vals) => Buffer.from(new Float32Array(vals).buffer);
	db.prepare("INSERT INTO v(rowid, embedding) SELECT ?, ?").run(BigInt(1), buf([1, 0, 0, 0]));
	db.prepare("INSERT INTO v(rowid, embedding) SELECT ?, ?").run(BigInt(2), buf([0, 1, 0, 0]));
	const hits = db.prepare("SELECT rowid, distance FROM v WHERE embedding MATCH ? AND k = ? ORDER BY distance").all(buf([1, 0, 0, 0]), 2);
	if (Number(hits[0]?.rowid) !== 1) throw new Error(`vec search returned ${JSON.stringify(hits)}`);

	db.exec("CREATE VIRTUAL TABLE f USING fts5(id UNINDEXED, content)");
	db.prepare("INSERT INTO f(id, content) VALUES (?, ?)").run("a", "payment flow");
	if (db.prepare("SELECT id FROM f WHERE f MATCH ?").all('"payment"').length !== 1) {
		throw new Error("FTS5 match failed");
	}
	db.close();
	fs.rmSync(dbFile, { force: true });
} catch (err) {
	failures.push(`sqlite: ${err.message}`);
}

if (failures.length > 0) {
	console.error("FAILED:");
	for (const f of failures) console.error(`  - ${f}`);
	process.exit(1);
}
console.log(`OK: ${grammars.length} grammars parsed · sqlite-vec + FTS5 working`);
