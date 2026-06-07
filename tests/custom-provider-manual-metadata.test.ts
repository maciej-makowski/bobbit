/**
 * Unit tests for manual custom-provider model discovery with per-model metadata.
 *
 * No network: discoverModelsForConfig() maps config.models directly for manual
 * text-provider types. Pins:
 *  - The previously-unhandled `openai-completions` branch now surfaces models
 *    (regression: it used to fall through to `default: return []`).
 *  - Per-model metadata (contextWindow / reasoning / input) flows through.
 *  - Backward compat: {id,name}-only models fall back to 8192/4096/false/["text"].
 *  - api derivation per provider type, and baseUrl gets `/v1` appended.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { discoverModelsForConfig } = await import("../src/server/agent/model-registry.ts");

describe("manual custom-provider metadata", () => {
	it("openai-completions provider surfaces models with accurate metadata", async () => {
		const models = await discoverModelsForConfig({
			id: "llama-swap-z13",
			name: "llama-swap (z13)",
			type: "openai-completions",
			baseUrl: "http://maciekm-z13.local:9292",
			models: [
				{ id: "qwen-coder-medium", name: "Qwen3-Coder 30B MoE", contextWindow: 262144, reasoning: false, input: ["text"] },
				{ id: "gpt-plan", name: "GPT-OSS 20B MoE", contextWindow: 131072, reasoning: true, input: ["text"] },
				{ id: "gemma-vision-large", name: "Gemma4 26B MoE", contextWindow: 262144, reasoning: false, input: ["text", "image"] },
			],
		});

		// Regression: before the fix, openai-completions hit `default: return []`.
		assert.equal(models.length, 3, "all manual models should surface");

		const coder = models.find((m) => m.id === "qwen-coder-medium")!;
		assert.ok(coder, "qwen-coder-medium present");
		assert.equal(coder.name, "Qwen3-Coder 30B MoE");
		assert.equal(coder.contextWindow, 262144);
		assert.equal(coder.reasoning, false);
		assert.deepEqual(coder.input, ["text"]);
		assert.equal(coder.baseUrl, "http://maciekm-z13.local:9292/v1");
		assert.equal(coder.api, "openai-completions");
		assert.equal(coder.provider, "llama-swap (z13)");

		const gpt = models.find((m) => m.id === "gpt-plan")!;
		assert.equal(gpt.contextWindow, 131072);
		assert.equal(gpt.reasoning, true);

		const gemma = models.find((m) => m.id === "gemma-vision-large")!;
		assert.equal(gemma.contextWindow, 262144);
		assert.deepEqual(gemma.input, ["text", "image"]);
	});

	it("falls back to defaults for {id,name}-only models (backward compatible)", async () => {
		const models = await discoverModelsForConfig({
			id: "legacy",
			name: "legacy",
			type: "openai-completions",
			baseUrl: "http://localhost:9999",
			models: [{ id: "bare-model", name: "Bare Model" }],
		});
		assert.equal(models.length, 1);
		const m = models[0];
		assert.equal(m.contextWindow, 8192);
		assert.equal(m.maxTokens, 4096);
		assert.equal(m.reasoning, false);
		assert.deepEqual(m.input, ["text"]);
	});

	it("clamps invalid metadata to defaults and filters input whitelist", async () => {
		const models = await discoverModelsForConfig({
			id: "weird",
			name: "weird",
			type: "openai-completions",
			baseUrl: "http://localhost:9999",
			models: [
				// invalid contextWindow/maxTokens and bogus input entries
				{ id: "x", name: "X", contextWindow: -5 as any, maxTokens: 0 as any, input: ["audio", "image"] as any },
			],
		});
		const m = models[0];
		assert.equal(m.contextWindow, 8192, "negative ctx falls back");
		assert.equal(m.maxTokens, 4096, "zero maxTokens falls back");
		assert.deepEqual(m.input, ["image"], "non-text/image values filtered out");
	});

	it("derives api from provider type", async () => {
		const mk = (type: any) => discoverModelsForConfig({
			id: type, name: type, type, baseUrl: "http://h", models: [{ id: "m", name: "M" }],
		});
		assert.equal((await mk("openai-completions"))[0].api, "openai-completions");
		assert.equal((await mk("manual"))[0].api, "openai-completions");
		assert.equal((await mk("openai-responses"))[0].api, "openai-responses");
		assert.equal((await mk("anthropic-messages"))[0].api, "anthropic-messages");
	});
});
