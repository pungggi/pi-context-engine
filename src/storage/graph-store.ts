/**
 * Graph store (nodes + edges) — port of upstream `storage/graph_store.py` (MIT).
 */
import path from "node:path";
import { openDatabase, type SqliteHandle } from "../sqlite.js";
import { batchedParams } from "../utils.js";
import type { EdgeType, GraphEdge, GraphNode, NodeType } from "../types.js";

const DDL = `
CREATE TABLE IF NOT EXISTS nodes (
	id          TEXT PRIMARY KEY,
	node_type   TEXT NOT NULL,
	name        TEXT NOT NULL,
	file_path   TEXT NOT NULL,
	properties  TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS edges (
	source_id   TEXT NOT NULL,
	target_id   TEXT NOT NULL,
	edge_type   TEXT NOT NULL,
	properties  TEXT NOT NULL DEFAULT '{}',
	PRIMARY KEY (source_id, target_id, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges (source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges (target_id);
CREATE INDEX IF NOT EXISTS idx_nodes_file   ON nodes  (file_path);
CREATE TABLE IF NOT EXISTS pagerank (
	file_path TEXT PRIMARY KEY,
	score     REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS pagerank_nodes (
	node_id TEXT PRIMARY KEY,
	score   REAL NOT NULL
);
`;

type Sqlite = SqliteHandle;

function rowToNode(row: Record<string, unknown>): GraphNode {
	return {
		id: row.id as string,
		nodeType: row.node_type as NodeType,
		name: row.name as string,
		filePath: row.file_path as string,
		properties: JSON.parse((row.properties as string) || "{}"),
	};
}

export class GraphStore {
	private db: Sqlite;

	constructor(dbPath: string) {
		this.db = openDatabase(dbPath + ".db").db;
		this.db.exec(DDL);
	}

	ingest(nodes: GraphNode[], edges: GraphEdge[]): void {
		const insNode = this.db.prepare(
			"INSERT OR REPLACE INTO nodes (id, node_type, name, file_path, properties) VALUES (?, ?, ?, ?, ?)",
		);
		const insEdge = this.db.prepare(
			"INSERT OR REPLACE INTO edges (source_id, target_id, edge_type, properties) VALUES (?, ?, ?, ?)",
		);
		const run = this.db.transaction(() => {
			for (const n of nodes) {
				insNode.run(n.id, n.nodeType, n.name, n.filePath, JSON.stringify(n.properties));
			}
			for (const e of edges) {
				insEdge.run(e.sourceId, e.targetId, e.edgeType, JSON.stringify(e.properties));
			}
		});
		run();
	}

	getNeighbors(nodeId: string, edgeType?: EdgeType): GraphNode[] {
		const sql = edgeType
			? `SELECT n.id, n.node_type, n.name, n.file_path, n.properties
			   FROM edges e JOIN nodes n ON e.target_id = n.id
			   WHERE e.source_id = ? AND e.edge_type = ?`
			: `SELECT n.id, n.node_type, n.name, n.file_path, n.properties
			   FROM edges e JOIN nodes n ON e.target_id = n.id
			   WHERE e.source_id = ?`;
		const rows = (
			edgeType ? this.db.prepare(sql).all(nodeId, edgeType) : this.db.prepare(sql).all(nodeId)
		) as Record<string, unknown>[];
		return rows.map(rowToNode);
	}

	getNodesByFile(filePath: string): GraphNode[] {
		const rows = this.db
			.prepare("SELECT id, node_type, name, file_path, properties FROM nodes WHERE file_path = ?")
			.all(filePath) as Record<string, unknown>[];
		return rows.map(rowToNode);
	}

	/**
	 * PR #7 review fix (incremental call graph): every function/class node
	 * across ALL indexed files, so calls-edge derivation on an incremental
	 * run still sees symbols owned by files that did not change this run.
	 */
	listSymbolNodes(): GraphNode[] {
		const rows = this.db
			.prepare(
				"SELECT id, node_type, name, file_path, properties FROM nodes WHERE node_type IN ('function','class')",
			)
			.all() as Record<string, unknown>[];
		return rows.map(rowToNode);
	}

