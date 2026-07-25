/**
 * Journey: Multi-gateway list editor (Settings → Models tab) — v2 browser smoke
 *
 * Ported from the fork's tests/e2e/ui/multi-gateway-settings.spec.ts onto the
 * tests2 browser journey harness. Focused happy-path + persistence + cleanup:
 *   - open Settings → Models tab, add an `openai-compatible` gateway row, fill
 *     name / url / type, Save → the gateway lands in GET /api/aigw/gateways;
 *   - a full page reload restores the row from the server list (persistence);
 *   - adding + enabling an `aigw`-type row shows the exclusivity warning banner,
 *     which disappears when the row is disabled (purely client-side, pre-Save);
 *   - removing a row + Save drops its provider from /api/models (cleanup).
 *
 * Discovery runs server-side, so the stub gateway only needs to be reachable
 * from the in-process gateway (Node), not from the browser.
 */
import { test, expect, openApp, navigateToHash, apiFetch } from "../_helpers/journey-fixture.js";
import http from "node:http";

type Stub = { server: http.Server; url: string };

/** Start a tiny OpenAI-compatible stub serving GET /v1/models + a canned completion. */
async function startStub(modelIds: string[]): Promise<Stub> {
	const server = http.createServer((req, res) => {
		res.setHeader("Content-Type", "application/json");
		if (req.url?.endsWith("/v1/models")) {
			res.end(JSON.stringify({ data: modelIds.map((id) => ({ id, object: "model" })) }));
		} else {
			res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }] }));
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as { port: number }).port;
	return { server, url: `http://127.0.0.1:${port}` };
}

const MODELS_TAB = "#/settings/system/models";
const editor = "[data-testid='gateways-editor']";
const rowsSel = "[data-testid='gateway-row']";
const warning = "[data-testid='gateway-exclusivity-warning']";
const saveBtn = "[data-testid='gateways-save-btn']";

const LLAMA_MODEL = "qwen-coder-medium"; // only the llama-swap (openai-compatible) stub serves this

async function readModels(): Promise<Array<{ provider: string; id: string }>> {
	const res = await apiFetch("/api/models");
	expect(res.ok).toBe(true);
	return res.json();
}

async function resetGateways(): Promise<void> {
	await apiFetch("/api/aigw/gateways", {
		method: "PUT",
		body: JSON.stringify({ gateways: [] }),
	}).catch(() => {});
}

