/**
 * Unit tests for the hard-fail set_model contract via bindModelWithReadback().
 *
 * The bug being fixed: when the agent can't resolve the requested model it
 * silently stays bound to the previously-bound model (Claude), and the gateway
 * swallows the failure — so the next prompt goes to the wrong model.
 *
 * bindModelWithReadback() is the single chokepoint the WS set_model handler now
 * routes through. It MUST:
 *  - throw when getState() read-back reports a DIFFERENT bound model,
 *  - throw when setModel() itself rejects (unknown model),
 *  - NOT persist the session model on failure,
 *  - persist exactly once on success.
 *
 * The WS handler calls updateModelNameFile() only AFTER a successful bind, so a
 * thrown bind also means the model-name file is never written. We replicate the
 * handler's try/catch ordering here to pin that no state mutation leaks out on
 * failure (no silent fallback, no prompt dispatched to a different model).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
	bindModelWithReadback,
	type ReviewModelRpc,
} from "../src/server/agent/review-model-override.ts";

interface Spy {
	persistCalls: Array<[string, string, string]>;
	modelNameCalls: Array<[string, string]>;
}

function makeSessionManager(): { sessionManager: any; spy: Spy } {
	const spy: Spy = { persistCalls: [], modelNameCalls: [] };
	const sessionManager = {
		persistSessionModel(sessionId: string, provider: string, modelId: string) {
			spy.persistCalls.push([sessionId, provider, modelId]);
		},
		updateModelNameFile(sessionId: string, modelId: string) {
			spy.modelNameCalls.push([sessionId, modelId]);
		},
	};
	return { sessionManager, spy };
}

/**
 * Replicate the WS set_model handler's exact ordering so we assert the full
 * observable effect, not just the helper in isolation.
 */
async function handleSetModel(
	rpc: ReviewModelRpc,
	sessionManager: any,
	sessionId: string,
	provider: string,
	modelId: string,
): Promise<{ failed: boolean; error?: string }> {
	try {
		await bindModelWithReadback(rpc, provider, modelId, {
			sessionManager,
			sessionId,
			contextLabel: "set_model",
		});
		sessionManager.updateModelNameFile(sessionId, modelId);
		return { failed: false };
	} catch (err: any) {
		return { failed: true, error: err?.message || String(err) };
	}
}

describe("set_model hard-fail — no silent fallback", () => {
	it("read-back mismatch (agent stays on previous model) → throws, nothing persisted", async () => {
		// setModel "succeeds" but the agent reports it is still bound to Claude.
		const rpc: ReviewModelRpc = {
			async setModel() { return undefined; },
			async getState() { return { model: { id: "claude-sonnet-4-6", provider: "anthropic" } }; },
		};
		const { sessionManager, spy } = makeSessionManager();

		const result = await handleSetModel(rpc, sessionManager, "sess-1", "llama-swap (z13)", "qwen-coder-medium");

		assert.equal(result.failed, true, "bind must fail on read-back mismatch");
		assert.match(result.error || "", /read-back mismatch|mismatch/i);
		assert.equal(spy.persistCalls.length, 0, "persistSessionModel must NOT be called on mismatch");
		assert.equal(spy.modelNameCalls.length, 0, "updateModelNameFile must NOT be called on mismatch");
	});

	it("unknown model (setModel rejects) → throws, nothing persisted", async () => {
		const rpc: ReviewModelRpc = {
			async setModel() { throw new Error("Model not found: bogus/unknown"); },
			async getState() { return { model: { id: "claude-sonnet-4-6", provider: "anthropic" } }; },
		};
		const { sessionManager, spy } = makeSessionManager();

		const result = await handleSetModel(rpc, sessionManager, "sess-2", "bogus", "unknown");

		assert.equal(result.failed, true, "bind must fail when setModel rejects");
		assert.match(result.error || "", /set.?model|model not found/i);
		assert.equal(spy.persistCalls.length, 0, "persistSessionModel must NOT be called");
		assert.equal(spy.modelNameCalls.length, 0, "updateModelNameFile must NOT be called");
	});

	it("happy path (read-back matches) → persists once, model-name file written", async () => {
		const rpc: ReviewModelRpc = {
			async setModel() { return undefined; },
			async getState() { return { model: { id: "qwen-coder-medium", provider: "llama-swap (z13)" } }; },
		};
		const { sessionManager, spy } = makeSessionManager();

		const result = await handleSetModel(rpc, sessionManager, "sess-3", "llama-swap (z13)", "qwen-coder-medium");

		assert.equal(result.failed, false, "bind must succeed when read-back matches");
		assert.deepEqual(spy.persistCalls, [["sess-3", "llama-swap (z13)", "qwen-coder-medium"]]);
		assert.deepEqual(spy.modelNameCalls, [["sess-3", "qwen-coder-medium"]]);
	});

	it("modelId containing '/' (lmstudio path) round-trips without being parsed as provider", async () => {
		const provider = "lmstudio-local";
		const modelId = "publisher/repo/model.gguf";
		const rpc: ReviewModelRpc = {
			async setModel() { return undefined; },
			async getState() { return { model: { id: modelId, provider } }; },
		};
		const { sessionManager, spy } = makeSessionManager();

		const result = await handleSetModel(rpc, sessionManager, "sess-4", provider, modelId);

		assert.equal(result.failed, false, "modelId with slashes must bind cleanly");
		assert.deepEqual(spy.persistCalls, [["sess-4", provider, modelId]]);
	});
});
