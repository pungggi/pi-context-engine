/**
 * Content-hash manifest for incremental indexing — port of upstream
 * `indexer/manifest.py` (MIT).
 */
import fs from "node:fs";
import { atomicWriteText } from "../utils.js";

export const CURRENT_SCHEMA_VERSION = 3;

interface ManifestData {
	__schema_version?: number;
	files?: Record<string, string>;
	last_git_sha?: string | null;
	embedding_dim?: number | null;
}

export class Manifest {
	private entries: Record<string, string> = {};
	private schemaVersionValue: number = CURRENT_SCHEMA_VERSION;
	/** Set when an existing manifest was unreadable or not in the recognized
	 * format — the pipeline wipes the index stores so no stale rows survive. */
	private storeResetNeeded = false;
	private lastGitShaValue: string | null = null;
	private embeddingDimValue: number | null = null;

	constructor(private readonly manifestPath: string) {
		if (!fs.existsSync(manifestPath)) return;
		// An existing manifest must prove it is in the recognized versioned
		// format; until it does, it is treated as foreign (version 0) and the
		// pipeline wipes the stores before rebuilding. No compat parsing of
		// pre-versioning shapes.
		let recognized = false;
		try {
			const loaded = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ManifestData;
			const version = loaded && typeof loaded === "object" ? loaded.__schema_version : undefined;
			const files = loaded && typeof loaded === "object" ? loaded.files : undefined;
			if (
				typeof version === "number" &&
				version > 0 &&
				files !== null &&
				typeof files === "object" &&
				!Array.isArray(files)
			) {
				recognized = true;
				this.schemaVersionValue = version;
				this.entries = files ?? {};
				this.lastGitShaValue = loaded.last_git_sha ?? null;
				this.embeddingDimValue = loaded.embedding_dim ?? null;
			}
		} catch {
			// corrupt JSON — falls through to the reset below
		}
		if (!recognized) this.schemaVersionValue = 0;
		this.storeResetNeeded = !recognized || this.schemaVersionValue !== CURRENT_SCHEMA_VERSION;
	}

	/** True when the on-disk manifest was unusable/foreign and the index stores
	 * must be wiped before this run repopulates them. */
	get needsStoreReset(): boolean {
		return this.storeResetNeeded;
	}

	get lastGitSha(): string | null {
		return this.lastGitShaValue;
	}
	set lastGitSha(value: string | null) {
		this.lastGitShaValue = value;
	}
	/** Format version the on-disk manifest was written with (drives migrations). */
	get schemaVersion(): number {
		return this.schemaVersionValue;
	}
	get embeddingDim(): number | null {
		return this.embeddingDimValue;
	}
	set embeddingDim(value: number | null) {
		this.embeddingDimValue = value;
	}
	get fileEntries(): Record<string, string> {
		return this.entries;
	}
	get hasEntries(): boolean {
		return Object.keys(this.entries).length > 0;
	}

	clearEntries(): void {
		this.entries = {};
	}

	getHash(filePath: string): string | undefined {
		return this.entries[filePath];
	}

	update(filePath: string, contentHash: string): void {
		this.entries[filePath] = contentHash;
	}

	remove(filePath: string): void {
		delete this.entries[filePath];
	}

	hasChanged(filePath: string, contentHash: string): boolean {
		return this.entries[filePath] !== contentHash;
	}

	save(): void {
		atomicWriteText(
			this.manifestPath,
			JSON.stringify({
				__schema_version: CURRENT_SCHEMA_VERSION,
				files: this.entries,
				last_git_sha: this.lastGitShaValue,
				embedding_dim: this.embeddingDimValue,
			}),
		);
	}
}
