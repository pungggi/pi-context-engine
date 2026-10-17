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
				for (const idBatch of batchedParams(nodeIds)) {
					const idPh = idBatch.map(() => "?").join(",");
					this.db
						.prepare(`DELETE FROM edges WHERE source_id IN (${idPh}) OR target_id IN (${idPh})`)
						.run(...idBatch, ...idBatch);
					this.db.prepare(`DELETE FROM nodes WHERE id IN (${idPh})`).run(...idBatch);
				}
			}
		});
		run([...batchedParams(filePaths)]);
	}

	clear(): void {
		this.db.exec("DELETE FROM edges");
		this.db.exec("DELETE FROM nodes");
	}

	close(): void {
		this.db.close();
	}
}
