/**
 * System-prompt guidance for the package's own tools.
 *
 * Why this ships with the package: retrieval quality depends on how the query
 * is written, and the tool's `promptSnippet`/`promptGuidelines` only say "use
 * this instead of grep/read". Everything specific to *this* package's
 * semantics (confidence scores, overflow references, `/context-index`, the
 * empty-index background build) has to travel with the package, or it drifts
 * the moment a tool parameter changes.
 *
 * Injection is gated on three conditions so the ~900-token block never lands
 * where it does not pay for itself:
 *  1. `context_search` must be in the run's selected tools
 *  2. `guidance.enabled` must be true in config (default true)
 *  3. only runs that start from a user prompt get the bootstrap message;
 *     guidance itself applies to every run while the tool is active
 *
 * Registered through `systemPromptOptions.sections` rather than a forced
 * `systemPrompt`: pi replays and diffs structured sections like any other, so
 * the transcript stays stable instead of freezing a whole-prompt override.
 */

export const CONTEXT_SEARCH_SECTION_KEY = "context_search_guidelines";

/** Minimal shape of the mutable prompt options this module touches. */
export interface GuidanceTarget {
	selectedTools: string[];
	sections: Record<string, string>;
}

export const CONTEXT_SEARCH_GUIDELINES = `You have context_search, a semantic code search over this project's index (tree-sitter chunks, hybrid vector + BM25, confidence-scored). Use it well.

### When to search vs. when not to

SEARCH when:
- Starting a new task and you need to understand the relevant code area
- You need to find where a concept, pattern, or feature is implemented
- Before editing code you haven't recently read
- You need cross-file relationships (callers, imports, dependents)

SKIP the search when:
- You already have the file contents in context from a recent read
- You were given an exact file path and line numbers
- You need a simple exact-string match (use bash with grep/rg instead)
- You are editing a file you just read in the current turn

### Writing effective queries

GOOD queries - specific, scoped, with concrete symbols or behaviour:
- "How does the AuthenticationMiddleware validate JWT tokens? Show the verify method and its error handling"
- "Where is the UserService.createUser method defined? Show the full implementation and parameters"
- "Find all HTTP route handlers that accept file uploads"
- "How does the EventBus dispatch events to subscribers?"

POOR queries - vague, broad, or just a symbol dump:
- "Show me the codebase"
- "Authentication"
- "Find UserService"

RULES:
1. Describe WHAT you want in natural language - the index is semantic, prose works better than keywords
2. Include CONTEXT: what it is for (implementation? debugging? refactoring?)
3. Ask for the LEVEL OF DETAIL: "full method", "the interface and its implementors", "the call chain"
4. Combine related lookups into ONE query instead of several calls

### Reading the results

- Each hit is a compressed chunk: \`[path:start] (confidence: 0.xx)\` followed by the code
- A "\`expand_chunk\`" reference list means results were cut by the token budget - expand only the ones you actually need, never every entry
- Confidence below ~0.5 usually means the index has nothing better; rephrase rather than trusting a weak hit
- Results come from the index, not the live file: before editing, open the file with \`read\` to see its current state
- A \`[query confidence: low|medium - ...]\` line at the end means the RETRIEVER itself judged the query weak (top score, retrieval-path agreement, file margin). Act on its hints instead of re-reading files: name a file or symbol, or drop vague terms. \`high\` confidence is reported by silence, not a line

### Before editing code

Search once with a query covering ALL of:
- The function/method/class you are modifying (full implementation)
- Its types and constants
- Callers that could break

Example: "I need to add a retry parameter to HttpClient.request. Show the HttpClient class with the request method, HttpClientConfig, every caller of request(), and error types it throws."

### Iterative search

If the first search misses:
1. REPHRASE - the codebase may use different names than you expect
2. BROADEN - add surroundings ("and the module that defines it")
3. NARROW - add specifics ("the async version returning a Promise")
4. Change ANGLE - search for tests, the type definition, or a usage example

### Combining with other tools

- \`related_context\` - walk import/defines edges from a hit to reach neighbouring code
- \`read\` - full current file contents when you are about to edit (search returns excerpts)
- \`bash\` with grep/rg - exact strings (TODO markers, error messages, literal identifiers)
- \`bash\` with git - history: \`git log -p -- path/to/file\`

### Index lifecycle

- If a search says the index is empty, a background index is already running - retry shortly, or run \`/context-index\` for a synchronous build
- After large refactors, \`reindex\` (or \`/context-index\`) keeps results current; \`index_status\` reports freshness and measured token savings
- Incremental re-index only re-reads changed files, so it is cheap
`;

/**
 * Apply the guidance section to mutable prompt options.
 * No-op (and safe to call on every run) when the tool is inactive or the
 * user turned guidance off. Returns whether it injected, for tests.
 */
export function applyContextSearchGuidance(options: GuidanceTarget, enabled: boolean): boolean {
	if (!enabled) return false;
	if (!options.selectedTools.includes("context_search")) return false;
	options.sections[CONTEXT_SEARCH_SECTION_KEY] = CONTEXT_SEARCH_GUIDELINES;
	return true;
}
