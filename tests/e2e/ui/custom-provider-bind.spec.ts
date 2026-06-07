/**
 * Browser E2E — binding a custom-provider model from the model picker.
 *
 * Seeds a manual (`openai-completions`) custom provider via the REST API (no
 * live host — manual models are never fetched), then drives the real model
 * selector to prove the "Bind custom-provider models" fix end-to-end:
 *   - the seeded custom models appear in the picker and are selectable,
 *   - selecting one binds it as the Session default model (NOT a silent Claude
 *     fallback) — the chosen custom model id is reflected in the model row,
 *   - the vision-capable custom model is classified as vision (survives the
 *     Vision capability filter; its image indicator keys off input:["…","image"]),
 *   - the binding persists across a full page reload.
 *
 * See docs/design (design-doc gate) and tests/e2e/ui/custom-provider-metadata.spec.ts.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

type BrowserPage = Parameters<typeof openApp>[0];

const PROVIDER_ID = "e2e-bind-llama-swap";
const PROVIDER_NAME = "E2E bind llama-swap";

const CODER_ID = "e2e-bind-coder"; // text-only
const VISION_ID = "e2e-bind-vision"; // vision-capable (input includes "image")

async function seedProvider(): Promise<void> {
	const resp = await apiFetch("/api/custom-providers", {
		method: "POST",
		body: JSON.stringify({
			id: PROVIDER_ID,
			name: PROVIDER_NAME,
			type: "openai-completions",
			baseUrl: "http://e2e-bind-llama-swap.invalid:9292",
			models: [
				{ id: CODER_ID, name: "E2E Bind Coder", contextWindow: 262144, reasoning: false, input: ["text"] },
				{ id: VISION_ID, name: "E2E Bind Vision", contextWindow: 131072, reasoning: false, input: ["text", "image"] },
			],
		}),
	});
	expect(resp.ok, `seed provider failed: ${resp.status}`).toBe(true);
}

async function deleteProvider(): Promise<void> {
	await apiFetch(`/api/custom-providers/${PROVIDER_ID}`, { method: "DELETE" }).catch(() => {});
}

/** Open the Session model picker from the system Settings → Models tab. */
async function openSessionPicker(page: BrowserPage): Promise<void> {
	await navigateToHash(page, `#/settings/system/models`);
	const pickerBtn = page
		.locator("[data-testid='model-row'][data-row-label='Session'] button[title='Choose model']");
	await expect(pickerBtn).toBeVisible({ timeout: 10_000 });
	await pickerBtn.click();
	const search = page.locator("agent-model-selector input[placeholder='Search models...']");
	await expect(search).toBeVisible({ timeout: 10_000 });
	await search.fill("e2e-bind");
	await expect(row(page, CODER_ID)).toBeVisible({ timeout: 10_000 });
}

function row(page: BrowserPage, id: string) {
	return page.locator(`agent-model-selector [data-model-item][data-model-id='${id}']`);
}

function sessionRowButton(page: BrowserPage) {
	return page.locator("[data-testid='model-row'][data-row-label='Session'] button[title='Choose model']");
}

test.describe("custom provider model binding", () => {
	test.beforeAll(async () => {
		await seedProvider();
	});
	test.afterAll(async () => {
		await deleteProvider();
	});

	test("seeded custom models are selectable, vision is classified, binding reflects + persists", async ({ page }) => {
		await openApp(page);
		await openSessionPicker(page);

		// ── Both seeded models appear and are selectable (their own provider group) ──
		await expect(row(page, CODER_ID)).toBeVisible();
		await expect(row(page, VISION_ID)).toBeVisible();
		// The provider badge proves the custom provider renders as itself (no fallback group).
		await expect(row(page, CODER_ID)).toContainText(PROVIDER_NAME);

		// ── Vision classification: the Vision filter keeps only the vision model ──
		await page.locator("agent-model-selector button", { hasText: "Vision" }).click();
		await expect(row(page, VISION_ID)).toBeVisible();
		await expect(row(page, CODER_ID)).toHaveCount(0);
		// Toggle Vision off again.
		await page.locator("agent-model-selector button", { hasText: "Vision" }).click();
		await expect(row(page, CODER_ID)).toBeVisible();

		// ── Select the coder model → it must bind as the Session model (no Claude fallback) ──
		await row(page, CODER_ID).click();
		await expect(page.locator("agent-model-selector")).toHaveCount(0, { timeout: 10_000 });
		await expect(sessionRowButton(page)).toContainText(CODER_ID, { timeout: 10_000 });
		// It must NOT have silently fallen back to a different (e.g. Claude) model.
		await expect(sessionRowButton(page)).not.toContainText("claude");

		// ── Persistence across a full reload ──
		await page.reload();
		await expect(sessionRowButton(page)).toContainText(CODER_ID, { timeout: 15_000 });

		// ── Re-open the picker and bind the vision model too (selectable end-to-end) ──
		await openSessionPicker(page);
		await row(page, VISION_ID).click();
		await expect(page.locator("agent-model-selector")).toHaveCount(0, { timeout: 10_000 });
		await expect(sessionRowButton(page)).toContainText(VISION_ID, { timeout: 10_000 });
	});
});
