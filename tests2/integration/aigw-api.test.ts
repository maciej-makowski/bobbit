/**
 * E2E tests for the AI Gateway (aigw) REST API.
 *
 * These test the server-side /api/aigw/* endpoints including
 * configure, status, test, and proxy routes.
 */

import { test, expect } from "./_e2e/in-process-harness.js";
import { apiFetch } from "./_e2e/e2e-setup.js";

test.describe("AI Gateway API", () => {
	// Clean up after each test
	test.afterEach(async () => {
		await apiFetch("/api/aigw/configure", { method: "DELETE" });
	});

	test("GET /api/aigw/status returns unconfigured by default", async () => {
		const res = await apiFetch("/api/aigw/status");
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.configured).toBe(false);
	});

	test("POST /api/aigw/configure rejects missing url", async () => {
		const res = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("POST /api/aigw/configure accepts an unreachable gateway leniently; reachability is surfaced by /api/aigw/test", async () => {
		// Multi-gateway contract (docs/design/multi-gateway-providers.md §REST shims):
		// configure now upserts a {name:"aigw",type:"aigw"} gateway and re-syncs via
		// syncGatewaysModelsJson, returning {ok:true, models}. An unreachable gateway is
		// NOT rejected here — sync preserves the "unreachable ⇒ don't fail, keep/empty
		// models" behavior — so a fresh configure returns an empty model list, not 502.
		const url = "http://127.0.0.1:19999";
		const res = await apiFetch("/api/aigw/configure", {
			method: "POST",
			body: JSON.stringify({ url }),
		});
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.ok).toBe(true);
		expect(Array.isArray(data.models)).toBe(true);
		expect(data.models.length).toBe(0);

		// The reachability guarantee the old configure enforced now lives on the
		// pre-flight /api/aigw/test shim, which still rejects an unreachable gateway
		// with 502 + a truthy error — the assertion's original intent is preserved here.
		const testRes = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url }),
		});
		expect(testRes.status).toBe(502);
		const testData = await testRes.json();
		expect(testData.error).toBeTruthy();
	});

	test("POST /api/aigw/test rejects missing url", async () => {
		const res = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});

	test("POST /api/aigw/test rejects unreachable gateway", async () => {
		const res = await apiFetch("/api/aigw/test", {
			method: "POST",
			body: JSON.stringify({ url: "http://127.0.0.1:19999" }),
		});
		expect(res.status).toBe(502);
	});

	test("DELETE /api/aigw/configure succeeds even when not configured", async () => {
		const res = await apiFetch("/api/aigw/configure", { method: "DELETE" });
		expect(res.status).toBe(200);
		const data = await res.json();
		expect(data.ok).toBe(true);
	});

	test("proxy route returns 404-ish when not configured", async () => {
		// First make sure aigw is not configured
		await apiFetch("/api/aigw/configure", { method: "DELETE" });

		// The proxy route should not match when aigw is not configured,
		// so it falls through to the 404 handler
		const res = await apiFetch("/api/aigw/v1/models");
		// Should be 404 since the proxy route guard checks for aigw URL
		expect(res.status).toBeGreaterThanOrEqual(400);
	});
});