	/**
	 * R5: structured symbol lookup for the multi-path retriever. Matches a
	 * chunk-level node whose name EQUALS a queried identifier, ENDS with
	 * `.identifier` (so `charge` finds `PaymentGateway.charge`), or STARTS with
	 * `identifier.` (so `PaymentGateway` surfaces its methods). Exact matches
	 * rank first; results are deterministic (name length as the tiebreak) so
	 * RRF fusion is reproducible.
	 */
	findSymbols(names: string[], limit = 20): GraphNode[] {
		if (names.length === 0) return [];
		const conds: string[] = [];
		const params: unknown[] = [];
		for (const raw of names) {
			const name = raw.trim().toLowerCase();
			if (name.length < 3) continue;
			conds.push("(lower(name) = ? OR lower(name) LIKE ? OR lower(name) LIKE ?)");
			params.push(name, `%.${name}`, `${name}.%`);
		}
		if (conds.length === 0) return [];
		params.push(Math.max(limit * 3, 30)); // overfetch: JS ranks exact-first, then cuts
		let rows: Record<string, unknown>[];
		try {
			rows = this.db
				.prepare(
					`SELECT id, node_type, name, file_path, properties FROM nodes
					 WHERE node_type IN ('function', 'class', 'module', 'doc')
					 AND (${conds.join(" OR ")})
					 LIMIT ?`,
				)
				.all(...params) as Record<string, unknown>[];
		} catch {
			return [];
		}
		const exact = new Set(names.map((n) => n.trim().toLowerCase()));
		const nodes = rows.map(rowToNode);
		nodes.sort((a, b) => {
			const ax = exact.has(a.name.toLowerCase()) ? 0 : 1;
			const bx = exact.has(b.name.toLowerCase()) ? 0 : 1;
			if (ax !== bx) return ax - bx;
			return a.name.length - b.name.length;
		});
		return nodes.slice(0, limit);
	}

	neighborsForFiles(filePaths: string[], edgeTypes: EdgeType[], nodeTypes?: NodeType[]): GraphNode[] {
		if (filePaths.length === 0 || edgeTypes.length === 0) return [];
		const fpPh = filePaths.map(() => "?").join(",");
		const etPh = edgeTypes.map(() => "?").join(",");
		const params: unknown[] = [...filePaths, ...edgeTypes];
		let nodeFilter = "";
		if (nodeTypes && nodeTypes.length > 0) {
			nodeFilter = ` AND src.node_type IN (${nodeTypes.map(() => "?").join(",")})`;
			params.push(...nodeTypes);
		}
		const rows = this.db
			.prepare(
				`SELECT DISTINCT tgt.id, tgt.node_type, tgt.name, tgt.file_path, tgt.properties
				 FROM nodes src
				 JOIN edges e ON e.source_id = src.id
				 JOIN nodes tgt ON tgt.id = e.target_id
				 WHERE src.file_path IN (${fpPh}) AND e.edge_type IN (${etPh})${nodeFilter}`,
			)
			.all(...params) as Record<string, unknown>[];
		return rows.map(rowToNode);
	}

