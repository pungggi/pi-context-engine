/**
 * Digest gating for injected context blocks (issue #32.2).
 *
 * Why: protect-context sha1-gates its brief (`brief_mode: "changed"`), so
 * re-injecting identical text costs zero tokens. Our injections today are
 * already change-triggered — the bootstrap lands on the first prompt and
 * after compaction, guidance rides in `systemPromptOptions` where pi diffs
 * sections — so nothing currently pays for redundant injection. This module
 * exists so the NEXT per-turn injection (staleness notes, savings footers,
 * task anchors) is gated by content digest from day one instead of bolting
 * it on after tokens are already being burned.
 *
 * Semantics: `changed(key, content)` returns true only when the content for
 * `key` differs from the last content delivered under that key. The first
 * call for a key always returns true (deliver the initial copy). Digests are
 * keyed so one injection's change does not re-arm another's.
 *
 * Kept free of pi imports so it tests without the host runtime (same rule as
 * bootstrap-reinject.ts).
 */
import { createHash } from "node:crypto";

/** Short stable digest of an injected block (sha256, first 16 hex chars —
 * collision-free for human-scale text, cheap to compare inline). */
export function contentDigest(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export interface DigestGate {
	/** True when `content` differs from the last content delivered for `key`
	 * (and records it as delivered). First call for a key → true. */
	changed(key: string, content: string): boolean;
	/** Digest last delivered for `key`, or null when never delivered. */
	peek(key: string): string | null;
	/** Forget one key (or all keys) — re-arms the gate. */
	reset(key?: string): void;
}

export function createDigestGate(): DigestGate {
	const delivered = new Map<string, string>();
	return {
		changed(key: string, content: string): boolean {
			const digest = contentDigest(content);
			const previous = delivered.get(key);
			delivered.set(key, digest);
			return previous !== digest;
		},
		peek(key: string): string | null {
			return delivered.get(key) ?? null;
		},
		reset(key?: string): void {
			if (key === undefined) delivered.clear();
			else delivered.delete(key);
		},
	};
}
