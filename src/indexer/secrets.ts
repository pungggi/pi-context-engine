/**
 * Secret detection at index time — port of upstream `indexer/secrets.py` (MIT).
 *
 * Two layers:
 *  1. Filename-based skipping — credential-looking files are never read.
 *  2. Content-based redaction — credential-shaped lines are replaced with
 *     `[REDACTED:<reason>]` before chunking/embedding.
 *
 * Conservative on purpose: false positives are recoverable, false negatives
 * leak secrets into the vector DB.
 */
import path from "node:path";

// ── Filename-level skip list ────────────────────────────────────────────────

const SECRET_FILENAMES = new Set([
	".npmrc", ".pypirc", ".netrc",
	"credentials.json", "credentials.yaml", "credentials.yml",
	"secrets.json", "secrets.yaml", "secrets.yml",
	"service-account.json", "gcp-key.json",
	"kube-config", "kubeconfig",
	"auth.json",
	".git-credentials",
	"id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_xmss",
]);

const SECRET_PREFIXES = [".env"];
const SECRET_SUFFIXES = [".env"];
const SECRET_EXTENSIONS = new Set([
	".pem", ".key", ".crt", ".cer", ".der",
	".p12", ".pfx",
	".jks", ".keystore",
	".pgp", ".asc", ".gpg",
	".kdbx",
	".ppk",
]);

export function isSecretFile(filePath: string): boolean {
	const name = path.basename(filePath).toLowerCase();
	if (SECRET_FILENAMES.has(name)) return true;
	const ext = path.extname(name);
	if (SECRET_EXTENSIONS.has(ext)) return true;
	for (const prefix of SECRET_PREFIXES) if (name.startsWith(prefix)) return true;
	for (const suffix of SECRET_SUFFIXES) if (name.endsWith(suffix)) return true;
	return false;
}

// ── Content-level redaction ─────────────────────────────────────────────────

interface ContentPattern {
	regex: RegExp;
	label: string;
	/**
	 * Apply the placeholder heuristic ("your-api-key", "example", …) before
	 * redacting. Only the generic patterns need it: a structurally valid AWS
	 * or GitHub key is unambiguous, and filtering those would let a real key
	 * whose value happens to contain "example"/"sample" escape redaction.
	 */
	filterPlaceholders?: boolean;
}

