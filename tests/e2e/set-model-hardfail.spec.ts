/**
 * API E2E — `set_model` must hard-fail on an unresolvable model and must NEVER
 * silently fall back to (or leave the session bound to) a different model.
 *
 * Root cause this pins (goal: bind custom-provider models):
 *   - The agent's RPC `set_model` does a strict (provider, modelId) lookup and
 *     RESOLVES with `{ success: false, error }` (it does NOT throw) when the
 *     model can't be resolved.
 *   - The WS handler awaited `setModel()` and, because the promise resolved,
 *     proceeded to `persistSessionModel()` — silently persisting a model the
 *     agent never bound. Subsequent prompts then routed to the previously-bound
 *     model (e.g. Claude). The fix inspects the response `success` flag and
 *     surfaces `SET_MODEL_FAILED` without persisting.
 *
 * The in-process mock agent mirrors the real agent: it rejects any model id /
 * provider containing the `unresolvable` sentinel with `{ success: false }`.
 *
 * Pattern mirrors tests/e2e/set-image-model-ws.spec.ts and
 * tests/e2e/archived-footer-model.spec.ts.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch, connectWs, createSession } from "./e2e-setup.js";
import { pollUntil } from "./test-utils/cleanup.js";

test.setTimeout(20_000);

const VALID_PROVIDER = "anthropic";
const VALID_MODEL = "claude-sonnet-4-20250514"; // mock agent accepts this
const BAD_PROVIDER = "unresolvable-provider";
const BAD_MODEL = "unresolvable-local-model"; // mock agent rejects (success:false)

test.describe("WS set_model hard-fail (no silent fallback)", () => {
	test("unknown model fails loud and does NOT overwrite the bound model", async () => {
		const sessionId = await createSession();
		try {
			const ws = await connectWs(sessionId);
			try {
				// 1. Positive control — bind a model the agent accepts. This both
				//    proves the happy path still persists AND establishes a known
				//    persisted baseline we can assert was NOT clobbered.
				ws.send({ type: "set_model", provider: VALID_PROVIDER, modelId: VALID_MODEL });
				await pollUntil(
					async () => {
						const resp = await apiFetch(`/api/sessions/${sessionId}`);
						if (!resp.ok) return false;
						const data = await resp.json();
						return data.modelProvider === VALID_PROVIDER && data.modelId === VALID_MODEL;
					},
					{ timeoutMs: 5_000, intervalMs: 50, label: "valid model persisted" },
				);

				// 2. Attempt an unresolvable model. The agent returns success:false;
				//    the handler must surface SET_MODEL_FAILED and must NOT persist.
				const cursor = ws.messageCount();
				ws.send({ type: "set_model", provider: BAD_PROVIDER, modelId: BAD_MODEL });
				const errMsg = await ws.waitForFrom(
					cursor,
					(m: any) => m.type === "error" && m.code === "SET_MODEL_FAILED",
					5_000,
				);
				expect(errMsg).toBeDefined();
			} finally {
				ws.close();
			}

			// 3. The persisted model must be unchanged — still the valid model, not
			//    the bogus one, and definitely not silently swapped.
			const sessResp = await apiFetch(`/api/sessions/${sessionId}`);
			expect(sessResp.ok).toBe(true);
			const sess = await sessResp.json();
			expect(sess.modelProvider).toBe(VALID_PROVIDER);
			expect(sess.modelId).toBe(VALID_MODEL);
			expect(sess.modelId).not.toBe(BAD_MODEL);
			expect(sess.modelProvider).not.toBe(BAD_PROVIDER);
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});

	test("unknown model on a fresh session leaves it unbound (no silent fallback persist)", async () => {
		const sessionId = await createSession();
		try {
			const ws = await connectWs(sessionId);
			try {
				const cursor = ws.messageCount();
				ws.send({ type: "set_model", provider: BAD_PROVIDER, modelId: BAD_MODEL });
				await ws.waitForFrom(
					cursor,
					(m: any) => m.type === "error" && m.code === "SET_MODEL_FAILED",
					5_000,
				);
			} finally {
				ws.close();
			}

			// The failed bind must not have persisted the bogus model.
			const sessResp = await apiFetch(`/api/sessions/${sessionId}`);
			expect(sessResp.ok).toBe(true);
			const sess = await sessResp.json();
			expect(sess.modelId ?? null).not.toBe(BAD_MODEL);
			expect(sess.modelProvider ?? null).not.toBe(BAD_PROVIDER);
		} finally {
			await apiFetch(`/api/sessions/${sessionId}`, { method: "DELETE" }).catch(() => {});
		}
	});
});
