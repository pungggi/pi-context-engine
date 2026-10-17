import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
		pool: "forks",
		poolOptions: {
			forks: {
				// better-sqlite3 is native; single fork avoids loading the
				// binding concurrently in many workers on slow disks.
				maxForks: 4,
				minForks: 1,
			},
		},
	},
});