const CONTENT_PATTERNS: ContentPattern[] = [
	{ regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, label: "AWS_ACCESS_KEY" },
	{ regex: /(?i:aws_secret_access_key\s*[:=]\s*['"]?([A-Za-z0-9/+=]{40})['"]?)/, label: "AWS_SECRET_KEY" },
	{ regex: /\bghp_[A-Za-z0-9]{36}\b/, label: "GITHUB_PAT" },
	{ regex: /\bgithub_pat_[A-Za-z0-9_]{82}\b/, label: "GITHUB_FINE_GRAINED_PAT" },
	// Prefix groups must be NON-capturing: `_sub` treats a capture group as
	// the credential value, which would redact just the prefix and leak the token.
	{ regex: /\b(?:ghs|gho|ghu|ghr)_[A-Za-z0-9]{36}\b/, label: "GITHUB_OAUTH" },
	{ regex: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, label: "SLACK_TOKEN" },
	{ regex: /\b(?:sk|rk)_live_[A-Za-z0-9]{24,}\b/, label: "STRIPE_LIVE_KEY" },
	{ regex: /\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/, label: "OPENAI_KEY" },
	{ regex: /\bsk-ant-(?:api03|admin01)-[A-Za-z0-9_\-]{93,}\b/, label: "ANTHROPIC_KEY" },
	{ regex: /\bAIza[0-9A-Za-z_\-]{35}\b/, label: "GOOGLE_API_KEY" },
	{ regex: /\beyJ[A-Za-z0-9_\-]+\.eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\b/, label: "JWT" },
	{ regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/, label: "PRIVATE_KEY_BLOCK" },
	{
		regex: /(?i:\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key|auth[_-]?token|client[_-]?secret)\b['"\]\s]*[:=]\s*['"]([^'"\s]{16,})['"])/,
		label: "GENERIC_CREDENTIAL",
		filterPlaceholders: true,
	},
	{
		regex: /(?im:^[ \t]*(?:export[ \t]+)?[A-Za-z0-9_.\-]*(?:password|passwd|secret|token|credential|api[_-]?key|key)s?[ \t]*[:=][ \t]*([^\s'\"#`]{16,}))/,
		label: "GENERIC_CREDENTIAL",
		filterPlaceholders: true,
	},
];

const PLACEHOLDER_VALUES = new Set([
	"your-api-key", "your_api_key", "your-key-here", "your_key_here",
	"<your-key>", "<api-key>", "<your_key>", "<api_key>",
	"xxxxxxxxxxxxxxxx", "0000000000000000",
	"changeme", "change-me", "change_me",
	"placeholder", "example", "sample",
]);

const PLACEHOLDER_SUBSTRINGS = [
	"placeholder", "example", "fake", "dummy", "sample",
	"changeme", "change-me", "change_me", "not_real",
	"not-real", "redacted", "<your", "<api",
	"your_key", "your-key", "your_secret", "your-secret",
	"your_token", "your-token", "your_api", "your-api",
	"your_password", "your-password",
	"replace_with", "replace-with", "insert_your", "insert-your",
];

function isPlaceholder(value: string): boolean {
	const lower = value.replace(/^['"<>]+|['"<>]+$/g, "").toLowerCase();
	if (PLACEHOLDER_VALUES.has(lower)) return true;
	if (lower.startsWith("[redacted:")) return true;
	if (new Set(lower).size <= 2) return true;
	for (const needle of PLACEHOLDER_SUBSTRINGS) {
		if (lower.includes(needle)) return true;
	}
	for (const prefix of ["your-", "your_", "my-", "my_"]) {
		if (lower.startsWith(prefix)) return true;
	}
	return false;
}

export interface RedactResult {
	text: string;
	labels: string[];
}

/**
 * Replace credential-shaped substrings with `[REDACTED:LABEL]`.
 * Returns the redacted text plus the labels that fired (never the values).
 */
export function redactSecrets(text: string, extraPatterns: ContentPattern[] = []): RedactResult {
	if (!text) return { text, labels: [] };
	let out = text;
	const labels: string[] = [];
	for (const { regex, label, filterPlaceholders } of [...CONTENT_PATTERNS, ...extraPatterns]) {
		out = out.replace(regex, (...args: unknown[]) => {
			const match = args[0] as string;
			const groups = args.slice(1, -2) as string[];
			const lastGroup = groups.length > 0 ? groups[groups.length - 1] : undefined;
			if (lastGroup !== undefined) {
				if (filterPlaceholders && isPlaceholder(lastGroup)) return match;
				labels.push(label);
				return match.replace(lastGroup, `[REDACTED:${label}]`);
			}
			if (filterPlaceholders && isPlaceholder(match)) return match;
			labels.push(label);
			return `[REDACTED:${label}]`;
		});
	}
	return { text: out, labels };
}

// ── PII patterns ────────────────────────────────────────────────────────────

const PII_PATTERNS: ContentPattern[] = [
	{ regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/, label: "EMAIL" },
	{
		regex: /\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b|10\.0\.0\.1\b|192\.168\.\d+\.\d+\b)(?:[1-9]\d?|1\d{2}|2[0-4]\d|25[0-5])(?:\.(?:\d{1,3})){3}\b/,
		label: "IPV4",
	},
	{ regex: /\b(?:\d[ -]?){13,19}\b/, label: "CREDIT_CARD" },
	{ regex: /\b\d{3}-\d{2}-\d{4}\b/, label: "SSN" },
	{ regex: /\+\d{1,3}[ -]?\(?\d{1,4}\)?[ -]?\d{3,4}[ -]?\d{3,4}\b/, label: "PHONE_E164" },
];

function passesLuhn(digits: string): boolean {
	const clean = digits.replace(/\D/g, "");
	if (clean.length < 13 || clean.length > 19) return false;
	let total = 0;
	const parity = clean.length % 2;
	for (let i = 0; i < clean.length; i++) {
		let n = Number(clean[i]);
		if (i % 2 === parity) {
			n *= 2;
			if (n > 9) n -= 9;
		}
		total += n;
	}
	return total % 10 === 0;
}

/** Lighter-touch scrub for memory writes: emails, IPs, cards (Luhn-checked), SSNs, phones. */
export function redactPii(text: string, extraPatterns: ContentPattern[] = []): RedactResult {
	if (!text) return { text, labels: [] };
	let out = text;
	const labels: string[] = [];
	for (const { regex, label } of [...PII_PATTERNS, ...extraPatterns]) {
		out = out.replace(regex, (match: string) => {
			if (label === "CREDIT_CARD" && !passesLuhn(match)) return match;
			labels.push(label);
			return `[REDACTED:${label}]`;
		});
	}
	return { text: out, labels };
}
