import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import http from "node:http";
import { ContextEngine } from "../src/engine.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { defaultConfig, type Config } from "../src/config.js";
import { DashboardServer } from "../src/dashboard/server.js";
import {
	decisionsPayload,
	filesPayload,
	savingsPayload,
	sessionsPayload,
	statusPayload,
	timelinePayload,
} from "../src/dashboard/api.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles, SAMPLE_REPO } from "./helpers.js";

const engines: ContextEngine[] = [];
const tempDirs: string[] = [];
const servers: DashboardServer[] = [];

afterEach(async () => {
	// Close handles before deleting directories — Windows refuses to unlink
	// files with open handles, and a server with keep-alive sockets must stop
	// before its engine's sqlite files are removed.
	for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
	for (const engine of engines.splice(0)) {
		try {
			await engine.shutdown();
		} catch {
			// already closed
		}
	}
	for (const dir of tempDirs.splice(0)) rmrf(dir);
});

interface Harness {
	engine: ContextEngine;
	projectDir: string;
}

async function harness(repo: Record<string, string> = SAMPLE_REPO): Promise<Harness> {
	const projectDir = makeTempDir("pce-dash-proj-");
	const storageRoot = makeTempDir("pce-dash-store-");
	tempDirs.push(projectDir, storageRoot);
	writeFiles(projectDir, repo);
	const config: Config = { ...defaultConfig(), storagePath: storageRoot };
	const engine = new ContextEngine({ projectDir, config });
	const embedder = makeFakeEmbedder();
	const backend = new LocalBackend(engine.storageBase);
	engines.push(engine);
	const internals = engine as unknown as {
		backendInstance: LocalBackend | null;
		embedderInstance: unknown;
		injectedRuntime: unknown;
	};
	internals.backendInstance = backend;
	internals.embedderInstance = embedder;
	internals.injectedRuntime = { backend, embedder };
	return { engine, projectDir };
}

describe("dashboard API payloads", () => {
	it("status reflects index size, files and the live indexing flag", async () => {
		const { engine, projectDir } = await harness();
		await engine.reindex({});
		const status = statusPayload(engine, { indexing: true });
		expect(status.project).toBe(path.basename(projectDir));
		expect(status.chunks).toBeGreaterThan(0);
		expect(status.files).toBeGreaterThanOrEqual(3);
		expect(status.indexing).toBe(true);
		expect(status.config.embeddingModel).toBe("local");
		// untouched ledger
		expect(status.stats.queries).toBe(0);
	});

	it("savings resolves buckets and dollar estimates offline", async () => {
		const { engine } = await harness();
		engine.recordQuery(4_000, 400, 40_000);
		const savings = await savingsPayload(engine);
		expect(savings.buckets.length).toBeGreaterThan(0);
		const retrieval = savings.buckets.find((b) => b.bucket === "retrieval");
		expect(retrieval?.saved).toBeGreaterThan(0);
		expect(savings.totals.savedUsd).toBeGreaterThanOrEqual(0);
		expect(savings.pricing.inputUsdPer1M).toBeGreaterThan(0);
		expect(savings.byDay.length).toBe(1); // today
	});

	it("files, sessions, timeline and decisions expose stored history", async () => {
		const { engine } = await harness();
		await engine.reindex({});
		await engine.search("charge card payment gateway", { topK: 3 });
		await engine.recordDecision("use JWT for auth", "flagged tokens");

		const files = filesPayload(engine);
		expect(files.files.some((f) => f.filePath.includes("payments"))).toBe(true);
		expect(files.chunks).toBeGreaterThan(0);

		const sessions = sessionsPayload(engine);
		expect(sessions.sessions.length).toBeGreaterThanOrEqual(1);
		expect(sessions.activeSessionId).toBe(engine.sessionId);

		const timeline = timelinePayload(engine, sessions.sessions[0]!.id);
		expect(timeline.session).not.toBeNull();
		// unknown ids resolve to an empty timeline instead of throwing
		expect(timelinePayload(engine, "no-such-session").session).toBeNull();

		const decisions = decisionsPayload(engine);
		expect(decisions.decisions.some((d) => d.decision.includes("JWT"))).toBe(true);
	});

	it("does not write savings when rendering snapshots", async () => {
		const { engine } = await harness();
		const before = engine.getStats().queries;
		statusPayload(engine, { indexing: false });
		filesPayload(engine);
		sessionsPayload(engine);
		decisionsPayload(engine);
		await savingsPayload(engine);
		await timelinePayload(engine, engine.sessionId);
		expect(engine.getStats().queries).toBe(before);
	});
});

