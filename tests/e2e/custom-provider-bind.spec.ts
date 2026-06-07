/**
 * E2E (in-process) tests for binding custom-provider models to the agent.
 *
 * Verifies the lifecycle wiring added in server.ts:
 *   - POST /api/custom-providers writes a managed provider block into the
 *     agent's models.json (so pi-coding-agent's strict `set_model` lookup can
 *     resolve the model instead of silently keeping the prior one).
 *   - The same (provider, id) pairs surface in GET /api/models, and vision
 *     models round-trip `input:["text","image"]`.
 *   - DELETE /api/custom-providers/:id removes ONLY the managed block and
 *     preserves unmanaged entries (aigw / bedrock modelOverrides).
 *   - Renaming a provider (same id, new name) prunes the stale old-name block.
 *
 * Manual `openai-completions` providers map their configured models
 * synchronously — no network, deterministic.
 */

import { test, expect } from "./in-process-harness.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { apiFetch, bobbitDir } from "./e2e-setup.js";

function modelsJsonPath(): string {
	return join(bobbitDir(), "agent", "models.json");
}

function readModelsJson(): any {
	const p = modelsJsonPath();
	if (!existsSync(p)) return { providers: {} };
	return JSON.parse(readFileSync(p, "utf-8"));
}

function writeModelsJson(data: any): void {
	writeFileSync(modelsJsonPath(), JSON.stringify(data, null, 2));
}

const PROVIDER_ID = "e2e-llamaswap";
const PROVIDER_NAME = "E2E llama-swap";

function providerBody(overrides: Record<string, unknown> = {}) {
	return {
		id: PROVIDER_ID,
		name: PROVIDER_NAME,
		type: "openai-completions",
		baseUrl: "http://e2e-host.invalid:9292",
		models: [
			{ id: "qwen-coder-medium", name: "Qwen3-Coder", contextWindow: 262144, reasoning: false, input: ["text"] },
			{ id: "gemma-vision", name: "Gemma Vision", contextWindow: 131072, reasoning: false, input: ["text", "image"] },
		],
		...overrides,
	};
}

test.afterEach(async () => {
	// Best-effort cleanup so specs don't leak the provider into shared state.
	await apiFetch(`/api/custom-providers/${PROVIDER_ID}`, { method: "DELETE" }).catch(() => {});
});

test.describe("Custom provider → agent models.json binding", () => {
	test("POST writes a managed provider block with correct shape", async () => {
		const res = await apiFetch("/api/custom-providers", {
			method: "POST",
			body: JSON.stringify(providerBody()),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.ok).toBe(true);

		const json = readModelsJson();
		const entry = json.providers[PROVIDER_NAME];
		expect(entry, "managed provider entry keyed by name must exist").toBeTruthy();
		expect(entry.baseUrl).toBe("http://e2e-host.invalid:9292/v1");
		expect(entry.apiKey).toBe("none");
		expect(entry.api).toBe("openai-completions");
		expect(entry.__bobbitManaged).toBe("custom-provider");
		expect(entry.models).toHaveLength(2);

		const coder = entry.models.find((m: any) => m.id === "qwen-coder-medium");
		expect(coder.contextWindow).toBe(262144);
		expect(coder.compat?.maxTokensField).toBe("max_tokens");

		const vision = entry.models.find((m: any) => m.id === "gemma-vision");
		expect(vision.input).toEqual(["text", "image"]);
	});

	test("the synced models round-trip to GET /api/models", async () => {
		await apiFetch("/api/custom-providers", {
			method: "POST",
			body: JSON.stringify(providerBody()),
		});

		const res = await apiFetch("/api/models");
		expect(res.status).toBe(200);
		const models = await res.json();

		const mine = models.filter((m: any) => m.provider === PROVIDER_NAME);
		expect(mine.length).toBe(2);

		const ids = mine.map((m: any) => m.id).sort();
		expect(ids).toEqual(["gemma-vision", "qwen-coder-medium"]);

		// The provider key (== set_model provider string) used in /api/models must
		// match the key written to models.json, otherwise the agent lookup fails.
		const json = readModelsJson();
		expect(json.providers[PROVIDER_NAME]).toBeTruthy();

		// Vision capability round-trips so the picker shows it AND the agent
		// forwards image parts for it.
		const vision = mine.find((m: any) => m.id === "gemma-vision");
		expect(vision.input).toContain("image");
	});

	test("DELETE removes only the managed block, preserving unmanaged entries", async () => {
		await apiFetch("/api/custom-providers", {
			method: "POST",
			body: JSON.stringify(providerBody()),
		});
		expect(readModelsJson().providers[PROVIDER_NAME]).toBeTruthy();

		// Inject an unmanaged sentinel (mimics aigw / bedrock modelOverrides).
		const seeded = readModelsJson();
		seeded.providers.__sentinel_aigw = {
			baseUrl: "http://127.0.0.1:1111",
			apiKey: "none",
			api: "openai-completions",
			models: [{ id: "sentinel-model", name: "Sentinel" }],
		};
		writeModelsJson(seeded);

		const del = await apiFetch(`/api/custom-providers/${PROVIDER_ID}`, { method: "DELETE" });
		expect(del.status).toBe(200);

		const json = readModelsJson();
		expect(json.providers[PROVIDER_NAME], "managed entry removed").toBeFalsy();
		expect(json.providers.__sentinel_aigw, "unmanaged sentinel preserved").toBeTruthy();
		expect(json.providers.__sentinel_aigw.models[0].id).toBe("sentinel-model");
	});

	test("renaming a provider prunes the stale old-name block", async () => {
		await apiFetch("/api/custom-providers", {
			method: "POST",
			body: JSON.stringify(providerBody()),
		});
		expect(readModelsJson().providers[PROVIDER_NAME]).toBeTruthy();

		const newName = "E2E llama-swap (renamed)";
		const res = await apiFetch("/api/custom-providers", {
			method: "POST",
			body: JSON.stringify(providerBody({ name: newName })),
		});
		expect(res.status).toBe(200);

		const json = readModelsJson();
		expect(json.providers[newName], "renamed entry present").toBeTruthy();
		expect(json.providers[PROVIDER_NAME], "stale old-name entry pruned").toBeFalsy();
	});
});
