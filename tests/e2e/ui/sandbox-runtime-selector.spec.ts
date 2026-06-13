/**
 * Browser E2E for the single Sandbox Mode dropdown in
 * Project Settings → Container Sandbox (src/app/settings-page.ts::renderSandboxSection).
 *
 * Single-mode model: ONE `sandbox` select with options none/docker/podman.
 * There is no separate Container Runtime dropdown and no `sandbox_runtime` key.
 *
 * Flow (pattern mirrors per-project-native-yaml-fields.spec.ts):
 *   1. Register a temp project with no sandbox config.
 *   2. Open Settings → General; assert Sandbox Mode defaults to "none" and the
 *      Container Runtime dropdown no longer exists.
 *   3. Select "podman", Save, assert the PUT /api/projects/:id/config body
 *      carries `sandbox: "podman"` and NO `sandbox_runtime`.
 *   4. Reload; assert the select still shows "podman" and `project.yaml`
 *      on disk holds native `sandbox: podman` with no `sandbox_runtime`.
 *   5. Switch back to "none", Save, reload, assert "none" (undo path).
 *   6. Back-compat: seed a project.yaml with `sandbox: docker` + a stale
 *      `sandbox_runtime: podman`; the UI shows docker mode (stale key ignored).
 */
import { test, expect } from "../gateway-harness.js";
import { apiFetch, readE2EToken, base } from "../e2e-setup.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Page } from "@playwright/test";

async function registerProject(name: string): Promise<{ id: string; rootPath: string; cleanup: () => void }> {
	const rootPath = mkdtempSync(join(tmpdir(), "bobbit-e2e-runtime-"));
	const resp = await apiFetch("/api/projects", {
		method: "POST",
		body: JSON.stringify({ name, rootPath, upsert: true }),
	});
	expect([200, 201]).toContain(resp.status);
	const project = await resp.json();
	return {
		id: project.id,
		rootPath,
		cleanup: () => {
			apiFetch(`/api/projects/${project.id}`, { method: "DELETE" }).catch(() => {});
			try { rmSync(rootPath, { recursive: true, force: true }); } catch { /* ignore */ }
		},
	};
}

async function openApp(page: Page, hash?: string): Promise<void> {
	const token = readE2EToken();
	await page.goto(`${base()}/?token=${encodeURIComponent(token)}`);
	await expect(
		page.getByRole("button", { name: "Settings", exact: true }),
	).toBeVisible({ timeout: 15_000 });
	if (hash) {
		await page.evaluate((h) => { window.location.hash = h; }, hash);
	}
}

function projectYamlPath(rootPath: string): string {
	return join(rootPath, ".bobbit", "config", "project.yaml");
}
function readProjectYaml(rootPath: string): string {
	return readFileSync(projectYamlPath(rootPath), "utf-8");
}

/** The single Sandbox Mode select — anchored by its preceding label span. */
function modeSelect(page: Page) {
	return page.locator("xpath=//span[normalize-space()='Sandbox Mode']/following-sibling::select[1]");
}

/** Click Save and await the PUT /api/projects/:id/config; returns the parsed body. */
async function saveAndCapture(page: Page, id: string): Promise<Record<string, unknown>> {
	const saveBtn = page.getByRole("button", { name: "Save", exact: true });
	await expect(saveBtn).toBeVisible({ timeout: 5_000 });
	const putReq = page.waitForRequest(
		(r) => r.url().includes(`/api/projects/${id}/config`) && r.method() === "PUT",
		{ timeout: 15_000 },
	);
	const putResp = page.waitForResponse(
		(r) => r.url().includes(`/api/projects/${id}/config`) && r.request().method() === "PUT" && r.status() === 200,
		{ timeout: 15_000 },
	);
	await saveBtn.click();
	const req = await putReq;
	await putResp;
	return (req.postDataJSON() ?? {}) as Record<string, unknown>;
}

test.describe("Sandbox Mode selector (single-field)", () => {
	test("defaults to none, persists podman across reload, and reverts", async ({ page }) => {
		const { id, rootPath, cleanup } = await registerProject(`e2e-runtime-${Date.now()}`);
		try {
			await openApp(page, `/settings/${id}/general`);

			// The Sandbox Mode control lives in the Container Sandbox section.
			await expect(page.getByText("Sandbox Mode", { exact: true })).toBeVisible({ timeout: 15_000 });

			// The separate Container Runtime dropdown is GONE under single-mode.
			await expect(page.getByText("Container Runtime", { exact: true })).toHaveCount(0);

			// New project has no sandbox config → defaults to none.
			await expect(modeSelect(page)).toHaveValue("none");

			// Select Podman and Save; assert the PUT body carries sandbox: podman
			// and never a sandbox_runtime key.
			await modeSelect(page).selectOption("podman");
			const body1 = await saveAndCapture(page, id);
			expect(body1.sandbox).toBe("podman");
			expect(body1).not.toHaveProperty("sandbox_runtime");

			// Reload → persistence across reload.
			await page.reload();
			await expect(
				page.getByRole("button", { name: "Settings", exact: true }),
			).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText("Sandbox Mode", { exact: true })).toBeVisible({ timeout: 15_000 });
			await expect(modeSelect(page)).toHaveValue("podman");

			// On-disk YAML uses native form and carries no sandbox_runtime.
			const yamlText = readProjectYaml(rootPath);
			expect(yamlText).toMatch(/sandbox:\s*podman/);
			expect(yamlText).not.toMatch(/sandbox_runtime/);

			// Undo path: switch back to none, Save, reload, confirm none.
			await modeSelect(page).selectOption("none");
			const body2 = await saveAndCapture(page, id);
			expect(body2.sandbox).toBe("none");

			await page.reload();
			await expect(
				page.getByRole("button", { name: "Settings", exact: true }),
			).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText("Sandbox Mode", { exact: true })).toBeVisible({ timeout: 15_000 });
			await expect(modeSelect(page)).toHaveValue("none");
			expect(readProjectYaml(rootPath)).toMatch(/sandbox:\s*none/);
		} finally {
			cleanup();
		}
	});

	test("ignores a stale sandbox_runtime key (back-compat) — shows docker mode", async ({ page }) => {
		const { id, rootPath, cleanup } = await registerProject(`e2e-runtime-stale-${Date.now()}`);
		try {
			// Seed the OLD two-field combo via the config PUT so the in-memory store
			// (which the UI reads) holds both keys: sandbox: docker + a stale
			// sandbox_runtime: podman. The single-mode accessor must ignore the stale key.
			const putResp = await apiFetch(`/api/projects/${id}/config`, {
				method: "PUT",
				body: JSON.stringify({ sandbox: "docker", sandbox_runtime: "podman" }),
			});
			expect(putResp.status).toBe(200);
			// The stale key lands on disk verbatim — proving it is ignored, not stripped.
			expect(readProjectYaml(rootPath)).toMatch(/sandbox_runtime:\s*podman/);

			await openApp(page, `/settings/${id}/general`);
			await expect(page.getByText("Sandbox Mode", { exact: true })).toBeVisible({ timeout: 15_000 });

			// The UI reflects the `sandbox` mode (docker); the stale sandbox_runtime
			// is never consulted (no migration to podman).
			await expect(modeSelect(page)).toHaveValue("docker");
			await expect(page.getByText("Container Runtime", { exact: true })).toHaveCount(0);
		} finally {
			cleanup();
		}
	});
});
