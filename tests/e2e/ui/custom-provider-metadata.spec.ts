/**
 * Browser E2E — manual custom provider with per-model metadata.
 *
 * Seeds a manual (`openai-completions`) custom provider via the REST API with
 * models carrying explicit contextWindow / reasoning / vision metadata (no live
 * host — manual models are never fetched). Then proves, through the real model
 * selector UI, that:
 *   - the seeded models appear with the correct context window text,
 *   - capability filters (Thinking / Vision) classify them correctly,
 *   - a metadata-less model falls back to the 8K default,
 *   - everything survives a full page reload.
 *
 * See docs/llama-swap-provider.md.
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch } from "../e2e-setup.js";
import { openApp, navigateToHash } from "./ui-helpers.js";

type BrowserPage = Parameters<typeof openApp>[0];

const PROVIDER_ID = "e2e-llama-swap-meta";
const PROVIDER_NAME = "E2E llama-swap meta";

const VISION_ID = "e2e-vision-xl"; // 262144 ctx, vision, no reasoning
const THINK_ID = "e2e-think-lg"; // 131072 ctx, reasoning, no vision
const BARE_ID = "e2e-bare"; // no metadata → defaults (8192)

async function seedProvider(): Promise<void> {
	const resp = await apiFetch("/api/custom-providers", {
		method: "POST",
		body: JSON.stringify({
			id: PROVIDER_ID,
			name: PROVIDER_NAME,
			type: "openai-completions",
			baseUrl: "http://e2e-llama-swap.invalid:9292",
			models: [
				{ id: VISION_ID, name: "E2E Vision XL", contextWindow: 262144, reasoning: false, input: ["text", "image"] },
				{ id: THINK_ID, name: "E2E Think LG", contextWindow: 131072, reasoning: true, input: ["text"] },
				{ id: BARE_ID, name: "E2E Bare" },
			],
		}),
	});
	expect(resp.ok, `seed provider failed: ${resp.status}`).toBe(true);
}

async function deleteProvider(): Promise<void> {
	await apiFetch(`/api/custom-providers/${PROVIDER_ID}`, { method: "DELETE" }).catch(() => {});
}

/** Open the Session model picker from the system Settings → Models tab. */
async function openModelSelector(page: BrowserPage): Promise<void> {
	await navigateToHash(page, `#/settings/system/models`);
	const pickerBtn = page
		.locator("[data-testid='model-row'][data-row-label='Session'] button[title='Choose model']");
	await expect(pickerBtn).toBeVisible({ timeout: 10_000 });
	await pickerBtn.click();
	// Wait for the selector dialog + its model list to populate.
	const search = page.locator("agent-model-selector input[placeholder='Search models...']");
	await expect(search).toBeVisible({ timeout: 10_000 });
	await search.fill("e2e");
	await expect(page.locator(`agent-model-selector [data-model-item][data-model-id='${VISION_ID}']`))
		.toBeVisible({ timeout: 10_000 });
}

function row(page: BrowserPage, id: string) {
	return page.locator(`agent-model-selector [data-model-item][data-model-id='${id}']`);
}

test.describe("custom provider per-model metadata", () => {
	test.beforeAll(async () => {
		await seedProvider();
	});
	test.afterAll(async () => {
		await deleteProvider();
	});

	test("seeded models show correct context window + capabilities and survive reload", async ({ page }) => {
		await openApp(page);
		await openModelSelector(page);

		// ── Context window text (formatTokens: 262144 → "262K", 131072 → "131K", 8192 → "8K") ──
		await expect(row(page, VISION_ID)).toContainText("262K");
		await expect(row(page, THINK_ID)).toContainText("131K");
		await expect(row(page, BARE_ID)).toContainText("8K"); // metadata-less → default 8192

		// ── Vision filter: only the vision model remains ──
		await page.locator("agent-model-selector button", { hasText: "Vision" }).click();
		await expect(row(page, VISION_ID)).toBeVisible();
		await expect(row(page, THINK_ID)).toHaveCount(0);
		await expect(row(page, BARE_ID)).toHaveCount(0);
		// turn Vision filter back off
		await page.locator("agent-model-selector button", { hasText: "Vision" }).click();

		// ── Thinking filter: only the reasoning model remains ──
		await page.locator("agent-model-selector button", { hasText: "Thinking" }).click();
		await expect(row(page, THINK_ID)).toBeVisible();
		await expect(row(page, VISION_ID)).toHaveCount(0);
		await expect(row(page, BARE_ID)).toHaveCount(0);

		// ── Persistence across reload ──
		await page.reload();
		await openModelSelector(page);
		await expect(row(page, VISION_ID)).toContainText("262K");
		await expect(row(page, THINK_ID)).toContainText("131K");
	});
});
