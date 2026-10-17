import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loadIgnorePatterns, matchesAny } from "../src/indexer/ignorefile.js";
import { Manifest } from "../src/indexer/manifest.js";
import { makeTempDir, rmrf } from "./helpers.js";

describe("ignorefile", () => {
	it("reads patterns and skips blanks and comments", () => {
		const dir = makeTempDir();
		try {
			fs.writeFileSync(path.join(dir, ".cceignore"), "# comment\n\nvendor/\n*.snap\n", "utf-8");
			expect(loadIgnorePatterns(dir)).toEqual(["vendor/", "*.snap"]);
		} finally {
			rmrf(dir);
		}
	});

	it("returns [] when the file is absent", () => {
		const dir = makeTempDir();
		try {
			expect(loadIgnorePatterns(dir)).toEqual([]);
		} finally {
			rmrf(dir);
		}
	});

	it("matches basenames for slashless patterns and paths for slashed ones", () => {
		expect(matchesAny("src/foo.snap", false, ["*.snap"])).toBe(true);
		expect(matchesAny("src/gen/out.js", false, ["src/gen/*"])).toBe(true);
		expect(matchesAny("a/b/build/x.js", false, ["**/build/x.js"])).toBe(true);
	});

	it("only matches directories for trailing-slash patterns", () => {
		expect(matchesAny("vendor", true, ["vendor/"])).toBe(true);
		expect(matchesAny("vendor", false, ["vendor/"])).toBe(false);
	});
});

describe("Manifest", () => {
	it("round-trips entries, git sha and embedding dim", () => {
		const dir = makeTempDir();
		try {
			const file = path.join(dir, "manifest.json");
			const manifest = new Manifest(file);
			manifest.update("src/a.py", "hash-a");
			manifest.lastGitSha = "abc123";
			manifest.embeddingDim = 384;
			manifest.save();

			const reloaded = new Manifest(file);
			expect(reloaded.getHash("src/a.py")).toBe("hash-a");
			expect(reloaded.lastGitSha).toBe("abc123");
			expect(reloaded.embeddingDim).toBe(384);
			expect(reloaded.hasChanged("src/a.py", "hash-a")).toBe(false);
			expect(reloaded.hasChanged("src/a.py", "other")).toBe(true);
		} finally {
			rmrf(dir);
		}
	});

	it("starts empty on a corrupt file instead of throwing", () => {
		const dir = makeTempDir();
		try {
			const file = path.join(dir, "manifest.json");
			fs.writeFileSync(file, "{not json", "utf-8");
			const manifest = new Manifest(file);
			expect(manifest.getHash("anything")).toBeUndefined();
		} finally {
			rmrf(dir);
		}
	});

	it("clearEntries forgets every hash so a full reindex is forced", () => {
		const dir = makeTempDir();
		try {
			const manifest = new Manifest(path.join(dir, "manifest.json"));
			manifest.update("a.py", "h");
			manifest.clearEntries();
			expect(manifest.hasEntries).toBe(false);
			expect(manifest.hasChanged("a.py", "h")).toBe(true);
		} finally {
			rmrf(dir);
		}
	});
});
