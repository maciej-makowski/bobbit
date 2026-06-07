/**
 * Sync custom local providers into the interactive agent's `models.json`.
 *
 * Custom providers (ollama / lmstudio / llama.cpp / vllm and the manual
 * openai-completions / openai-responses / anthropic-messages types) surface in
 * the model picker via GET /api/models, but the pi-coding-agent subprocess
 * resolves a `(provider, modelId)` pair against pi-ai's built-in registry PLUS
 * `~/.bobbit/agent/models.json`. None of pi-ai's built-ins cover local
 * providers, so unless we register them in models.json the agent's strict
 * `set_model` lookup fails and the session silently stays on its prior model.
 *
 * This module mirrors `aigw-manager.writeAigwModelsJson()`: it writes a
 * `providers[<config.name || config.id>]` block whose key MUST equal the
 * `set_model` provider string the WS handler forwards verbatim, and whose
 * model list / baseUrl / api match exactly what /api/models produces (via the
 * shared `discoverModelsForConfig`). Managed entries are stamped with
 * `__bobbitManaged: "custom-provider"` so renames/deletes can be cleaned up
 * without ever clobbering the aigw entry or bedrock/anthropic modelOverrides.
 */

import { readModelsJson, writeModelsJson } from "./models-json-store.js";
import {
	discoverModelsForConfig,
	type ApiModel,
	type CustomProviderConfig,
} from "./model-registry.js";
import type { PreferencesStore } from "./preferences-store.js";

/** Stamped on every provider entry this module manages (written as `__bobbitManaged`). */
export const MANAGED_MARKER = "custom-provider";

/**
 * Conservative compat flags for the openai-completions provider in pi-ai.
 * Mirrors the non-Claude block in `aigw-manager.writeAigwModelsJson()`. Local
 * OpenAI-compatible servers (llama-swap, vllm, ollama, lmstudio, llama.cpp)
 * rarely implement the full OpenAI API surface, so disable the features that
 * commonly 400.
 */
const OPENAI_COMPLETIONS_COMPAT: Record<string, unknown> = {
	supportsDeveloperRole: false,
	supportsStore: false,
	supportsUsageInStreaming: false,
	supportsReasoningEffort: false,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
};

/** Provider types that auto-discover models over the network (may be unreachable). */
const AUTO_DISCOVERY_TYPES = new Set<CustomProviderConfig["type"]>([
	"ollama",
	"lmstudio",
	"llama.cpp",
	"vllm",
]);

/** Provider types that produce text models bindable by the interactive agent. */
const TEXT_PROVIDER_TYPES = new Set<CustomProviderConfig["type"]>([
	"ollama",
	"lmstudio",
	"llama.cpp",
	"vllm",
	"manual",
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
]);

interface ManagedModelEntry {
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	compat?: Record<string, unknown>;
}

export interface ManagedProviderEntry {
	baseUrl: string;
	apiKey: string;
	api: string;
	__bobbitManaged: typeof MANAGED_MARKER;
	models: ManagedModelEntry[];
}

/** The provider key the agent's `set_model` matches against (mirrors model-registry). */
export function providerKeyFor(config: CustomProviderConfig): string {
	return config.name || config.id;
}

/** Map a custom-provider type → models.json provider `api` string. */
export function apiForType(type: CustomProviderConfig["type"]): string {
	if (type === "openai-responses") return "openai-responses";
	if (type === "anthropic-messages") return "anthropic-messages";
	return "openai-completions";
}

/** True for provider types that produce agent-bindable text models. */
export function isTextProviderType(type: CustomProviderConfig["type"]): boolean {
	return TEXT_PROVIDER_TYPES.has(type);
}

function entryBaseUrl(config: CustomProviderConfig, models: ApiModel[]): string {
	// Derive from the discovered models' baseUrl so the agent hits the exact
	// same endpoint as /api/models (manual/ollama/lmstudio/llama.cpp/vllm all
	// produce the `<baseUrl>/v1` form). Fall back to the same transform.
	const fromModels = models.find((m) => typeof m.baseUrl === "string" && m.baseUrl)?.baseUrl;
	if (fromModels) return fromModels;
	return `${config.baseUrl.replace(/\/+$/, "")}/v1`;
}

/**
 * Build the models.json provider entry from a config and its discovered models.
 * Pure (no I/O) — exported so unit tests can assert the exact shape.
 */