describe("dashboard server", () => {
	const startServer = async (engine: ContextEngine | null, port = 0): Promise<DashboardServer> => {
		const server = new DashboardServer();
		servers.push(server);
		await server.start({ engine: () => engine, indexing: () => false, port });
		return server;
	};

	it("serves the page and every API route", async () => {
		const { engine } = await harness();
		await engine.reindex({});
		const server = await startServer(engine);
		expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);

		const page = await fetch(`${server.url}/`);
		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toContain("text/html");
		expect(await page.text()).toContain("pi-context-engine");

		const status = (await (await fetch(`${server.url}/api/status`)).json()) as { project: string; chunks: number };
		expect(status.chunks).toBeGreaterThan(0);

		const files = (await (await fetch(`${server.url}/api/files`)).json()) as { total: number };
		expect(files.total).toBeGreaterThan(0);

		const sessions = (await (await fetch(`${server.url}/api/sessions`)).json()) as {
			sessions: { id: string }[];
		};
		expect(sessions.sessions.length).toBeGreaterThanOrEqual(1);

		const timeline = await fetch(`${server.url}/api/sessions/${encodeURIComponent(sessions.sessions[0]!.id)}`);
		expect(timeline.status).toBe(200);

		const decisions = (await (await fetch(`${server.url}/api/decisions`)).json()) as { decisions: unknown[] };
		expect(Array.isArray(decisions.decisions)).toBe(true);

		const savings = (await (await fetch(`${server.url}/api/savings`)).json()) as { buckets: unknown[] };
		expect(Array.isArray(savings.buckets)).toBe(true);

		const exportResponse = await fetch(`${server.url}/api/export`);
		expect(exportResponse.headers.get("content-disposition")).toContain("attachment");
		const exported = (await exportResponse.json()) as { status: unknown };
		expect(exported.status).toBeTruthy();
	});

	it("rejects non-GET methods, unknown routes and foreign Host headers", async () => {
		const { engine } = await harness();
		const server = await startServer(engine);

		const post = await fetch(`${server.url}/api/status`, { method: "POST" });
		expect(post.status).toBe(405);
		expect(post.headers.get("allow")).toContain("GET");

		expect((await fetch(`${server.url}/api/nope`)).status).toBe(404);

		// DNS-rebinding guard: the Host header must be loopback with our port.
		// fetch() cannot test this — Host is a forbidden header name and undici
		// silently rewrites it — so the probe uses node:http directly.
		const rebindingPort = Number(new URL(server.url!).port);
		const evilStatus = await new Promise<number>((resolve, reject) => {
			const req = http.get(`${server.url}/api/status`, { headers: { Host: `evil.example:${rebindingPort}` } }, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on("error", reject);
		});
		expect(evilStatus).toBe(403);
	});

	it("reports 503 when no engine is live and is idempotent on start", async () => {
		const server = await startServer(null);
		const status = await fetch(`${server.url}/api/status`);
		expect(status.status).toBe(503);
		// page still renders (client shows the offline state)
		expect((await fetch(`${server.url}/`).then((r) => r.status))).toBe(200);

		const again = await server.start({ engine: () => null, indexing: () => false, port: 0 });
		expect(again).toBe(server.url);
	});

	it("stops cleanly and stops serving", async () => {
		const { engine } = await harness();
		const server = await startServer(engine);
		const url = server.url!;
		expect((await fetch(`${url}/api/status`)).status).toBe(200);
		await server.stop();
		expect(server.running).toBe(false);
		await expect(fetch(`${url}/api/status`)).rejects.toThrow();
	});
});
