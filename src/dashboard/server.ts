/**
 * Local read-only dashboard server.
 *
 * Binds 127.0.0.1 only, serves GET/HEAD requests exclusively, and validates
 * the Host header so a page loaded from any other origin (including a
 * DNS-rebinding domain pointing at 127.0.0.1) gets rejected. There are no
 * mutating endpoints by design — every state change goes through pi
 * commands, so no CSRF/token machinery is needed.
 */
import http from "node:http";
import type { ContextEngine } from "../engine.js";
import {
	decisionsPayload,
	exportPayload,
	filesPayload,
	sessionsPayload,
	statusPayload,
	timelinePayload,
	savingsPayload,
	type ExtDashboardState,
} from "./api.js";
import { PAGE_HTML } from "./page.js";

export interface DashboardServerOptions {
	/** Live-engine accessor; returning null makes every /api route report 503. */
	engine: () => ContextEngine | null;
	/** Live background-indexing flag for the status poll. */
	indexing: () => boolean;
	/** TCP port; 0 (default) picks a free port. */
	port?: number;
	log?: (msg: string, level: "info" | "warning") => void;
}

const MAX_SESSION_ID_CHARS = 200;

const sendJson = (res: http.ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}): void => {
	const text = JSON.stringify(body);
	res.writeHead(code, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		...extra,
	});
	res.end(text);
};

const clampLimit = (raw: string | null, fallback: number, max: number): number => {
	const n = Number(raw);
	if (!Number.isFinite(n) || n <= 0) return fallback;
	return Math.min(Math.floor(n), max);
};

export class DashboardServer {
	private server: http.Server | null = null;
	private baseUrlValue: string | null = null;

	get url(): string | null {
		return this.baseUrlValue;
	}

	get running(): boolean {
		return this.server !== null;
	}

	/** Idempotent: returns the existing URL when already listening. */
	start(options: DashboardServerOptions): Promise<string> {
		if (this.server && this.baseUrlValue) return Promise.resolve(this.baseUrlValue);
		return new Promise((resolve, reject) => {
			const server = http.createServer((req, res) => {
				try {
					this.handle(req, res, options);
				} catch (err) {
					// handle() is sync-only except for the async payload builders it
					// routes through sendPayload; this is a last-resort guard.
					sendJson(res, 500, { error: "internal error" });
					options.log?.(`dashboard request failed: ${(err as Error).message}`, "warning");
				}
			});
			server.on("clientError", (_err, socket) => {
				// Malformed HTTP (scanners, port probes): drop the socket, never crash.
				if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
				else socket.destroy();
			});
			server.on("error", (err) => {
				this.server = null;
				this.baseUrlValue = null;
				reject(err);
			});
			const port = options.port ?? 0;
			server.listen(port, "127.0.0.1", () => {
				const address = server.address();
				if (!address || typeof address === "string") {
					reject(new Error("dashboard server got an unexpected address"));
					server.close();
					return;
				}
				this.server = server;
				this.baseUrlValue = `http://127.0.0.1:${address.port}`;
				resolve(this.baseUrlValue);
			});
		});
	}

	async stop(): Promise<void> {
		const server = this.server;
		if (!server) return;
		this.server = null;
		this.baseUrlValue = null;
		// Node 18.2+: terminate keep-alive sockets so close() is deterministic
		// even with a browser tab still polling.
		(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
		await new Promise<void>((resolve) => {
			server.close(() => resolve());
		});
	}

	private allowedHost(hostHeader: string | undefined, port: number): boolean {
		if (!hostHeader) return false;
		const normalized = hostHeader.trim().toLowerCase();
		return normalized === `127.0.0.1:${port}` || normalized === `localhost:${port}`;
	}

	private handle(req: http.IncomingMessage, res: http.ServerResponse, options: DashboardServerOptions): void {
		const method = (req.method ?? "GET").toUpperCase();
		if (method !== "GET" && method !== "HEAD") {
			res.setHeader("Allow", "GET, HEAD");
			sendJson(res, 405, { error: "read-only dashboard: only GET is supported" });
			return;
		}
		if (req.headers.upgrade) {
			sendJson(res, 426, { error: "upgrades not supported" });
			return;
		}
		const address = this.server?.address();
		const port = address && typeof address !== "string" ? address.port : 0;
		if (!this.allowedHost(req.headers.host, port)) {
			sendJson(res, 403, { error: "forbidden host" });
			return;
		}

		const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		const route = url.pathname;

		if (route === "/" || route === "/index.html") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
			res.end(method === "HEAD" ? undefined : PAGE_HTML);
			return;
		}

		const eng = options.engine();
		if (!eng) {
			sendJson(res, 503, { error: "no active context engine — open the dashboard from a pi session in a project" });
			return;
		}
		const ext: ExtDashboardState = { indexing: options.indexing() };

		void (async (): Promise<void> => {
			switch (route) {
				case "/api/status":
					sendJson(res, 200, statusPayload(eng, ext));
					return;
				case "/api/savings":
					sendJson(res, 200, await savingsPayload(eng));
					return;
				case "/api/files":
					sendJson(res, 200, filesPayload(eng, clampLimit(url.searchParams.get("limit"), 500, 5000), clampLimit(url.searchParams.get("offset"), 0, 1e9)));
					return;
				case "/api/sessions":
					sendJson(res, 200, sessionsPayload(eng, clampLimit(url.searchParams.get("limit"), 50, 500)));
					return;
				case "/api/decisions":
					sendJson(res, 200, decisionsPayload(eng, clampLimit(url.searchParams.get("limit"), 100, 500)));
					return;
				case "/api/export":
					sendJson(res, 200, await exportPayload(eng, ext), {
						"Content-Disposition": `attachment; filename="context-engine-export-${eng.projectName}.json"`,
					});
					return;
				default:
					break;
			}
			const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(route);
			if (sessionMatch) {
				let sessionId: string;
				try {
					sessionId = decodeURIComponent(sessionMatch[1] ?? "");
				} catch {
					sendJson(res, 400, { error: "malformed session id" });
					return;
				}
				if (!sessionId || sessionId.length > MAX_SESSION_ID_CHARS || /[\0-\x1f\x7f]/.test(sessionId)) {
					sendJson(res, 400, { error: "malformed session id" });
					return;
				}
				sendJson(res, 200, timelinePayload(eng, sessionId));
				return;
			}
			sendJson(res, 404, { error: `unknown route ${route}` });
		})().catch((err: unknown) => {
			if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
			else res.end();
			options.log?.(`dashboard request failed: ${(err as Error).message}`, "warning");
		});
	}
}
