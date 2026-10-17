/**
 * `.cceignore` parser — port of upstream `indexer/ignorefile.py` (MIT).
 * Gitignore-style practical subset: globs, dir patterns (trailing slash),
 * comments. No negation, no anchored patterns.
 */
import fs from "node:fs";
import path from "node:path";

export const CCEIGNORE_FILENAME = ".cceignore";

export function loadIgnorePatterns(projectDir: string): string[] {
	const filePath = path.join(projectDir, CCEIGNORE_FILENAME);
	if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return [];
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf-8");
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const s = line.trim();
		if (!s || s.startsWith("#")) continue;
		out.push(s);
	}
	return out;
}

/** fnmatch-style matcher. `*` matches across separators (deliberate deviation). */
function fnmatchCase(name: string, pattern: string): boolean {
	// Escape regex specials except `*` and `?`; `*` → any run (incl. `/`), `?` → one char.
	const re = new RegExp(
		"^" +
			pattern
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, ".*")
				.replace(/\?/g, ".") +
			"$",
	);
	return re.test(name);
}

export function matchesAny(relPath: string, isDir: boolean, patterns: string[]): boolean {
	if (patterns.length === 0) return false;
	const rel = relPath.replace(/\\/g, "/").replace(/^\.?\//, "");
	const name = rel.includes("/") ? rel.slice(rel.lastIndexOf("/") + 1) : rel;
	for (let pat of patterns) {
		const isDirPat = pat.endsWith("/");
		if (isDirPat) {
			if (!isDir) continue;
			pat = pat.slice(0, -1);
		}
		if (!pat.includes("/")) {
			if (fnmatchCase(name, pat)) return true;
		} else {
			const anchored = pat.replace(/^\/+/, "");
			if (fnmatchCase(rel, anchored)) return true;
			if (anchored.startsWith("**/")) {
				const tail = anchored.slice(3);
				if (fnmatchCase(rel, tail)) return true;
				if (fnmatchCase(rel, `*/${tail}`)) return true;
			}
		}
	}
	return false;
}
