// v2-native — NEW coverage for the multi-gateway DNS-guard host union.
// Pins WHICH gateway types contribute cross-origin hosts to the connection-time
// DNS rebinding guard: only `aigw`-type blocks (which carry well-known-derived
// per-model baseUrls) do; plain `openai-compatible` blocks never do.

import { guardProcessEnv } from "./helpers/env-guard.js";
guardProcessEnv();

/**
 * `syncGatewaysModelsJson()` unions the admitted cross-origin hosts of every
 * managed `aigw`-type block and hands them to `replaceAigwProviderDnsGuardHosts`
 * (aigw-manager.ts §sync). This file pins that union:
 *
 *   - an `aigw` block whose authoritative model carries a cross-origin https
 *     `baseUrl` ⇒ that host is guarded;
 *   - a same-origin / http / IP-literal model `baseUrl` ⇒ NOT guarded;
 *   - an `openai-compatible` gateway (driven through the real
 *     saveGateways + syncGatewaysModelsJson path) ⇒ contributes NO guarded hosts.
 *
 * The cross-origin `aigw` positive is asserted through the REAL
 * `buildAigwProviderBlock` + `collectAigwProviderDnsHosts` +
 * `replaceAigwProviderDnsGuardHosts` union (identical to what the sync
 * orchestrator runs internally); a full `syncGatewaysModelsJson` well-known path
 * can't admit a cross-origin PUBLIC host deterministically offline (DNS
 * admission binds the real resolver at module load), so the union is exercised
 * directly here rather than mocked through the network.
 */
import { describe, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetAgentDirStateForTests } from "../../src/server/bobbit-dir.js";

import { PreferencesStore } from "../../src/server/agent/preferences-store.js";
import {
	buildAigwProviderBlock,
	collectAigwProviderDnsHosts,
	getAigwProviderDnsGuardHosts,
	replaceAigwProviderDnsGuardHosts,
	saveGateways,
	syncGatewaysModelsJson,
	type AigwModel,
} from "../../src/server/agent/aigw-manager.js";

let agentDir: string;

beforeAll(() => {
	agentDir = mkdtempSync(path.join(tmpdir(), "bobbit-mg-dnsguard-agent-"));
	process.env.BOBBIT_AGENT_DIR = agentDir;
});

afterAll(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

beforeEach(() => {
	process.env.BOBBIT_AGENT_DIR = agentDir;
	resetAgentDirStateForTests();
	const f = path.join(agentDir, "models.json");
	if (existsSync(f)) rmSync(f);
});

afterEach(() => {
	// Never leak guard hosts (or the installed dns.lookup wrapper's active set)
	// into the next test / file.
	replaceAigwProviderDnsGuardHosts([]);
});

function model(id: string, over: Partial<AigwModel> = {}): AigwModel {
	return {
		id,
		name: id,
		api: "openai-completions",
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...over,
	};
}

/** In-process openai-compatible stub: GET /v1/models → { data: [{id}] }. */
function startStub(ids: string[]): Promise<{ url: string; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		res.setHeader("Content-Type", "application/json");
		if (req.url?.endsWith("/v1/models")) {
			res.end(JSON.stringify({ data: ids.map(id => ({ id, object: "model" })) }));
		} else {
			res.statusCode = 404;
			res.end("{}");
		}
	});
	return new Promise(resolve => {
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as any).port;
			resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(r => server.close(() => r())) });
		});
	});
}

function newPrefs() {
	const dir = mkdtempSync(path.join(tmpdir(), "bobbit-mg-dnsguard-state-"));
	return new PreferencesStore(dir) as any;
}

/** Mirror syncGatewaysModelsJson's guard union (aigw-manager.ts §sync). */
function registerGuardHostsFor(blocks: any[]): void {
	const hosts = new Set<string>();
	for (const block of blocks) for (const host of collectAigwProviderDnsHosts(block)) hosts.add(host);
	replaceAigwProviderDnsGuardHosts([...hosts]);
}

describe("multi-gateway DNS-guard host union", () => {
	const aigwGw = { id: "1", name: "aigw", url: "http://gw/v1", type: "aigw" as const, enabled: true };

	it("an aigw block with a cross-origin https authoritative model contributes that host", () => {
		const block = buildAigwProviderBlock(aigwGw, [
			model("openai/gpt-5.6-sol", {
				name: "GPT 5.6 Sol",
				api: "openai-responses",
				baseUrl: "https://api.vendor.example/openai/v1",
				wireId: "gpt-5.6-sol",
				upstreamProvider: "openai",
				reasoning: true,
			}),
		]);

		registerGuardHostsFor([block]);
		assert.deepEqual(getAigwProviderDnsGuardHosts(), ["api.vendor.example"]);
	});

	it("same-origin / http / IP-literal model baseUrls are NOT guarded", () => {
		// baseUrl of the provider block itself is http://gw ; models below are
		// same-origin (http://gw/...), plain http cross-origin, or an IP literal.
		const block = buildAigwProviderBlock(aigwGw, [
			model("aws/us.anthropic.claude-sonnet-4-6", { reasoning: true }), // fallback ⇒ http://gw/aws (same origin)
			model("vendor/plain-http", { api: "openai-responses", baseUrl: "http://plain.vendor.example/v1", wireId: "plain-http" }),
			model("vendor/ip-literal", { api: "openai-responses", baseUrl: "https://203.0.113.7/v1", wireId: "ip-literal" }),
		]);

		registerGuardHostsFor([block]);
		assert.deepEqual(getAigwProviderDnsGuardHosts(), [], "only cross-origin https hostnames are guarded");
	});

	it("an openai-compatible gateway (real saveGateways + syncGatewaysModelsJson) contributes NO guarded hosts", async () => {
		const stub = await startStub(["qwen-coder-medium", "claude-local"]);
		try {
			replaceAigwProviderDnsGuardHosts(["stale.example"]); // prove the sync REPLACES, not merges
			const prefs = newPrefs();
			saveGateways(prefs, [{ id: "2", name: "llama-swap", url: stub.url, type: "openai-compatible", enabled: true }]);
			await syncGatewaysModelsJson(prefs);

			// Sanity: the block was written but under the gateway name, no aigw block.
			const data = JSON.parse(readFileSync(path.join(agentDir, "models.json"), "utf-8"));
			assert.ok(data.providers["llama-swap"], "openai-compatible block written");
			assert.equal(data.providers.aigw, undefined, "no aigw block");

			assert.deepEqual(getAigwProviderDnsGuardHosts(), [], "openai-compatible gateways never contribute guarded hosts");
		} finally {
			await stub.close();
		}
	});

	it("collectAigwProviderDnsHosts ignores a null/absent provider block", () => {
		assert.deepEqual(collectAigwProviderDnsHosts(undefined), []);
		assert.deepEqual(collectAigwProviderDnsHosts(null), []);
		assert.deepEqual(collectAigwProviderDnsHosts({ baseUrl: "http://gw/v1", models: [] }), []);
	});
});
