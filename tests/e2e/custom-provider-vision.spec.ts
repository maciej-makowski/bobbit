/**
 * API E2E — a vision-capable custom (manual `openai-completions`) provider
 * model round-trips its `input: ["text","image"]` capability through the REST
 * surface that powers the model picker.
 *
 * This is the API-level half of the vision requirement (browser selectability +
 * the Vision capability filter are covered by
 * tests/e2e/ui/custom-provider-metadata.spec.ts). Here we pin the contract that
 * a seeded vision model is:
 *   - surfaced by GET /api/models under `provider = config.name`,
 *   - carries `input` including `"image"` verbatim (so the picker's Vision
 *     indicator/filter and the agent's image-part dispatch both see it),
 *   - while a sibling text-only model on the same provider does NOT gain
 *     `"image"`.
 *
 * No live host — manual models are never fetched.
 */
import { test, expect } from "./in-process-harness.js";
import { apiFetch } from "./e2e-setup.js";

test.setTimeout(20_000);

const PROVIDER_ID = "e2e-vision-roundtrip";
const PROVIDER_NAME = "E2E Vision Roundtrip";
const VISION_MODEL = "e2e-gemma-vision";
const TEXT_MODEL = "e2e-text-only";

async function seedProvider(): Promise<void> {
	const resp = await apiFetch("/api/custom-providers", {
		method: "POST",
		body: JSON.stringify({
			id: PROVIDER_ID,
			name: PROVIDER_NAME,
			type: "openai-completions",
			baseUrl: "http://e2e-vision.invalid:9292",
			models: [
				{ id: VISION_MODEL, name: "E2E Gemma Vision", contextWindow: 131072, reasoning: false, input: ["text", "image"] },
				{ id: TEXT_MODEL, name: "E2E Text Only", contextWindow: 32768, reasoning: false, input: ["text"] },
			],
		}),
	});
	expect(resp.ok, `seed provider failed: ${resp.status}`).toBe(true);
}

async function deleteProvider(): Promise<void> {
	await apiFetch(`/api/custom-providers/${PROVIDER_ID}`, { method: "DELETE" }).catch(() => {});
}

test.describe("custom provider vision capability round-trip", () => {
	test("vision model surfaces input:[text,image] via /api/models; text model does not", async () => {
		await seedProvider();
		try {
			const res = await apiFetch("/api/models");
			expect(res.status).toBe(200);
			const models = await res.json();
			expect(Array.isArray(models)).toBe(true);

			const vision = models.find(
				(m: any) => m.provider === PROVIDER_NAME && m.id === VISION_MODEL,
			);
			expect(vision, "vision model must be surfaced by /api/models").toBeDefined();
			expect(Array.isArray(vision.input)).toBe(true);
			expect(vision.input).toContain("text");
			expect(vision.input).toContain("image");

			const textOnly = models.find(
				(m: any) => m.provider === PROVIDER_NAME && m.id === TEXT_MODEL,
			);
			expect(textOnly, "text-only model must be surfaced by /api/models").toBeDefined();
			expect(textOnly.input).toContain("text");
			expect(textOnly.input).not.toContain("image");
		} finally {
			await deleteProvider();
		}
	});
});
