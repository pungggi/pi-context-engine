import { describe, expect, it } from "vitest";
import { LocalBackend, type TransformersLoader } from "../src/indexer/embedder.js";

function moduleNotFoundError(target = "@huggingface/transformers"): Error {
	// Node raises ERR_MODULE_NOT_FOUND for ESM dynamic imports and
	// MODULE_NOT_FOUND for CJS require; older runtimes only set the message.
	return Object.assign(new Error(`Cannot find module '${target}'`), { code: "ERR_MODULE_NOT_FOUND" });
}

function fakeTransformers(dim = 3): TransformersLoader {
	return async () => ({
		pipeline: async () => async (inputs: string | string[]) => {
			const count = Array.isArray(inputs) ? inputs.length : 1;
			return { data: new Float32Array(count * dim), dims: [count, dim] };
		},
		env: {},
	});
}

describe("LocalBackend missing transformers module", () => {
	it("replaces the bare module error with an actionable message", async () => {
		const backend = new LocalBackend("test-model", async () => {
			throw moduleNotFoundError();
		});
		await expect(backend.init()).rejects.toThrow(/@huggingface\/transformers is not installed/);
		await expect(backend.init()).rejects.toThrow(/PCE_EMBED_BACKEND=ollama/);
	});

	it("allows a retry after the module becomes available", async () => {
		let installed = false;
		const backend = new LocalBackend("test-model", async () => {
			if (!installed) throw moduleNotFoundError();
			return fakeTransformers(4)();
		});

		await expect(backend.init()).rejects.toThrow(/not installed/);
		installed = true;
		await backend.init();
		expect(backend.dimension).toBe(4);
	});

	it("passes unrelated load errors through unchanged", async () => {
		const backend = new LocalBackend("test-model", async () => {
			throw new Error("boom");
		});
		await expect(backend.init()).rejects.toThrow(/^boom$/);
	});

	it("detects package-level not-found without a code property", async () => {
		const backend = new LocalBackend("test-model", async () => {
			throw new Error("Cannot find package 'onnxruntime-node'");
		});
		await expect(backend.init()).rejects.toThrow(/not installed/);
	});
});