	/**
	 * R7: PageRank over the file-level projection of the graph (imports +
	 * calls edges collapsed to file→file). Scores are normalised so the
	 * best-connected file is 1.0; the retriever applies them as a bounded
	 * multiplicative prior. Hub files genuinely central to a codebase —
	 * types, shared utils, the engine — consistently rank above leaves, which
	 * is exactly the tie-break signal fusion needs when lexical and vector
	 * evidence disagree.
	 */
	computePageRank(): void {
		const nodeFile = new Map<string, string>();
		for (const row of this.db.prepare("SELECT id, file_path FROM nodes").all() as {
			id: string;
			file_path: string;
		}[]) {
			nodeFile.set(row.id, row.file_path);
		}
		const edgeRows = this.db
			.prepare("SELECT source_id, target_id FROM edges WHERE edge_type IN ('imports', 'calls')")
			.all() as { source_id: string; target_id: string }[];

		const nodes = new Set<string>();
		for (const fp of nodeFile.values()) if (fp) nodes.add(fp);
		const out = new Map<string, Set<string>>();
		for (const e of edgeRows) {
			const s = nodeFile.get(e.source_id);
			const tgt = nodeFile.get(e.target_id);
			if (!s || !tgt || s === tgt) continue;
			let set = out.get(s);
			if (!set) out.set(s, (set = new Set()));
			set.add(tgt);
		}

		const run = this.db.transaction(() => {
			this.db.exec("DELETE FROM pagerank");
			if (nodes.size === 0) return;
			const d = 0.85;
			const n = nodes.size;
			const incoming = new Map<string, string[]>();
			for (const [s, targets] of out) {
				for (const tgt of targets) {
					let arr = incoming.get(tgt);
					if (!arr) incoming.set(tgt, (arr = []));
					arr.push(s);
				}
			}
			let rank = new Map<string, number>();
			for (const node of nodes) rank.set(node, 1 / n);
			for (let iter = 0; iter < 25; iter++) {
				const next = new Map<string, number>();
				let dangling = 0;
				for (const node of nodes) {
					const o = out.get(node);
					if (!o || o.size === 0) dangling += rank.get(node) ?? 0;
				}
				for (const node of nodes) {
					let s = (1 - d) / n + (d * dangling) / n;
					for (const src of incoming.get(node) ?? []) {
						s += (d * (rank.get(src) ?? 0)) / (out.get(src)?.size ?? 1);
					}
					next.set(node, s);
				}
				rank = next;
			}
			const max = Math.max(...rank.values(), 1e-12);
			const ins = this.db.prepare("INSERT OR REPLACE INTO pagerank (file_path, score) VALUES (?, ?)");
			for (const [fp, s] of rank) ins.run(fp, s / max);
		});
		run();
	}

	/** Read of the PageRank table (file_path → score in [0,1]). */
	pageRanks(): Map<string, number> {
		const rows = this.db.prepare("SELECT file_path, score FROM pagerank").all() as {
			file_path: string;
			score: number;
		}[];
		return new Map(rows.map((r) => [r.file_path, r.score]));
	}

	/**
	 * Symbol-level PageRank (WP2, docs/RESEARCH-COMPETITORS.md §1): the same
	 * power iteration as computePageRank, but over the node/edge graph itself
	 * instead of its file projection. `calls` (caller→callee) and `defines`
	 * (file→symbol) edges let a hub function that many files call outrank a
	 * leaf of equal lexical evidence, so unranked neighbour lists (the
	 * related_context fallbacks) get an importance order à la Aider's repo map.
	 *
	 * Scope: code edges only (`calls`, `imports`, `defines`); commit and
	 * memory nodes stay out, dangling mass is redistributed like the file
	 * version, and scores are max-normalised to [0,1].
	 */
	computeSymbolPageRank(): void {
		const nodes = new Set<string>();
		for (const r of this.db
			.prepare("SELECT id FROM nodes WHERE node_type IN ('function','class','file','module','doc')")
			.all() as { id: string }[]) nodes.add(r.id);
		const edgeRows = this.db
			.prepare("SELECT source_id, target_id FROM edges WHERE edge_type IN ('calls','imports','defines')")
			.all() as { source_id: string; target_id: string }[];

		const out = new Map<string, Set<string>>();
		const incoming = new Map<string, string[]>();
		const seenPair = new Set<string>();
		let edges = 0;
		for (const e of edgeRows) {
			if (!nodes.has(e.source_id) || !nodes.has(e.target_id)) continue; // stale endpoint guard
			if (e.source_id === e.target_id) continue;
			const key = `${e.source_id}\u0000${e.target_id}`;
			if (seenPair.has(key)) continue; // dedupe: edge PK is (source,target,type), types collapse here
			seenPair.add(key);
			edges++;
			let set = out.get(e.source_id);
			if (!set) out.set(e.source_id, (set = new Set()));
			set.add(e.target_id);
			let inc = incoming.get(e.target_id);
			if (!inc) incoming.set(e.target_id, (inc = []));
			inc.push(e.source_id);
		}

		const run = this.db.transaction(() => {
			this.db.exec("DELETE FROM pagerank_nodes");
			if (nodes.size === 0 || edges === 0) return;
			const d = 0.85;
			const n = nodes.size;
			let rank = new Map<string, number>();
			for (const node of nodes) rank.set(node, 1 / n);
			for (let iter = 0; iter < 25; iter++) {
				const next = new Map<string, number>();
				let dangling = 0;
				for (const node of nodes) {
					const o = out.get(node);
					if (!o || o.size === 0) dangling += rank.get(node) ?? 0;
				}
				for (const node of nodes) {
					let s = (1 - d) / n + (d * dangling) / n;
					for (const src of incoming.get(node) ?? []) {
						s += (d * (rank.get(src) ?? 0)) / (out.get(src)?.size ?? 1);
					}
					next.set(node, s);
				}
				rank = next;
			}
			// Loop, not Math.max(...values()): node counts track chunk counts and
			// spread hits V8's argument cap on big indexes.
			let max = 1e-12;
			for (const s of rank.values()) if (s > max) max = s;
			const ins = this.db.prepare("INSERT OR REPLACE INTO pagerank_nodes (node_id, score) VALUES (?, ?)");
			for (const [id, s] of rank) ins.run(id, s / max);
		});
		run();
	}

