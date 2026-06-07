/**
 * Regression — image-bearing prompts are forwarded to the agent bridge for a
 * session bound to a custom (`openai-completions`) vision provider.
 *
 * Image dispatch is UNCONDITIONAL: SessionManager.enqueuePrompt → bridge.prompt()
 * forwards `images` verbatim regardless of which provider/model the session is
 * bound to (the agent decides per-model, from the model's `input` capability,
 * whether to actually send image parts to the upstream API). This test pins that
 * there is NO provider-conditional gating that drops images for custom local
 * providers — so once a vision-capable custom model is bound (and its synced
 * models.json entry preserves `input:["text","image"]`), an attached image
 * actually reaches the local model.
 *
 * Harness mirrors tests/image-only-prompt-dispatch.test.ts.
 */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "custom-vision-dispatch-test-"));
process.env.BOBBIT_DIR = tmpRoot;

const { SessionManager } = await import("../src/server/agent/session-manager.ts");
const { PromptQueue } = await import("../src/server/agent/prompt-queue.ts");
const { EventBuffer } = await import("../src/server/agent/event-buffer.ts");
const { registerRpcBridgeFactory } = await import("../src/server/agent/rpc-bridge.ts");

type RecordedPrompt = {
	text: string;
	images?: Array<{ type: "image"; data: string; mimeType: string }>;
};

// A small but realistic image payload (1x1 PNG-ish base64 — content is opaque
// to the dispatch path; we only assert it is forwarded byte-for-byte).
const VISION_IMAGE = {
	type: "image" as const,
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	mimeType: "image/png",
};

// Identity of a custom openai-completions vision provider/model the session is
// bound to. The dispatch path must not special-case it away.
const CUSTOM_VISION_PROVIDER = "my-llama-swap";
const CUSTOM_VISION_MODEL = "gemma-vision-27b";

const managers: any[] = [];
afterEach(() => {
	registerRpcBridgeFactory(null);
	while (managers.length > 0) {
		const m = managers.pop();
		if (m._statusHeartbeatTimer) clearInterval(m._statusHeartbeatTimer);
		m.sessions?.clear();
	}
});

function seedVisionBoundSession(): { manager: any; sessionId: string; recorded: RecordedPrompt[] } {
	const recorded: RecordedPrompt[] = [];

	const fakeBridge: any = {
		running: true,
		async start() {},
		async stop() {},
		prompt(text: string, images?: RecordedPrompt["images"]) {
			recorded.push({ text, images });
			return Promise.resolve({ success: true });
		},
		steer() { return Promise.resolve({ success: true }); },
		abort() { return Promise.resolve({ success: true }); },
		getState() { return Promise.resolve({ success: true }); },
		getMessages() { return Promise.resolve({ success: true, data: { messages: [] } }); },
		setModel() { return Promise.resolve({ success: true }); },
		setThinkingLevel() { return Promise.resolve({ success: true }); },
		compact() { return Promise.resolve({ success: true }); },
		async waitForReady() {},
		sendCommand() { return Promise.resolve({ success: true }); },
		onEvent() { return () => {}; },
	};
	registerRpcBridgeFactory(() => fakeBridge);

	const manager: any = new SessionManager();
	// Session is "bound" to the custom vision provider/model — the dispatch path
	// must forward images regardless of this binding.
	manager._testStore = {
		update: () => {},
		get: () => ({ modelProvider: CUSTOM_VISION_PROVIDER, modelId: CUSTOM_VISION_MODEL }),
	};
	managers.push(manager);

	const sessionId = "s-custom-vision";
	const session: any = {
		id: sessionId,
		title: "Custom vision",
		titleGenerated: true,
		cwd: tmpRoot,
		status: "idle",
		statusVersion: 1,
		createdAt: Date.now(),
		lastActivity: Date.now(),
		clients: new Set(),
		promptQueue: new PromptQueue(),
		eventBuffer: new EventBuffer(),
		inFlightSteerTexts: [],
		unsubscribe: () => {},
		modelProvider: CUSTOM_VISION_PROVIDER,
		modelId: CUSTOM_VISION_MODEL,
		rpcClient: fakeBridge,
	};
	manager.sessions.set(sessionId, session);

	return { manager, sessionId, recorded };
}

describe("custom vision provider — image-input dispatch", () => {
	it("forwards image parts verbatim for a session bound to a custom openai-completions vision model", async () => {
		const { manager, sessionId, recorded } = seedVisionBoundSession();

		await manager.enqueuePrompt(sessionId, "What is in this picture?", { images: [VISION_IMAGE] });

		assert.equal(recorded.length, 1, "exactly one prompt should reach the agent bridge");
		const dispatched = recorded[0];
		assert.ok(
			Array.isArray(dispatched.images) && dispatched.images.length === 1,
			`image must be forwarded to the agent bridge for a custom vision provider, got ${JSON.stringify(dispatched.images)}`,
		);
		assert.equal(dispatched.images![0].mimeType, VISION_IMAGE.mimeType, "image mimeType must be preserved");
		assert.equal(dispatched.images![0].data, VISION_IMAGE.data, "image data must be forwarded byte-for-byte");
		assert.equal(dispatched.text, "What is in this picture?", "prompt text must be preserved alongside the image");
	});

	it("forwards the image even when the prompt body is empty (image-only) for a custom vision provider", async () => {
		const { manager, sessionId, recorded } = seedVisionBoundSession();

		await manager.enqueuePrompt(sessionId, "", { images: [VISION_IMAGE] });

		assert.equal(recorded.length, 1, "exactly one prompt should reach the agent bridge");
		const dispatched = recorded[0];
		assert.ok(
			Array.isArray(dispatched.images) && dispatched.images.length === 1,
			`image must be forwarded for an image-only prompt to a custom vision provider, got ${JSON.stringify(dispatched.images)}`,
		);
		assert.equal(dispatched.images![0].data, VISION_IMAGE.data, "image data must be forwarded byte-for-byte");
		// Synthesized non-blank text guards against the blank-ContentBlock API error.
		assert.notEqual(dispatched.text.trim(), "", "image-only prompt must dispatch non-blank text");
	});
});
