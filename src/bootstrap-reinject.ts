/**
 * Compaction recovery for the session bootstrap message.
 *
 * Why: `before_agent_start` fires on user prompts only. A mid-run compaction
 * (threshold or overflow recovery) resumes the turn through `agent_start`,
 * where it never fires, so the persisted "where you left off" bootstrap is
 * removed by compaction and would stay gone until the next prompt. The
 * reinjector re-asserts the block on each LLM request until a persisted copy
 * is back in the conversation; outside that armed window the handler is an
 * O(1) no-op. Pattern borrowed from XJTLUmedia/protect-context (MIT).
 *
 * Kept free of pi imports so it tests without the host runtime.
 */

/** `customType` of the bootstrap message injected by `before_agent_start`. */
export const BOOTSTRAP_CUSTOM_TYPE = "context-engine-bootstrap";

interface CustomLike {
	role?: unknown;
	customType?: unknown;
}

/** True when a persisted bootstrap custom message is already in the
 * conversation: kept by the compaction, or freshly injected by
 * `before_agent_start` this turn. Tolerates arbitrary host message shapes:
 * anything that is not a custom message with the bootstrap type is ignored. */
export function hasPersistedBootstrap(messages: ReadonlyArray<unknown>): boolean {
	return messages.some(
		(m) =>
			typeof m === "object" &&
			m !== null &&
			(m as CustomLike).role === "custom" &&
			(m as CustomLike).customType === BOOTSTRAP_CUSTOM_TYPE,
	);
}

/** One per-request custom message carrying the regenerated bootstrap text.
 * Per-request only: pi does not persist `context` results, which is what
 * keeps the armed window finite (the persisted copy lands via
 * `before_agent_start` on the next user prompt and disarms us). */
export function bootstrapReinjectMessage(content: string): {
	role: "custom";
	customType: string;
	content: string;
	display: boolean;
	timestamp: number;
} {
	return {
		role: "custom",
		customType: BOOTSTRAP_CUSTOM_TYPE,
		content,
		display: false,
		timestamp: Date.now(),
	};
}

export interface BootstrapReinjector {
	/** Re-assert the bootstrap from the next request (call on `session_compact`). */
	arm(): void;
	/** Drop any pending re-assertion (call on `session_start`). */
	reset(): void;
	/** Whether a re-assertion is pending. */
	readonly armed: boolean;
	/** Per-request hook body. While armed and no persisted bootstrap is in the
	 * conversation, returns a message list with the regenerated block appended.
	 * Seeing a persisted copy disarms. A failed build skips this request and
	 * stays armed: bootstrapText failures should be transient, and the retry
	 * cost is bounded by the armed window (best-effort, never throws; the
	 * optional onBuildFailure callback makes the first failure per window
	 * observable). Generic over the host message type so the appended literal
	 * (a structural CustomMessage) is checked once, where it is built. */
	handle<M>(cwd: string, messages: ReadonlyArray<M>): Promise<{ messages: M[] } | undefined>;
}

export interface BootstrapReinjectorOptions {
	/** Notified at most ONCE per armed window when a build fails, so a
	 * persistent failure (e.g. a corrupted index) is observable without
	 * per-request spam. The window opens on arm() and closes on disarm/reset;
	 * a failure in a later window notifies again. Never throws. */
	onBuildFailure?: (error: unknown) => void;
}

export function createBootstrapReinjector(
	build: (cwd: string) => Promise<string>,
	options?: BootstrapReinjectorOptions,
): BootstrapReinjector {
	let armed = false;
	let failureNotified = false;
	return {
		arm() {
			armed = true;
			failureNotified = false;
		},
		reset() {
			armed = false;
			failureNotified = false;
		},
		get armed() {
			return armed;
		},
		async handle<M>(cwd: string, messages: ReadonlyArray<M>) {
			if (!armed) return undefined;
			if (hasPersistedBootstrap(messages)) {
				armed = false;
				return undefined;
			}
			let content: string;
			try {
				content = await build(cwd);
			} catch (err) {
				// Once per armed window: the first failure is worth surfacing; the
				// rest are the same condition retrying quietly.
				if (!failureNotified) {
					failureNotified = true;
					try {
						options?.onBuildFailure?.(err);
					} catch {
						// observation must never break recovery
					}
				}
				return undefined; // stays armed; retry on the next request
			}
			// The literal is a structurally valid custom message; M is the host's
			// message union, which contains that shape.
			return { messages: [...messages, bootstrapReinjectMessage(content) as unknown as M] };
		},
	};
}