	/** Read of the symbol PageRank table (node_id → score in [0,1]). */
	symbolPageRanks(): Map<string, number> {
		const rows = this.db.prepare("SELECT node_id, score FROM pagerank_nodes").all() as {
			node_id: string;
			score: number;
		}[];
		return new Map(rows.map((r) => [r.node_id, r.score]));
	}

	getNodesByType(nodeType: NodeType): GraphNode[] {
		const rows = this.db
			.prepare("SELECT id, node_type, name, file_path, properties FROM nodes WHERE node_type = ?")
			.all(nodeType) as Record<string, unknown>[];
		return rows.map(rowToNode);
	}

	deleteByFile(filePath: string): void {
		this.deleteByFiles([filePath]);
	}

	deleteByFiles(filePaths: string[]): void {
		if (filePaths.length === 0) return;
		const run = this.db.transaction((batches: string[][]) => {
			for (const batch of batches) {
				const ph = batch.map(() => "?").join(",");
				const nodeIds = (
					this.db.prepare(`SELECT id FROM nodes WHERE file_path IN (${ph})`).all(...batch) as {
						id: string;
				}[]
				).map((r) => r.id);
				// R7: file_* node ids are STABLE across re-ingest of the same
				// file, so inbound imports edges from other files stay valid.
				// Only delete edges pointing at this file's chunk-level nodes
				// (their ids change when content changes). Without this,
				// re-indexing b.ts silently deleted every a.ts→b.ts imports
				// edge unless a.ts changed too.
				const chunkNodeIds = nodeIds.filter((id) => !id.startsWith("file_"));
				for (const idBatch of batchedParams(nodeIds)) {
					const idPh = idBatch.map(() => "?").join(",");
					this.db
						.prepare(`DELETE FROM nodes WHERE id IN (${idPh})`).run(...idBatch);
					// WP2: symbol PageRank rows are keyed by the same node ids
					// (no file_path column), so they go in the same pass.
					this.db
						.prepare(`DELETE FROM pagerank_nodes WHERE node_id IN (${idPh})`).run(...idBatch);
				}
				const srcPh = nodeIds.map(() => "?").join(",");
				this.db.prepare("DELETE FROM edges WHERE source_id IN (" + srcPh + ")").run(...nodeIds);
				if (chunkNodeIds.length > 0) {
					const tgtPh = chunkNodeIds.map(() => "?").join(",");
					this.db.prepare("DELETE FROM edges WHERE target_id IN (" + tgtPh + ")").run(...chunkNodeIds);
				}
				const filePh = batch.map(() => "?").join(",");
				this.db.prepare("DELETE FROM pagerank WHERE file_path IN (" + filePh + ")").run(...batch);
			}
		});
		run([...batchedParams(filePaths)]);
	}

	clear(): void {
		this.db.exec("DELETE FROM edges");
		this.db.exec("DELETE FROM nodes");
		this.db.exec("DELETE FROM pagerank");
		this.db.exec("DELETE FROM pagerank_nodes");
	}

	close(): void {
		this.db.close();
	}
}
