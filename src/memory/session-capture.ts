/**
 * Session history capture — port of upstream `integration/session_capture.py`
 * (MIT). Keeps an in-memory session log and flushes it to JSON on disk.
 * pi's event hooks drive it instead of upstream's curl-based Claude hooks.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWriteText, epochSeconds, epochSecondsFloat, newSessionId } from "../utils.js";

const PRUNE_THRESHOLD = 100;
const PRUNE_KEEP = 50;
const DECISIONS_LOG_NAME = "decisions_log.json";

export interface DecisionRecord {
	decision: string;
	reason: string;
	timestamp: number;
}

export interface CodeAreaRecord {
	filePath: string;
	description: string;
	timestamp: number;
}

export interface SessionSnapshot {
	id: string;
	project: string;
	startedAt: number;
	endedAt?: number;
	decisions: DecisionRecord[];
	codeAreas: CodeAreaRecord[];
	questions: { question: string; answer: string; timestamp: number }[];
	touchedFiles: Record<string, number>;
}

export class SessionCapture {
	private sessionsDir: string;
	private active = new Map<string, SessionSnapshot>();
	/**
	 * Monotonic clock for record timestamps: several decisions are routinely
	 * recorded inside the same millisecond, and `Date.now()` would tie them,
	 * leaving "newest first" to array order. Strictly increasing values keep
	 * recall ordering faithful.
	 */
	private lastTs = 0;

	constructor(sessionsDir: string) {
		this.sessionsDir = sessionsDir;
		fs.mkdirSync(sessionsDir, { recursive: true });
	}

	private nextTs(): number {
		const now = epochSecondsFloat();
		this.lastTs = now > this.lastTs ? now : this.lastTs + 0.001;
		return this.lastTs;
	}

	get dir(): string {
		return this.sessionsDir;
	}

	startSession(projectName: string): string {
		const sessionId = newSessionId();
		this.active.set(sessionId, {
			id: sessionId,
			project: projectName,
			startedAt: epochSecondsFloat(),
			decisions: [],
			codeAreas: [],
			questions: [],
			touchedFiles: {},
		});
		return sessionId;
	}

	recordDecision(sessionId: string, decision: string, reason: string): void {
		const session = this.active.get(sessionId);
		if (!session) return;
		session.decisions.push({ decision, reason, timestamp: this.nextTs() });
	}

	recordCodeArea(sessionId: string, filePath: string, description: string): void {
		const session = this.active.get(sessionId);
		if (!session) return;
		session.codeAreas.push({ filePath, description, timestamp: this.nextTs() });
	}

	touchFiles(sessionId: string, filePaths: Iterable<string>): void {
		const session = this.active.get(sessionId);
		if (!session) return;
		for (const fp of filePaths) {
			if (!fp || fp.startsWith("git:")) continue;
			session.touchedFiles[fp] = (session.touchedFiles[fp] ?? 0) + 1;
		}
	}

	getSnapshot(sessionId: string): SessionSnapshot | null {
		const session = this.active.get(sessionId);
		return session ? { ...session } : null;
	}

	/** Flush the in-memory session to `sessions/<id>.json`. */
	persist(sessionId: string): void {
		const session = this.active.get(sessionId);
		if (!session) return;
		atomicWriteText(path.join(this.sessionsDir, `${sessionId}.json`), JSON.stringify(session, null, 2));
	}

	endSession(sessionId: string): void {
		const session = this.active.get(sessionId);
		if (!session) return;
		session.endedAt = epochSeconds();
		this.persist(sessionId);
		this.active.delete(sessionId);
	}

	loadRecentSessions(limit = 5): SessionSnapshot[] {
		let files: string[];
		try {
			files = fs
				.readdirSync(this.sessionsDir)
				.filter((f) => f.endsWith(".json") && f !== DECISIONS_LOG_NAME)
				.map((f) => path.join(this.sessionsDir, f));
		} catch {
			return [];
		}
		files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		const out: SessionSnapshot[] = [];
		for (const file of files.slice(0, limit)) {
			try {
				out.push(JSON.parse(fs.readFileSync(file, "utf-8")) as SessionSnapshot);
			} catch {
				// skip corrupt session files
			}
		}
		return out;
	}

	/** Consolidate old session JSONs into decisions_log.json and delete them. */
	pruneOldSessions(threshold = PRUNE_THRESHOLD, keep = PRUNE_KEEP): {
		pruned: number;
		kept: number;
		decisionsAppended: number;
	} {
		let files: { file: string; mtime: number }[];
		try {
			files = fs
				.readdirSync(this.sessionsDir)
				.filter((f) => f.endsWith(".json") && f !== DECISIONS_LOG_NAME)
				.map((f) => ({ file: path.join(this.sessionsDir, f), mtime: fs.statSync(path.join(this.sessionsDir, f)).mtimeMs }));
		} catch {
			return { pruned: 0, kept: 0, decisionsAppended: 0 };
		}
		files.sort((a, b) => b.mtime - a.mtime);
		if (files.length <= threshold) return { pruned: 0, kept: files.length, decisionsAppended: 0 };

		const keepFiles = files.slice(0, keep);
		const oldFiles = files.slice(keep);
		const logPath = path.join(this.sessionsDir, DECISIONS_LOG_NAME);

		let existing: unknown[] = [];
		if (fs.existsSync(logPath)) {
			try {
				const parsed = JSON.parse(fs.readFileSync(logPath, "utf-8"));
				if (Array.isArray(parsed)) existing = parsed;
			} catch {
				existing = [];
			}
		}

		let appended = 0;
		for (const { file } of oldFiles) {
			try {
				const data = JSON.parse(fs.readFileSync(file, "utf-8")) as SessionSnapshot;
				for (const d of data.decisions ?? []) {
					existing.push({
						decision: d.decision ?? "",
						reason: d.reason ?? "",
						timestamp: d.timestamp ?? 0,
						sessionId: data.id ?? "",
					});
					appended++;
				}
			} catch {
				continue;
			}
		}

		try {
			atomicWriteText(logPath, JSON.stringify(existing, null, 2));
		} catch {
			return { pruned: 0, kept: files.length, decisionsAppended: 0 };
		}

		let deleted = 0;
		for (const { file } of oldFiles) {
			try {
				fs.unlinkSync(file);
				deleted++;
			} catch {
				// best effort
			}
		}
		return { pruned: deleted, kept: keepFiles.length, decisionsAppended: appended };
	}

	loadConsolidatedDecisions(): { decision: string; reason: string; timestamp: number }[] {
		const logPath = path.join(this.sessionsDir, DECISIONS_LOG_NAME);
		if (!fs.existsSync(logPath)) return [];
		try {
			const data = JSON.parse(fs.readFileSync(logPath, "utf-8"));
			return Array.isArray(data) ? data : [];
		} catch {
			return [];
		}
	}

	/** Most-recent decision strings across active + recent sessions + archive. */
	getRecentDecisions(limit = 10, sessionLimit = 50): string[] {
		const entries: { ts: number; text: string }[] = [];
		for (const session of this.active.values()) {
			for (const d of session.decisions) {
				entries.push({ ts: d.timestamp, text: `[decision] ${d.decision} — ${d.reason}` });
			}
		}
		for (const session of this.loadRecentSessions(sessionLimit)) {
			for (const d of session.decisions ?? []) {
				entries.push({ ts: d.timestamp ?? 0, text: `[decision] ${d.decision} — ${d.reason}` });
			}
		}
		for (const d of this.loadConsolidatedDecisions()) {
			entries.push({ ts: d.timestamp ?? 0, text: `[decision] ${d.decision} — ${d.reason}` });
		}
		entries.sort((a, b) => b.ts - a.ts);
		const seen = new Set<string>();
		const ordered: string[] = [];
		for (const { text } of entries) {
			if (seen.has(text)) continue;
			seen.add(text);
			ordered.push(text);
			if (ordered.length >= limit) break;
		}
		return ordered;
	}
}
