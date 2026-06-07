/**
 * Unit tests for syncCustomProvidersToAgent() — writes custom local providers
 * into ~/.bobbit/agent/models.json so the interactive agent can bind them via
 * set_model (mirrors the aigw pattern for ALL custom provider types).
 *
 * No network: only manual (`openai-completions` etc.) providers are used, whose
 * model lists are mapped synchronously by discoverModelsForConfig(). Uses a
 * temp BOBBIT_AGENT_DIR + temp state dir so the real models.json is untouched.
 *
 * Pins (per design "Bind custom-provider models"):
 *  - A manual openai-completions provider is written as a marked managed block
 *    (baseUrl `/v1`, apiKey "none", api openai-completions, full metadata + compat).
 *  - Non-managed entries (aigw, amazon-bedrock.modelOverrides) are preserved.
 *  - Deleting the provider removes only its block; others survive.
 *  - Renaming moves the provider key (old gone, new present).
 *  - An unreachable auto-discovery provider with a prior managed block keeps it.
 *  - Vision models round-trip input:["text","image"] into the synced block.
 *  - Image-only provider types are NOT written into the agent models.json.
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
	tmp = mkdtempSync(path.join(tmpdir(), "bobbit-custom-sync-"));
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

beforeEach(() => {
	const f = path.join(tmp, "models.json");
	if (existsSync(f)) rmSync(f);
	const prefsFile = path.join(stateDir, "preferences.json");
	if (existsSync(prefsFile)) rmSync(prefsFile);
});

const { syncCustomProvidersToAgent } = await import("../src/server/agent/custom-provider-agent-sync.ts");
const { PreferencesStore } = await import("../src/server/agent/preferences-store.ts");

function readModels(): any {
	const f = path.join(tmp, "models.json");
	if (!existsSync(f)) return null;
	return JSON.parse(readFileSync(f, "utf-8"));
}

function makePrefs(): any {
	return new PreferencesStore(stateDir);
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

describe("syncCustomProvidersToAgent — write/merge/delete", () => {
	it("writes a manual openai-completions provider as a marked managed block", async () => {
		const prefs = makePrefs();
		prefs.set("customProviders", [MANUAL_PROVIDER]);

		await syncCustomProvidersToAgent(prefs);

		const data = readModels();
		const block = data?.providers?.["llama-swap (z13)"];
		assert.ok(block, "provider keyed by config.name must exist");
		assert.equal(block.__bobbitManaged, "custom-provider");
		assert.equal(block.baseUrl, "http://maciekm-z13.local:9292/v1", "baseUrl gets /v1 (matches registry)");
		assert.equal(block.apiKey, "none", "apiKey defaults to the 'none' sentinel");
		assert.equal(block.api, "openai-completions");

		assert.equal(block.models.length, 3);
		const coder = block.models.find((m: any) => m.id === "qwen-coder-medium");
		assert.ok(coder);
		assert.equal(coder.name, "Qwen3-Coder 30B MoE");
		assert.equal(coder.contextWindow, 262144);
		assert.equal(coder.maxTokens, 4096, "manual maxTokens default flows through");
		assert.equal(coder.reasoning, false);
		assert.deepEqual(coder.input, ["text"]);
		assert.deepEqual(coder.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		// openai-completions → conservative compat block so local servers don't choke.
		assert.deepEqual(coder.compat, {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsUsageInStreaming: false,
			supportsReasoningEffort: false,
			supportsStrictMode: false,
			maxTokensField: "max_tokens",
		});
	});

	it("uses the trimmed apiKey when present", async () => {
		const prefs = makePrefs();
		prefs.set("customProviders", [{ ...MANUAL_PROVIDER, apiKey: "  sk-local-123  " }]);

		await syncCustomProvidersToAgent(prefs);

		const block = readModels()?.providers?.["llama-swap (z13)"];
		assert.equal(block.apiKey, "sk-local-123");
	});

	it("preserves non-managed entries (aigw + amazon-bedrock.modelOverrides)", async () => {
		// Pre-seed models.json with entries we must NOT clobber.
		const sentinel = {
			providers: {
				aigw: {
					baseUrl: "http://127.0.0.1:1111/v1",
					apiKey: "none",
					api: "openai-completions",
					models: [{ id: "gpt-x", name: "GPT X" }],
				},
				"amazon-bedrock": {
					modelOverrides: { "us.anthropic.claude-sonnet-4-6": { contextWindow: 1000000 } },
				},
			},
		};
		writeFileSync(path.join(tmp, "models.json"), JSON.stringify(sentinel, null, 2));

		const prefs = makePrefs();
		prefs.set("customProviders", [MANUAL_PROVIDER]);
		await syncCustomProvidersToAgent(prefs);

		const data = readModels();
		assert.deepEqual(data.providers.aigw, sentinel.providers.aigw, "aigw block untouched");
		assert.deepEqual(
			data.providers["amazon-bedrock"],
			sentinel.providers["amazon-bedrock"],
			"amazon-bedrock modelOverrides untouched",
		);
		assert.ok(data.providers["llama-swap (z13)"], "custom provider added alongside");
	});

	it("delete: removes only the custom block, preserving aigw/bedrock", async () => {
		const sentinel = {
			providers: {
				aigw: { baseUrl: "http://127.0.0.1:1111/v1", apiKey: "none", api: "openai-completions", models: [] },
				"amazon-bedrock": { modelOverrides: { "x": { contextWindow: 1 } } },
			},
		};
		writeFileSync(path.join(tmp, "models.json"), JSON.stringify(sentinel, null, 2));

		const prefs = makePrefs();
		prefs.set("customProviders", [MANUAL_PROVIDER]);
		await syncCustomProvidersToAgent(prefs);
		assert.ok(readModels().providers["llama-swap (z13)"], "block present after add");

		// Now delete the provider from config and re-sync.
		prefs.set("customProviders", []);
		await syncCustomProvidersToAgent(prefs);

		const data = readModels();
		assert.equal(data.providers["llama-swap (z13)"], undefined, "custom block removed");
		assert.ok(data.providers.aigw, "aigw preserved");
		assert.ok(data.providers["amazon-bedrock"], "bedrock preserved");
	});

	it("rename: moves the provider key (old gone, new present)", async () => {
		const prefs = makePrefs();
		prefs.set("customProviders", [MANUAL_PROVIDER]);
		await syncCustomProvidersToAgent(prefs);
		assert.ok(readModels().providers["llama-swap (z13)"], "original key present");

		// Rename — same id, new display name → new provider key.
		prefs.set("customProviders", [{ ...MANUAL_PROVIDER, name: "llama-swap (renamed)" }]);
		await syncCustomProvidersToAgent(prefs);

		const data = readModels();
		assert.equal(data.providers["llama-swap (z13)"], undefined, "old key removed on rename");
		assert.ok(data.providers["llama-swap (renamed)"], "new key present after rename");
	});

	it("unreachable auto-discovery provider keeps its prior managed block", async () => {
		// Pre-seed a managed block for an ollama provider (auto-discovery type).
		const priorBlock = {
			__bobbitManaged: "custom-provider",
			baseUrl: "http://127.0.0.1:1/v1",
			apiKey: "none",
			api: "openai-completions",
			models: [{ id: "prior-model", name: "Prior Model", contextWindow: 8192, maxTokens: 4096, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		};
		const sentinel = { providers: { "local-ollama": priorBlock } };
		writeFileSync(path.join(tmp, "models.json"), JSON.stringify(sentinel, null, 2));

		const prefs = makePrefs();
		// Port 1 reliably refuses connections → discovery returns [] (unreachable).
		prefs.set("customProviders", [
			{ id: "local-ollama", name: "local-ollama", type: "ollama", baseUrl: "http://127.0.0.1:1" },
		]);

		const warnings: string[] = [];
		const origWarn = console.warn;
		console.warn = (...args: any[]) => { warnings.push(args.join(" ")); };
		try {
			await syncCustomProvidersToAgent(prefs);
		} finally {
			console.warn = origWarn;
		}

		const data = readModels();
		assert.deepEqual(
			data.providers["local-ollama"],
			priorBlock,
			"prior managed block preserved when host unreachable",
		);
		assert.ok(
			warnings.some((w) => w.includes("local-ollama") && w.includes("unreachable")),
			`expected unreachable warning, got: ${warnings.join(" | ")}`,
		);
	});

	it("vision model round-trips input:['text','image'] into the synced block", async () => {
		const prefs = makePrefs();
		prefs.set("customProviders", [MANUAL_PROVIDER]);
		await syncCustomProvidersToAgent(prefs);

		const block = readModels().providers["llama-swap (z13)"];
		const vision = block.models.find((m: any) => m.id === "gemma-vision-large");
		assert.ok(vision, "vision model present in synced block");
		assert.ok(vision.input.includes("image"), "vision model input must include 'image'");
	});

	it("openai-responses / anthropic-messages providers carry the right api and no compat", async () => {
		const prefs = makePrefs();
		prefs.set("customProviders", [
			{ id: "resp", name: "resp", type: "openai-responses", baseUrl: "http://h1", models: [{ id: "m1", name: "M1" }] },
			{ id: "anth", name: "anth", type: "anthropic-messages", baseUrl: "http://h2", models: [{ id: "m2", name: "M2" }] },
		]);
		await syncCustomProvidersToAgent(prefs);

		const data = readModels();
		assert.equal(data.providers["resp"].api, "openai-responses");
		assert.equal(data.providers["resp"].models[0].compat, undefined, "non-openai-completions → no compat");
		assert.equal(data.providers["anth"].api, "anthropic-messages");
		assert.equal(data.providers["anth"].models[0].compat, undefined);
	});

	it("image-only provider types are not written into the agent models.json", async () => {
		const prefs = makePrefs();
		prefs.set("customProviders", [
			{ id: "img", name: "img-provider", type: "openai-images", baseUrl: "http://images" },
		]);
		await syncCustomProvidersToAgent(prefs);

		const data = readModels();
		assert.equal(data?.providers?.["img-provider"], undefined, "image-only provider must not be synced");
	});
});