test.describe("Journey: Settings → Models → AI Gateways list editor", () => {
	test("add/save, persistence, exclusivity warning, removal cleanup", async ({ page }) => {
		test.setTimeout(120_000);

		const llama = await startStub([LLAMA_MODEL]);
		const aigw = await startStub(["gpt-aigw-only", "aws/us.anthropic.claude-sonnet-4-6"]);

		try {
			await resetGateways();
			await openApp(page);
			await navigateToHash(page, MODELS_TAB);
			await expect(page.locator(editor)).toBeVisible({ timeout: 15_000 });

			// ── Add an openai-compatible row (llama-swap) ──
			await page.locator("[data-testid='gateways-add-btn']").click();
			await expect(page.locator(rowsSel)).toHaveCount(1);
			const row0 = page.locator(rowsSel).nth(0);
			await row0.locator("[data-testid='gateway-name-input']").fill("llama-swap");
			await row0.locator("[data-testid='gateway-url-input']").fill(llama.url);
			// type defaults to openai-compatible.
			await expect(row0.locator("[data-testid='gateway-type-select']")).toHaveValue("openai-compatible");

			// ── Add an aigw row (must be named exactly "aigw") ──
			await page.locator("[data-testid='gateways-add-btn']").click();
			await expect(page.locator(rowsSel)).toHaveCount(2);
			const row1 = page.locator(rowsSel).nth(1);
			await row1.locator("[data-testid='gateway-name-input']").fill("aigw");
			await row1.locator("[data-testid='gateway-url-input']").fill(aigw.url);
			await row1.locator("[data-testid='gateway-type-select']").selectOption("aigw");

			// Enabling an aigw-type row (default enabled) → exclusivity warning shows.
			await expect(page.locator(warning)).toBeVisible();
			// Uncheck the aigw row → warning disappears (purely client-side, pre-Save).
			await row1.locator("[data-testid='gateway-enabled-checkbox']").uncheck();
			await expect(page.locator(warning)).toHaveCount(0);
			// Re-check → warning reappears.
			await row1.locator("[data-testid='gateway-enabled-checkbox']").check();
			await expect(page.locator(warning)).toBeVisible();

			// ── Save with the aigw row DISABLED (merged mode) ──
			await row1.locator("[data-testid='gateway-enabled-checkbox']").uncheck();
			await expect(page.locator(warning)).toHaveCount(0);
			await page.locator(saveBtn).click();
			await expect(page.locator(saveBtn)).toHaveText("Save", { timeout: 15_000 });
			await expect(page.locator("[data-testid='gateways-error']")).toHaveCount(0);

			// Server persisted both gateways.
			const listRes = await apiFetch("/api/aigw/gateways");
			expect(listRes.ok).toBe(true);
			const list = await listRes.json();
			expect(list.gateways.map((g: { name: string }) => g.name).sort()).toEqual(["aigw", "llama-swap"]);

			// /api/models (merged): llama-swap present, no aigw, built-ins present.
			let models = await readModels();
			expect(models.some((m) => m.provider === "llama-swap" && m.id === LLAMA_MODEL)).toBe(true);
			expect(models.some((m) => m.provider === "aigw")).toBe(false);
			expect(models.some((m) => m.provider !== "llama-swap")).toBe(true); // built-ins survive in merged mode

			// ── Persistence: full reload restores both rows + enabled state ──
			await page.reload();
			await navigateToHash(page, MODELS_TAB);
			await expect(page.locator(editor)).toBeVisible({ timeout: 15_000 });
			await expect(page.locator(rowsSel)).toHaveCount(2);
			// Order is preserved by the server list, so row0=llama-swap, row1=aigw.
			const llamaRow = page.locator(rowsSel).nth(0);
			const aigwRow = page.locator(rowsSel).nth(1);
			await expect(llamaRow.locator("[data-testid='gateway-name-input']")).toHaveValue("llama-swap");
			await expect(aigwRow.locator("[data-testid='gateway-name-input']")).toHaveValue("aigw");
			await expect(llamaRow.locator("[data-testid='gateway-enabled-checkbox']")).toBeChecked();
			await expect(aigwRow.locator("[data-testid='gateway-enabled-checkbox']")).not.toBeChecked();
			await expect(aigwRow.locator("[data-testid='gateway-type-select']")).toHaveValue("aigw");
			// aigw disabled after reload → no warning.
			await expect(page.locator(warning)).toHaveCount(0);

			// ── Removal cleanup ──
			// Remove the aigw row, then remove llama-swap + Save so the openai-compatible
			// provider's disappearance is observable in /api/models.
			await aigwRow.locator("[data-testid='gateway-remove-btn']").click();
			await expect(page.locator(rowsSel)).toHaveCount(1);
			await page.locator(rowsSel).nth(0).locator("[data-testid='gateway-remove-btn']").click();
			await expect(page.locator(rowsSel)).toHaveCount(0);
			await page.locator(saveBtn).click();
			await expect(page.locator(saveBtn)).toHaveText("Save", { timeout: 15_000 });
			await expect(page.locator("[data-testid='gateways-error']")).toHaveCount(0);

			models = await readModels();
			expect(models.some((m) => m.provider === "llama-swap")).toBe(false);
			expect(models.some((m) => m.provider === "aigw")).toBe(false);
		} finally {
			await resetGateways();
			await new Promise<void>((r) => llama.server.close(() => r()));
			await new Promise<void>((r) => aigw.server.close(() => r()));
		}
	});
});
