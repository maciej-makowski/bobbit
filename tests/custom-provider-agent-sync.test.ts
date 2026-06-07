/**
 * Unit tests for syncing custom providers into the interactive agent's
 * models.json (no network — manual `openai-completions` providers map their
 * configured models synchronously).
 *
 * Contract (per design doc "Bind custom-provider models to the interactive agent"):
 *   1. `syncCustomProviderToModelsJson` writes a `providers[<name||id>]` block
 *      shaped `{ baseUrl: ".../v1", apiKey: "none", api: "openai-completions",
 *      __bobbitManaged: "custom-provider", models: [...] }` where each model
 *      carries `{id,name,contextWindow,maxTokens,reasoning,input,cost}` and a
 *      vision model keeps `input:["text","image"]`. openai-completions models
 *      get conservative `compat` flags.
 *   2. Existing `aigw` + `amazon-bedrock.modelOverrides` entries are preserved.
 *   3. `removeCustomProviderFromModelsJson` deletes ONLY the managed block and
 *      leaves aigw/bedrock intact; it never touches unmarked entries.
 *   4. `pruneStaleCustomProviders` drops managed entries whose key is no longer
 *      in the config set (rename / delete), without clobbering aigw/bedrock.
 *   5. `buildCustomProviderEntry` derives `api` from the provider type.
 */
import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

let tmp: string;
let stateDir: string;
let previousAgentDir: string | undefined;

before(() => {
	tmp = mkdtempSync(path.join(tmpdir(), "bobbit-cp-sync-"));
	stateDir = path.join(tmp, "state");
	mkdirSync(stateDir, { recursive: true });
	previousAgentDir = process.env.BOBBIT_AGENT_DIR;
	process.env.BOBBIT_AGENT_DIR = tmp;
});

after(() => {
	if (previousAgentDir === undefined) delete process.env.BOBBIT_AGENT_DIR;
	else process.env.BOBBIT_AGENT_DIR = previousAgentDir;
	rmSync(tmp, { recursive: true, force: true });
});

const modelsPath = () => path.join(tmp, "models.json");

/** Pre-seed models.json with aigw + bedrock entries that must survive every mutation. */
function seedModelsJson(): void {
	const seed = {
		providers: {
			aigw: {
				baseUrl: "http://127.0.0.1:1111",
				apiKey: "none",
				api: "openai-completions",
				models: [{ id: "gpt-x", name: "GPT X" }],
			},
			"amazon-bedrock": {
				modelOverrides: { "us.anthropic.claude-sonnet-4-6": { contextWindow: 1_000_000 } },
			},
		},
	};
	writeFileSync(modelsPath(), JSON.stringify(seed, null, 2));
}

beforeEach(() => {
	if (existsSync(modelsPath())) rmSync(modelsPath());
	const prefsFile = path.join(stateDir, "preferences.json");
	if (existsSync(prefsFile)) rmSync(prefsFile);
});

const {
	syncCustomProviderToModelsJson,
	removeCustomProviderFromModelsJson,
	pruneStaleCustomProviders,
	buildCustomProviderEntry,
	apiForType,
	providerKeyFor,
	MANAGED_MARKER,
} = await import("../src/server/agent/custom-provider-agent-sync.js");
const { PreferencesStore } = await import("../src/server/agent/preferences-store.js");

function readModels(): any {
	return JSON.parse(readFileSync(modelsPath(), "utf-8"));
}

const MANUAL_PROVIDER = {
	id: "llama-swap-z13",
	name: "llama-swap (z13)",
	type: "openai-completions" as const,
	baseUrl: "http://maciekm-z13.local:9292",
	models: [
		{ id: "qwen-coder-medium", name: "Qwen3-Coder 30B MoE", contextWindow: 262144, reasoning: false, input: ["text"] as ("text" | "image")[] },
		{ id: "gpt-plan", name: "GPT-OSS 20B MoE", contextWindow: 131072, reasoning: true, input: ["text"] as ("text" | "image")[] },
		{ id: "gemma-vision-large", name: "Gemma4 26B MoE", contextWindow: 262144, reasoning: false, input: ["text", "image"] as ("text" | "image")[] },
	],
};