export function buildCustomProviderEntry(config: CustomProviderConfig, models: ApiModel[]): ManagedProviderEntry {
	const api = apiForType(config.type);
	const applyCompat = api === "openai-completions";
	return {
		baseUrl: entryBaseUrl(config, models),
		apiKey: config.apiKey?.trim() || "none",
		api,
		__bobbitManaged: MANAGED_MARKER,
		models: models.map((m) => {
			const entry: ManagedModelEntry = {
				id: m.id,
				name: m.name,
				contextWindow: m.contextWindow,
				maxTokens: m.maxTokens,
				reasoning: m.reasoning,
				input: m.input,
				cost: m.cost,
			};
			if (applyCompat) {
				// Preserve any per-model compat the discovery already produced.
				entry.compat = { ...OPENAI_COMPLETIONS_COMPAT, ...((m.compat as Record<string, unknown>) || {}) };
			}
			return entry;
		}),
	};
}

function isManaged(entry: unknown): boolean {
	return !!entry && typeof entry === "object" && (entry as any).__bobbitManaged === MANAGED_MARKER;
}

/**
 * Sync ONE custom provider into models.json (add/update).
 *
 * Discovers the model list via `discoverModelsForConfig` (the same source
 * /api/models uses). For auto-discovery types that are unreachable the list
 * comes back empty; in that case we KEEP any prior managed entry rather than
 * wiping a working configuration, and log a warning. Manual providers never
 * fetch, so they sync deterministically (even to an empty list).
 */
export async function syncCustomProviderToModelsJson(config: CustomProviderConfig): Promise<void> {
	if (!isTextProviderType(config.type)) return; // image-only providers aren't agent-bindable
	const key = providerKeyFor(config);
	let models: ApiModel[] = [];
	try {
		models = await discoverModelsForConfig(config);
	} catch (err) {
		console.warn(`[custom-provider-sync] discovery failed for ${key}:`, err);
		models = [];
	}

	const data = readModelsJson();
	if (!data.providers) data.providers = {};

	if (models.length === 0 && AUTO_DISCOVERY_TYPES.has(config.type) && isManaged(data.providers[key])) {
		console.warn(
			`[custom-provider-sync] ${key} (${config.type}) returned no models (host unreachable?); keeping prior models.json entry`,
		);
		return;
	}

	data.providers[key] = buildCustomProviderEntry(config, models);
	writeModelsJson(data);
	console.log(`[custom-provider-sync] synced provider "${key}" with ${models.length} model(s)`);
}

/**
 * Sync ALL configured custom providers into models.json, then prune stale
 * managed entries (handles deletes/renames). Used at startup and after any
 * mutation. Resilient — never throws.
 */
export async function syncAllCustomProvidersToModelsJson(prefs: PreferencesStore): Promise<void> {
	const configs = (prefs.get("customProviders") as CustomProviderConfig[] | undefined) || [];
	for (const config of configs) {
		try {
			await syncCustomProviderToModelsJson(config);
		} catch (err) {
			console.warn(`[custom-provider-sync] failed to sync ${providerKeyFor(config)}:`, err);
		}
	}
	pruneStaleCustomProviders(prefs);
}

/**
 * Remove ONE managed provider entry by key (config.name || config.id).
 * Only deletes entries stamped with the managed marker, so it can never
 * clobber the aigw entry or built-in modelOverrides.
 */
export function removeCustomProviderFromModelsJson(providerKey: string): void {
	const data = readModelsJson();
	if (!data.providers) return;
	if (isManaged(data.providers[providerKey])) {
		delete data.providers[providerKey];
		writeModelsJson(data);
		console.log(`[custom-provider-sync] removed provider "${providerKey}"`);
	}
}

/**
 * Drop managed entries whose key is no longer in the current config set.
 * Handles deletes and renames (an updated provider with a new name leaves the
 * old key orphaned). Only ever removes entries carrying the managed marker.
 */
export function pruneStaleCustomProviders(prefs: PreferencesStore): void {
	const configs = (prefs.get("customProviders") as CustomProviderConfig[] | undefined) || [];
	const liveKeys = new Set(
		configs.filter((c) => isTextProviderType(c.type)).map((c) => providerKeyFor(c)),
	);

	const data = readModelsJson();
	if (!data.providers) return;

	let changed = false;
	for (const key of Object.keys(data.providers)) {
		if (isManaged(data.providers[key]) && !liveKeys.has(key)) {
			delete data.providers[key];
			changed = true;
			console.log(`[custom-provider-sync] pruned stale provider "${key}"`);
		}
	}
	if (changed) writeModelsJson(data);
}
