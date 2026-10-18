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
	private lastGitShaValue: string | null = null;
	private embeddingDimValue: number | null = null;

	constructor(private readonly manifestPath: string) {
		if (fs.existsSync(manifestPath)) {
			try {
				const loaded = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ManifestData;
				if (loaded && typeof loaded === "object") {
					if ("__schema_version" in loaded) {
						this.schemaVersionValue = loaded.__schema_version ?? 1;
						this.entries = loaded.files ?? {};
						this.lastGitShaValue = loaded.last_git_sha ?? null;
						this.embeddingDimValue = loaded.embedding_dim ?? null;
					} else {
						// Old plain-dict format (pre-v0.2) — treat as version 1.
						this.schemaVersionValue = 1;
						this.entries = loaded as unknown as Record<string, string>;
					}
				}
			} catch {
				this.entries = {};
			}
		}
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
