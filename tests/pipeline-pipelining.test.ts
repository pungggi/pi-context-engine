/**
 * Pipelined batches: the pipeline must overlap the expensive sync prep of
 * batch N+1 (file reads, tree-sitter parsing) with batch N's embed wait, and
 * slot batch N's sqlite ingest between the two embeds (one embed in flight
 * at a time). Regression guard for the wall-time win on cold starts.
 */
import { describe, expect, it } from "vitest";
import { defaultConfig, type Config } from "../src/config.js";
import { runIndexing } from "../src/indexer/pipeline.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles } from "./helpers.js";

const BATCH = 50; // pipeline.ts BATCH — keep in sync; the test needs > 1 batch

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("pipelined indexing", () => {
	it("preps batch 2 during batch 1's embed wait and ingests between embeds", async () => {
		const projectDir = makeTempDir("pce-pipe-");
		const storageRoot = makeTempDir("pce-pipe-store-");
		const files: Record<string, string> = {};
		for (let i = 0; i < BATCH + 2; i++) files[`src/file${i}.txt`] = `content number ${i} for the pipelining test\n`;
		writeFiles(projectDir, files);

		const config: Config = { ...defaultConfig(), storagePath: storageRoot };
		const embedder = makeFakeEmbedder();
		const backend = new LocalBackend(storageRoot);

		const events: string[] = [];
		const realEmbed = embedder.embedTexts.bind(embedder);
		const realIngest = backend.ingest.bind(backend);
		let releaseEmbed1!: () => void;
		const embed1Gate = new Promise<void>((resolve) => (releaseEmbed1 = resolve));
		let embedCalls = 0;

		embedder.embedTexts = async (texts: string[]) => {
			embedCalls++;
			events.push(`embed-start-${embedCalls}`);
			if (embedCalls === 1) await embed1Gate; // hold batch 1's embed open
			events.push(`embed-end-${embedCalls}`);
			return realEmbed(texts);
		};
		backend.ingest = (chunks, nodes, edges) => {
			events.push(`ingest-${chunks.length}`);
			realIngest(chunks, nodes, edges);
		};

		const run = runIndexing(config, projectDir, {
			callbacks: {
				progress: (current) => events.push(`progress-${current}`),
				phase: () => events.push("phase"),
			},
			runtime: { backend, embedder },
		});

		// Wait for batch 2's prep to finish (its progress line) while embed 1
		// is still held open — this is the overlap this test pins.
		const deadline = Date.now() + 10_000;
		while (!events.includes(`progress-${BATCH + 2}`) && Date.now() < deadline) await delay(5);
		expect(events).toContain(`progress-${BATCH + 2}`);
		// …and batch 1 is still in flight: not embedded, not ingested.
		expect(events).not.toContain("embed-end-1");
		releaseEmbed1();

		const result = await run;

		// Ordering: prep2 during embed1 → ingest1 after embed1, before embed2.
		const iProgress2 = events.indexOf(`progress-${BATCH + 2}`);
		const iEmbedEnd1 = events.indexOf("embed-end-1");
		const iIngest1 = events.indexOf(`ingest-${BATCH}`);
		const iEmbedStart2 = events.indexOf("embed-start-2");
		expect(iProgress2).toBeLessThan(iEmbedEnd1);
		expect(iEmbedEnd1).toBeLessThan(iIngest1);
		expect(iIngest1).toBeLessThan(iEmbedStart2);

		// Correctness unchanged: every file indexed exactly once.
		expect(result.indexedFiles).toHaveLength(BATCH + 2);
		expect(result.errors).toEqual([]);
		expect(backend.chunksByFile("src/file0.txt", 10).length).toBeGreaterThan(0);

		// Close the backend's sqlite handles first — Windows refuses to delete
		// files that still have open handles (same reason other tests shutdown
		// their engines in afterEach).
		backend.close();
		rmrf(projectDir);
		rmrf(storageRoot);
	});
});
