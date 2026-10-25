/**
 * Dashboard smoke + static preview generator.
 *
 * Starts the read-only dashboard server against this repo's real index,
 * exercises every route, then writes a fully-populated STATIC preview
 * (fetch() stubbed with the captured payloads) to .pi/scratch/ so the UI can
 * be inspected without a running pi session.
 *
 * Usage: npx tsx scripts/smoke-dashboard.mts [--no-preview] [--open]
 */
import fs from "node:fs";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";
import { DashboardServer } from "../src/dashboard/server.js";
import { PAGE_HTML } from "../src/dashboard/page.js";

const root = path.resolve(import.meta.dirname, "..");
const engine = new ContextEngine({ projectDir: root });
const server = new DashboardServer();
await server.start({ engine: () => engine, indexing: () => false, port: 0 });
const base = server.url!;
console.log(`dashboard: ${base} (project: ${engine.projectName})`);

const routes = ["/", "/api/status", "/api/files", "/api/sessions", "/api/decisions", "/api/savings", "/api/export"];
for (const route of routes) {
	const res = await fetch(base + route);
	const type = res.headers.get("content-type") ?? "";
	const body = type.includes("json") ? JSON.stringify(await res.json()).slice(0, 90) : `html ${((await res.text()) || "").length}b`;
	console.log(`${res.status} ${route} → ${type.split(";")[0]} · ${body}…`);
}

if (!process.argv.includes("--no-preview")) {
	const captured: Record<string, unknown> = {};
	for (const route of routes.slice(1)) {
		captured[route] = await (await fetch(base + route)).json();
	}
	// The sessions tab auto-opens the newest session: capture its timeline so
	// the static preview shows the detail pane populated too.
	const newest = (captured["/api/sessions"] as { sessions: { id: string }[] }).sessions[0];
	if (newest) {
		captured[`/api/sessions/${newest.id}`] = await (
			await fetch(`${base}/api/sessions/${encodeURIComponent(newest.id)}`)
		).json();
	}
	// Static preview: stub fetch() with the captured payloads before the page
	// script runs, so the UI renders fully populated with no server behind it.
	const stub = `<script>
window.__captured = ${JSON.stringify(captured)};
(function () {
  var orig = window.fetch;
  window.fetch = function (input) {
    var url = String(input).replace(/^https?:\\/\\/[^/]+/, "");
    if (url === "/") return Promise.resolve(new Response("<html></html>", { status: 200 }));
    if (window.__captured[url]) {
      return Promise.resolve(new Response(JSON.stringify(window.__captured[url]), {
        status: 200, headers: { "Content-Type": "application/json" },
      }));
    }
    return Promise.resolve(new Response(JSON.stringify({ error: "offline preview: no data for " + url }), {
      status: 404, headers: { "Content-Type": "application/json" },
    }));
  };
})();
</script>`;
	const preview = PAGE_HTML.replace("</head>", stub + "\n</head>");
	const outPath = path.join(root, ".pi", "scratch", "dashboard-preview.html");
	fs.writeFileSync(outPath, preview, "utf-8");
	console.log(`preview: ${outPath}`);
}

await server.stop();
await engine.shutdown().catch(() => undefined);
console.log("smoke OK");