describe("custom-provider → agent models.json sync", () => {
	it("syncs a manual openai-completions provider with correct shape, preserving aigw + bedrock", async () => {
		seedModelsJson();
		await syncCustomProviderToModelsJson(MANUAL_PROVIDER);

		const data = readModels();
		const key = "llama-swap (z13)";
		const entry = data.providers[key];
		assert.ok(entry, "managed provider entry must exist under name key");
		assert.equal(entry.baseUrl, "http://maciekm-z13.local:9292/v1", "baseUrl must carry /v1");
		assert.equal(entry.apiKey, "none", "missing apiKey → 'none' sentinel");
		assert.equal(entry.api, "openai-completions");
		assert.equal(entry.__bobbitManaged, MANAGED_MARKER, "entry must be stamped with the managed marker");
		assert.equal(entry.models.length, 3, "all manual models surface");

		// Every model carries the full metadata set.
		for (const m of entry.models) {
			for (const field of ["id", "name", "contextWindow", "maxTokens", "reasoning", "input", "cost"]) {
				assert.ok(field in m, `model ${m.id} must carry ${field}`);
			}
			// openai-completions models get conservative compat flags.
			assert.ok(m.compat, "openai-completions model must carry compat");
			assert.equal(m.compat.maxTokensField, "max_tokens");
			assert.equal(m.compat.supportsStore, false);
		}

		const coder = entry.models.find((m: any) => m.id === "qwen-coder-medium");
		assert.equal(coder.contextWindow, 262144);
		assert.equal(coder.reasoning, false);
		assert.deepEqual(coder.input, ["text"]);

		const vision = entry.models.find((m: any) => m.id === "gemma-vision-large");
		assert.deepEqual(vision.input, ["text", "image"], "vision model keeps text+image input");

		// aigw + bedrock untouched.
		assert.ok(data.providers.aigw, "aigw entry preserved");
		assert.equal(data.providers.aigw.models[0].id, "gpt-x");
		assert.ok(data.providers["amazon-bedrock"]?.modelOverrides, "bedrock modelOverrides preserved");
		assert.equal(
			data.providers["amazon-bedrock"].modelOverrides["us.anthropic.claude-sonnet-4-6"].contextWindow,
			1_000_000,
		);
	});

	it("removeCustomProviderFromModelsJson deletes only the managed block", async () => {
		seedModelsJson();
		await syncCustomProviderToModelsJson(MANUAL_PROVIDER);
		assert.ok(readModels().providers["llama-swap (z13)"], "precondition: managed entry exists");

		removeCustomProviderFromModelsJson("llama-swap (z13)");

		const data = readModels();
		assert.equal(data.providers["llama-swap (z13)"], undefined, "managed entry removed");
		assert.ok(data.providers.aigw, "aigw still present");
		assert.ok(data.providers["amazon-bedrock"]?.modelOverrides, "bedrock still present");
	});

	it("removeCustomProviderFromModelsJson refuses to delete unmarked (e.g. aigw) entries", async () => {
		seedModelsJson();
		// aigw is not a managed custom-provider entry — removal by that key is a no-op.
		removeCustomProviderFromModelsJson("aigw");
		assert.ok(readModels().providers.aigw, "aigw must NOT be removable via the custom-provider path");
	});

	it("pruneStaleCustomProviders drops the old key after a rename", async () => {
		seedModelsJson();
		const prefs = new PreferencesStore(stateDir);

		// Initial: provider named "Provider A".
		const v1 = { id: "p1", name: "Provider A", type: "openai-completions" as const, baseUrl: "http://h", models: [{ id: "m", name: "M" }] };
		prefs.set("customProviders", [v1]);
		await syncCustomProviderToModelsJson(v1);
		assert.ok(readModels().providers["Provider A"], "Provider A entry written");

		// Rename to "Provider B" (same id). Sync new entry, then prune.
		const v2 = { ...v1, name: "Provider B" };
		prefs.set("customProviders", [v2]);
		await syncCustomProviderToModelsJson(v2);
		pruneStaleCustomProviders(prefs);

		const data = readModels();
		assert.ok(data.providers["Provider B"], "renamed entry present");
		assert.equal(data.providers["Provider A"], undefined, "stale old-name entry pruned");
		assert.ok(data.providers.aigw, "aigw untouched by prune");
		assert.ok(data.providers["amazon-bedrock"], "bedrock untouched by prune");
	});

	it("pruneStaleCustomProviders drops a fully-deleted provider", async () => {
		seedModelsJson();
		const prefs = new PreferencesStore(stateDir);
		const cfg = { id: "p1", name: "Gone Soon", type: "openai-completions" as const, baseUrl: "http://h", models: [{ id: "m", name: "M" }] };
		prefs.set("customProviders", [cfg]);
		await syncCustomProviderToModelsJson(cfg);
		assert.ok(readModels().providers["Gone Soon"]);

		// Provider removed from prefs entirely.
		prefs.set("customProviders", []);
		pruneStaleCustomProviders(prefs);

		const data = readModels();
		assert.equal(data.providers["Gone Soon"], undefined, "deleted provider pruned");
		assert.ok(data.providers.aigw);
		assert.ok(data.providers["amazon-bedrock"]);
	});

	it("uses config.id as the key when name is absent", async () => {
		seedModelsJson();
		const cfg = { id: "bare-id", name: "", type: "openai-completions" as const, baseUrl: "http://h", models: [{ id: "m", name: "M" }] };
		await syncCustomProviderToModelsJson(cfg as any);
		assert.ok(readModels().providers["bare-id"], "falls back to id when name is empty");
	});

	it("buildCustomProviderEntry derives api from provider type and respects apiKey", () => {
		const base = { id: "x", name: "X", baseUrl: "http://h" };
		assert.equal(buildCustomProviderEntry({ ...base, type: "openai-completions" } as any, []).api, "openai-completions");
		assert.equal(buildCustomProviderEntry({ ...base, type: "manual" } as any, []).api, "openai-completions");
		assert.equal(buildCustomProviderEntry({ ...base, type: "openai-responses" } as any, []).api, "openai-responses");
		assert.equal(buildCustomProviderEntry({ ...base, type: "anthropic-messages" } as any, []).api, "anthropic-messages");

		assert.equal(apiForType("vllm"), "openai-completions");
		assert.equal(apiForType("anthropic-messages"), "anthropic-messages");

		// apiKey is trimmed; blank → "none".
		const withKey = buildCustomProviderEntry({ ...base, type: "openai-completions", apiKey: "  sk-abc  " } as any, []);
		assert.equal(withKey.apiKey, "sk-abc");
		const blankKey = buildCustomProviderEntry({ ...base, type: "openai-completions", apiKey: "   " } as any, []);
		assert.equal(blankKey.apiKey, "none");

		// anthropic-messages models do NOT get the openai compat block.
		const anthropic = buildCustomProviderEntry(
			{ ...base, type: "anthropic-messages" } as any,
			[{ id: "m", name: "M", provider: "X", api: "anthropic-messages", baseUrl: "http://h/v1", contextWindow: 200000, maxTokens: 8192, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, authenticated: true }],
		);
		assert.equal(anthropic.models[0].compat, undefined, "anthropic-messages models omit openai compat");

		assert.equal(providerKeyFor({ ...base, type: "manual", name: "Nice Name" } as any), "Nice Name");
		assert.equal(providerKeyFor({ ...base, type: "manual", name: "" } as any), "x");
	});

	it("does not sync image-only provider types", async () => {
		seedModelsJson();
		const imageCfg = { id: "img", name: "Image Maker", type: "openai-images" as const, baseUrl: "http://h" };
		await syncCustomProviderToModelsJson(imageCfg as any);
		assert.equal(readModels().providers["Image Maker"], undefined, "image-only providers are not agent-bindable");
	});
});
