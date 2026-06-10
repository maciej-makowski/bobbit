/**
 * Browser E2E for the Container Runtime selector in
 * Project Settings → Sandbox (src/app/settings-page.ts::renderSandboxSection).
 *
 * Flow (pattern mirrors per-project-native-yaml-fields.spec.ts):
 *   1. Register a temp project with no `sandbox_runtime`.
 *   2. Open Settings → General; enable Sandbox Mode = docker so the runtime
 *      select is interactive; assert the Container Runtime select defaults to
 *      "docker".
 *   3. Select "podman", Save, assert the PUT /api/projects/:id/config body
 *      carries `sandbox_runtime: "podman"`.
 *   4. Reload; assert the select still shows "podman" and `project.yaml`
 *      on disk holds native `sandbox_runtime: podman` (persistence).
 *   5. Switch back to "docker", Save, reload, assert "docker" (undo path).
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

function readProjectYaml(rootPath: string): string {
	return readFileSync(join(rootPath, ".bobbit", "config", "project.yaml"), "utf-8");
}

/** Anchor selects by their preceding label span — both sandbox selects share a class. */
function modeSelect(page: Page) {
	return page.locator("xpath=//span[normalize-space()='Sandbox Mode']/following-sibling::select[1]");
}
function runtimeSelect(page: Page) {
	return page.locator("xpath=//span[normalize-space()='Container Runtime']/following-sibling::select[1]");
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

test.describe("Container Runtime selector", () => {
	test("defaults to docker, persists podman across reload, and reverts", async ({ page }) => {
		const { id, rootPath, cleanup } = await registerProject(`e2e-runtime-${Date.now()}`);
		try {
			await openApp(page, `/settings/${id}/general`);

			// The Container Runtime control lives in the Sandbox section.
			await expect(page.getByText("Container Runtime", { exact: true })).toBeVisible({ timeout: 15_000 });

			// New project has no sandbox_runtime → the select defaults to docker
			// even while disabled (Sandbox Mode is "none").
			await expect(runtimeSelect(page)).toHaveValue("docker");

			// Enable Sandbox Mode so the runtime select becomes interactive.
			await modeSelect(page).selectOption("docker");
			await expect(runtimeSelect(page)).toBeEnabled();
			await expect(runtimeSelect(page)).toHaveValue("docker");

			// Select Podman and Save; assert the PUT body carries the change.
			await runtimeSelect(page).selectOption("podman");
			const body1 = await saveAndCapture(page, id);
			expect(body1.sandbox_runtime).toBe("podman");

			// Reload → persistence across reload.
			await page.reload();
			await expect(
				page.getByRole("button", { name: "Settings", exact: true }),
			).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText("Container Runtime", { exact: true })).toBeVisible({ timeout: 15_000 });
			await expect(runtimeSelect(page)).toHaveValue("podman");

			// On-disk YAML uses native form for the new field.
			const yamlText = readProjectYaml(rootPath);
			expect(yamlText).toMatch(/sandbox_runtime:\s*podman/);

			// Undo path: switch back to Docker, Save, reload, confirm docker.
			await runtimeSelect(page).selectOption("docker");
			const body2 = await saveAndCapture(page, id);
			expect(body2.sandbox_runtime).toBe("docker");

			await page.reload();
			await expect(
				page.getByRole("button", { name: "Settings", exact: true }),
			).toBeVisible({ timeout: 15_000 });
			await expect(page.getByText("Container Runtime", { exact: true })).toBeVisible({ timeout: 15_000 });
			await expect(runtimeSelect(page)).toHaveValue("docker");
			expect(readProjectYaml(rootPath)).toMatch(/sandbox_runtime:\s*docker/);
		} finally {
			cleanup();
		}
	});
});
