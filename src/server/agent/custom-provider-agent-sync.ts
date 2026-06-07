/**
 * Custom-provider → agent models.json sync.
 *
 * The interactive agent (pi-coding-agent subprocess) resolves a model's
 * provider from pi-ai's built-in registry PLUS ~/.bobbit/agent/models.json.
 * pi-ai ships only cloud providers — there is no ollama/vllm/openai-compatible
 * built-in — so a custom local provider must be written into models.json for
 * `set_model(provider=<custom>, modelId=...)` to resolve. Without this, picking
 * a custom model silently falls back to the previously-bound model (Claude).
 *
 * This mirrors the aigw pattern (writeAigwModelsJson) but for ALL custom
 * provider types. We deliberately keep LOCAL copies of the models.json
 * read/merge/write helpers (atomic tmp+rename via globalAgentDir()) rather than
 * refactoring aigw-manager.ts / openai-model-additions.ts into a shared module
 * — that keeps the blast radius small and avoids touching the pinned aigw tests.
 *
 * Each managed provider block carries a `__bobbitManaged: "custom-provider"`
 * marker so renames/deletes can be cleaned without clobbering user, aigw, or
 * built-in (amazon-bedrock/anthropic modelOverrides) entries.
 */

import fs from "node:fs";
import path from "node:path";
import { globalAgentDir } from "../bobbit-dir.js";
import { discoverModelsForConfig, type ApiModel, type CustomProviderConfig } from "./model-registry.js";
import type { PreferencesStore } from "./preferences-store.js";

/** Marker on provider blocks that this module owns. */
const CUSTOM_MARKER = "custom-provider";

/**
 * Conservative compat flags for the openai-completions provider in pi-ai.
 * Gateway/local servers (e.g. llama-swap) often don't support the full OpenAI
 * API surface, so we disable features that cause errors. Mirrors the block
 * aigw-manager uses; duplicated intentionally (do not import a private symbol).
 */
const GATEWAY_COMPAT: Record<string, unknown> = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsUsageInStreaming: false,
	supportsReasoningEffort: false,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
};

/**
 * Custom provider types that are bindable by the interactive agent. Image-only
 * provider types (openai-images / gemini-images / google-imagen) are handled by
 * image-generation.ts and must NOT be written into the agent models.json.
 */
const AGENT_BINDABLE_TYPES = new Set<CustomProviderConfig["type"]>([
	"ollama",
	"lmstudio",
	"llama.cpp",
	"vllm",
	"manual",
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
]);

/** Provider key the agent + set_model use — MUST equal config.name || config.id. */
function providerKey(config: CustomProviderConfig): string {
	return config.name || config.id;
}

/** api string for the provider block, mirrors model-registry.manualApiForType. */
function apiForType(type: CustomProviderConfig["type"]): string {
	if (type === "openai-responses") return "openai-responses";
	if (type === "anthropic-messages") return "anthropic-messages";
	// ollama / lmstudio / llama.cpp / vllm / manual / openai-completions all
	// speak the OpenAI-compatible /v1 surface.
	return "openai-completions";
}

// ── models.json management (LOCAL copies — see module header) ───────

function getModelsJsonPath(): string {
	return path.join(globalAgentDir(), "models.json");
}

function readModelsJson(): Record<string, any> {
	const p = getModelsJsonPath();
	try {
		if (fs.existsSync(p)) {
			return JSON.parse(fs.readFileSync(p, "utf-8"));
		}
	} catch (err) {
		console.error("[custom-provider-sync] Failed to read models.json:", err);
	}
	return { providers: {} };
}

function writeModelsJson(data: Record<string, any>): void {
	const p = getModelsJsonPath();
	let tmp = "";
	try {
		const dir = path.dirname(p);
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		tmp = `${p}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
		fs.renameSync(tmp, p);
	} catch (err) {
		if (tmp) {
			try { fs.unlinkSync(tmp); } catch { /* best-effort */ }
		}
		console.error("[custom-provider-sync] Failed to write models.json:", err);
	}
}

/** Build the managed provider block for a config + its discovered models. */
function buildBlock(config: CustomProviderConfig, discovered: ApiModel[]): Record<string, unknown> {
	const api = apiForType(config.type);
	const addCompat = api === "openai-completions";
	return {
		__bobbitManaged: CUSTOM_MARKER,
		// SAME baseUrl that discoverModelsForConfig() puts on each ApiModel, so the
		// agent hits the exact endpoint /api/models reports.
		baseUrl: `${config.baseUrl}/v1`,
		apiKey: config.apiKey?.trim() || "none",
		api,
		models: discovered.map((m) => ({
			id: m.id,
			name: m.name,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			reasoning: m.reasoning,
			// PRESERVE ["text","image"] — required so pi-ai's openai-completions
			// client emits image content blocks for vision-capable custom models.
			input: m.input,
			cost: m.cost,
			...(addCompat ? { compat: GATEWAY_COMPAT } : {}),
		})),
	};
}

/**
 * Re-sync ALL custom providers into ~/.bobbit/agent/models.json.
 *
 * - Removes stale managed blocks (renames/deletes) carrying our marker whose
 *   key is no longer in the current config set.
 * - Upserts every configured (agent-bindable) provider.
 * - If discovery throws/returns empty AND a prior managed block exists (an
 *   unreachable auto-discovery host), KEEPS the prior block and logs a warning.
 * - PRESERVES all non-managed entries (aigw, amazon-bedrock/anthropic
 *   modelOverrides, openai additions).
 *
 * Never throws — callers (boot, REST handlers) treat failures as non-fatal.
 */
export async function syncCustomProvidersToAgent(prefs: PreferencesStore): Promise<void> {
	const data = readModelsJson();
	if (!data.providers || typeof data.providers !== "object") data.providers = {};

	const allConfigs = (prefs.get("customProviders") as CustomProviderConfig[] | undefined) || [];
	const configs = allConfigs.filter((c) => AGENT_BINDABLE_TYPES.has(c.type));
	const liveKeys = new Set(configs.map(providerKey));

	let changed = false;

	// 1. Remove stale managed entries (renames / deletes / type-changed-to-image).
	for (const key of Object.keys(data.providers)) {
		const block = data.providers[key];
		if (block && typeof block === "object" && block.__bobbitManaged === CUSTOM_MARKER && !liveKeys.has(key)) {
			delete data.providers[key];
			changed = true;
		}
	}

	// 2. Upsert each configured provider.
	for (const config of configs) {
		const key = providerKey(config);
		let discovered: ApiModel[] = [];
		try {
			discovered = await discoverModelsForConfig(config);
		} catch (err) {
			console.warn(`[custom-provider-sync] ${key} discovery failed: ${err instanceof Error ? err.message : String(err)}`);
			discovered = [];
		}

		const prior = data.providers[key];
		const priorIsManaged = prior && typeof prior === "object" && prior.__bobbitManaged === CUSTOM_MARKER;
		if (discovered.length === 0 && priorIsManaged) {
			// Unreachable auto-discovery host — keep the prior managed block rather
			// than wiping the agent's ability to bind these models. Never block boot.
			console.warn(`[custom-provider-sync] ${key} unreachable on sync, keeping prior models.json entry`);
			continue;
		}

		data.providers[key] = buildBlock(config, discovered);
		changed = true;
	}

	if (changed) {
		writeModelsJson(data);
		console.log(`[custom-provider-sync] synced ${configs.length} custom provider(s) into models.json`);
	}
}
